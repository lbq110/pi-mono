import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { loadConfig } from "./config.js";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("reporter");

/**
 * Custom model definition for models not yet in pi-ai's registry.
 * Follows the same structure as models.generated.ts.
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

/** Model ID → { provider, modelId } lookup for models in pi-ai's registry. */
const REGISTRY_MODELS: Record<string, { provider: string; modelId: string }> = {
	"claude-opus-4-6": { provider: "anthropic", modelId: "claude-opus-4-6" },
	"claude-sonnet-4-6": { provider: "anthropic", modelId: "claude-sonnet-4-6" },
	"gemini-2.5-pro": { provider: "google", modelId: "gemini-2.5-pro" },
	"gemini-2.5-flash": { provider: "google", modelId: "gemini-2.5-flash" },
};

function resolveModel(modelName: string): Model<Api> | null {
	// Check custom models first
	const custom = CUSTOM_MODELS[modelName];
	if (custom) return custom;

	// Then check pi-ai registry
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

/** Determine provider from model name for API key routing. */
function getProviderForModel(modelName: string): string | null {
	if (CUSTOM_MODELS[modelName]) return CUSTOM_MODELS[modelName].provider;
	const entry = REGISTRY_MODELS[modelName];
	return entry?.provider ?? null;
}

/**
 * Send a prompt to the LLM and return the generated text.
 * Implements fallback: primary model → LLM_FALLBACK_MODEL → error.
 *
 * This function matches the `(prompt: string, model: string) => Promise<string>`
 * signature used by reporters/pipeline.ts and jobs/scheduler.ts.
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
					apiKey: getApiKeyForModel(name, config),
				},
			);

			// Extract text from assistant message content
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
		}
	}

	throw lastError ?? new Error("All LLM models failed");
}

/** Get the appropriate API key for a model. */
function getApiKeyForModel(modelName: string, config: ReturnType<typeof loadConfig>): string | undefined {
	const provider = getProviderForModel(modelName);
	if (!provider) return undefined;

	if (provider === "anthropic") return config.ANTHROPIC_API_KEY;
	if (provider === "google") return config.GEMINI_API_KEY;
	return undefined;
}
