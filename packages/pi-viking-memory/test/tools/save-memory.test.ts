import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OVClient } from "../../src/ov-client.js";
import type { SessionManager } from "../../src/session-manager.js";
import { createSaveMemoryTool } from "../../src/tools/save-memory.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClientMock(): OVClient {
	return {
		addMessage: vi.fn().mockResolvedValue(undefined),
	} as unknown as OVClient;
}

function makeSessionManagerMock(sessionId: string | null = "ov-sess-1"): SessionManager {
	return {
		ensureSession: vi.fn().mockResolvedValue(sessionId),
		getSessionId: vi.fn().mockReturnValue(sessionId),
	} as unknown as SessionManager;
}

const NOOP_CTX = {} as never;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("save_memory tool", () => {
	let client: OVClient;
	let sessionManager: SessionManager;

	beforeEach(() => {
		client = makeClientMock();
		sessionManager = makeSessionManagerMock();
	});

	it("adds an assistant message prefixed with [Memory Note]", async () => {
		const tool = createSaveMemoryTool(client, sessionManager);
		const result = await tool.execute(
			"tc1",
			{ content: "User prefers 4-space indentation" },
			undefined,
			undefined,
			NOOP_CTX,
		);

		expect(client.addMessage).toHaveBeenCalledWith(
			"ov-sess-1",
			"assistant",
			"[Memory Note] User prefers 4-space indentation",
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Saved to memory");
	});

	it("returns isError=true when ensureSession returns null", async () => {
		sessionManager = makeSessionManagerMock(null);
		const tool = createSaveMemoryTool(client, sessionManager);

		const result = await tool.execute("tc2", { content: "something" }, undefined, undefined, NOOP_CTX);

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Memory service unavailable");
		expect(client.addMessage).not.toHaveBeenCalled();
	});

	it("returns isError=true when addMessage throws", async () => {
		vi.mocked(client.addMessage).mockRejectedValue(new Error("network error"));

		const tool = createSaveMemoryTool(client, sessionManager);
		const result = await tool.execute("tc3", { content: "fact" }, undefined, undefined, NOOP_CTX);

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Failed to save memory");
		expect(text).toContain("network error");
	});
});
