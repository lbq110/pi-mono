import { z } from "zod";

const envSchema = z.object({
	// Required
	FRED_API_KEY: z.string().min(1, "FRED_API_KEY is required"),

	// LLM API keys — at least one must be set for report generation.
	// pi-ai also auto-detects from env vars (ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.),
	// so these can be omitted if the env vars are already present.
	ANTHROPIC_API_KEY: z.string().optional(),

	// Mom (Slack push via file events)
	MOM_EVENTS_DIR: z.string().optional(),
	MOM_CHANNEL_ID: z.string().optional(),

	// Slack direct push
	SLACK_BOT_TOKEN: z.string().optional(),
	SLACK_CHANNEL_ID: z.string().optional(),

	// Optional data sources / API keys
	GEMINI_API_KEY: z.string().optional(),
	BINANCE_API_KEY: z.string().optional(), // Reserved for Phase 3 trade execution
	POLYGON_API_KEY: z.string().optional(),

	// Database
	DATABASE_PATH: z.string().default("./data/macro-sniper.db"),

	// LLM
	LLM_MODEL_HEAVY: z.string().default("claude-opus-4-6"),
	LLM_MODEL_FAST: z.string().default("gemini-3.1-flash-lite-preview"),
	LLM_FALLBACK_MODEL: z.string().default("gemini-2.5-flash"),
	LLM_TEMPERATURE: z
		.string()
		.default("0.1")
		.transform((v) => Number.parseFloat(v)),

	// Application
	APP_ENV: z.enum(["development", "production", "test"]).default("development"),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
	if (_config) return _config;
	_config = envSchema.parse(process.env);
	return _config;
}

/** Reset cached config (for testing) */
export function resetConfig(): void {
	_config = null;
}
