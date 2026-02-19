import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OVConfig {
	baseUrl: string;
	apiKey: string | null;
	timeout: number;
}

export interface BehaviorConfig {
	autoSyncMessages: boolean;
	autoCommitOnShutdown: boolean;
}

export interface PromptsConfig {
	injectMemorySystemPrompt: boolean;
}

export interface VikingMemoryConfig {
	openviking: OVConfig;
	behavior: BehaviorConfig;
	prompts: PromptsConfig;
}

const DEFAULT_CONFIG: VikingMemoryConfig = {
	openviking: {
		baseUrl: "http://localhost:1933",
		apiKey: null,
		timeout: 10000,
	},
	behavior: {
		autoSyncMessages: true,
		autoCommitOnShutdown: true,
	},
	prompts: {
		injectMemorySystemPrompt: true,
	},
};

export function loadConfig(): VikingMemoryConfig {
	const configPath = join(homedir(), ".pi", "viking-memory.json");
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<VikingMemoryConfig>;
		return {
			openviking: { ...DEFAULT_CONFIG.openviking, ...parsed.openviking },
			behavior: { ...DEFAULT_CONFIG.behavior, ...parsed.behavior },
			prompts: { ...DEFAULT_CONFIG.prompts, ...parsed.prompts },
		};
	} catch {
		return {
			openviking: { ...DEFAULT_CONFIG.openviking },
			behavior: { ...DEFAULT_CONFIG.behavior },
			prompts: { ...DEFAULT_CONFIG.prompts },
		};
	}
}
