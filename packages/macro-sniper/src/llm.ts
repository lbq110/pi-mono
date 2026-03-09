import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { getAnthropicToken } from "./anthropic-auth.js";
import { loadConfig } from "./config.js";
import { createChildLogger } from "./logger.js";
import { postToSlack } from "./notifications/slack.js";

const log = createChildLogger("reporter");

/**
 * Custom model definition for models not yet in pi-ai's registry.
 */
const CUSTOM_MODELS: Record<string, Model<Api>> = {
	"gemini-3.1-flash-lite-preview": {
		id: "gemini-3.1-flash-lite-preview",
		name: "Gemini 3.1 Flash-Lite Preview",
		api: "google-generative-ai" as Api,
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
};

/** Model ID -> { provider, modelId } lookup for models in pi-ai's registry. */
const REGISTRY_MODELS: Record<string, { provider: string; modelId: string }> = {
	"claude-opus-4-6": { provider: "anthropic", modelId: "claude-opus-4-6" },
	"claude-sonnet-4-6": { provider: "anthropic", modelId: "claude-sonnet-4-6" },
	"gemini-2.5-pro": { provider: "google", modelId: "gemini-2.5-pro" },
	"gemini-2.5-flash": { provider: "google", modelId: "gemini-2.5-flash" },
};

function resolveModel(modelName: string): Model<Api> | null {
	const custom = CUSTOM_MODELS[modelName];
	if (custom) return custom;

	const entry = REGISTRY_MODELS[modelName];
	if (!entry) {
		log.error({ modelName }, "Unknown model name, cannot resolve");
		return null;
	}
	const model = getModel(entry.provider as "anthropic", entry.modelId as "claude-sonnet-4-6");
	if (!model) {
		log.error({ modelName, provider: entry.provider, modelId: entry.modelId }, "Model not found in registry");
		return null;
	}
	return model as Model<Api>;
}

function getProviderForModel(modelName: string): string | null {
	if (CUSTOM_MODELS[modelName]) return CUSTOM_MODELS[modelName].provider;
	const entry = REGISTRY_MODELS[modelName];
	return entry?.provider ?? null;
}

/** Track whether we've already sent a Slack alert for token expiry in this session */
let tokenExpiryAlerted = false;

/**
 * Send a Slack alert about Anthropic token expiry.
 */
async function alertTokenExpiry(modelName: string, fallbackModel: string): Promise<void> {
	if (tokenExpiryAlerted) return;
	tokenExpiryAlerted = true;

	const config = loadConfig();
	if (!config.SLACK_BOT_TOKEN || !config.SLACK_CHANNEL_ID) return;

	const message = [
		"⚠️ *Macro Sniper: Anthropic OAuth Token 已过期*",
		"",
		`请求模型 \`${modelName}\` 失败，已自动切换到 \`${fallbackModel}\`。`,
		"",
		"请在服务器上运行 `pi` 登录刷新 token，或手动更新 `/root/.pi/agent/auth.json`。",
	].join("\n");

	try {
		await postToSlack(message, {
			botToken: config.SLACK_BOT_TOKEN,
			channelId: config.SLACK_CHANNEL_ID,
		});
		log.info("Token expiry alert sent to Slack");
	} catch (error) {
		log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to send token expiry alert");
	}
}

/**
 * Send a prompt to the LLM and return the generated text.
 *
 * For Anthropic models, automatically resolves OAuth token from pi's auth.json
 * and attempts refresh if expired. If refresh fails, falls back to the configured
 * fallback model and sends a Slack alert.
 */
export async function streamText(prompt: string, modelName: string): Promise<string> {
	const config = loadConfig();
	const modelsToTry = [modelName, config.LLM_FALLBACK_MODEL].filter(Boolean);
	let lastError: Error | null = null;

	for (const name of modelsToTry) {
		const model = resolveModel(name);
		if (!model) {
			log.warn({ model: name }, "Model not resolvable, trying next");
			continue;
		}

		// Resolve API key
		const apiKey = await resolveApiKey(name, config);
		if (apiKey === null) {
			log.warn({ model: name }, "No API key available, trying next");
			// If primary model (Anthropic) has no key, alert and skip
			if (name === modelName && getProviderForModel(name) === "anthropic") {
				const fallback = modelsToTry.find((m) => m !== name) ?? "gemini-3.1-flash-lite-preview";
				await alertTokenExpiry(name, fallback);
			}
			continue;
		}

		try {
			log.info({ model: name }, "Calling LLM");

			const result = await completeSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					temperature: config.LLM_TEMPERATURE,
					apiKey,
				},
			);

			const textParts = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text);

			const text = textParts.join("");

			if (!text) {
				log.warn({ model: name }, "LLM returned empty text");
				continue;
			}

			if (name !== modelName) {
				log.info({ primary: modelName, fallback: name }, "Used fallback model");
			}

			log.info({ model: name, length: text.length }, "LLM response received");
			return text;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			log.error({ model: name, error: lastError.message }, "LLM call failed, trying next");

			// If Anthropic call failed (likely auth), alert
			if (name === modelName && getProviderForModel(name) === "anthropic") {
				const fallback = modelsToTry.find((m) => m !== name) ?? "gemini-3.1-flash-lite-preview";
				await alertTokenExpiry(name, fallback);
			}
		}
	}

	throw lastError ?? new Error("All LLM models failed");
}

/**
 * Resolve API key for a model.
 *
 * For Anthropic: refreshes OAuth token from pi's auth.json if needed,
 * sets it as ANTHROPIC_OAUTH_TOKEN so pi-ai picks it up automatically
 * (which also enables Claude Code OAuth headers).
 * For Google: uses GEMINI_API_KEY from env.
 * Returns null if no key available.
 */
async function resolveApiKey(modelName: string, config: ReturnType<typeof loadConfig>): Promise<string | null> {
	const provider = getProviderForModel(modelName);
	if (!provider) return null;

	if (provider === "anthropic") {
		// Explicit API key takes priority
		if (config.ANTHROPIC_API_KEY) return config.ANTHROPIC_API_KEY;

		// OAuth token from pi's auth.json (auto-refreshed via pi-ai)
		const token = await getAnthropicToken();
		if (token) {
			// Set env var so pi-ai's getEnvApiKey picks it up and treats it as OAuth
			process.env.ANTHROPIC_OAUTH_TOKEN = token;
			return token;
		}
		return null;
	}

	if (provider === "google") {
		return config.GEMINI_API_KEY ?? null;
	}

	return null;
}
