import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:fs so we don't actually touch the filesystem
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";

describe("loadConfig()", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("returns defaults when config file does not exist", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});

		const config = loadConfig();

		expect(config.openviking.baseUrl).toBe("http://localhost:1933");
		expect(config.openviking.apiKey).toBeNull();
		expect(config.openviking.timeout).toBe(10000);
		expect(config.behavior.autoSyncMessages).toBe(true);
		expect(config.behavior.autoCommitOnShutdown).toBe(true);
		expect(config.prompts.injectMemorySystemPrompt).toBe(true);
	});

	it("merges user config over defaults", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({
				openviking: { baseUrl: "http://remote:9000", apiKey: "mykey" },
				behavior: { autoSyncMessages: false },
			}),
		);

		const config = loadConfig();

		expect(config.openviking.baseUrl).toBe("http://remote:9000");
		expect(config.openviking.apiKey).toBe("mykey");
		expect(config.openviking.timeout).toBe(10000); // default preserved
		expect(config.behavior.autoSyncMessages).toBe(false); // overridden
		expect(config.behavior.autoCommitOnShutdown).toBe(true); // default preserved
	});

	it("returns defaults when config file contains invalid JSON", () => {
		vi.mocked(readFileSync).mockReturnValue("{ invalid json }");

		const config = loadConfig();

		expect(config.openviking.baseUrl).toBe("http://localhost:1933");
	});

	it("does not mutate default config across calls", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const c1 = loadConfig();
		c1.openviking.baseUrl = "http://mutated";

		const c2 = loadConfig();
		expect(c2.openviking.baseUrl).toBe("http://localhost:1933");
	});
});
