import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OVClient } from "../../src/ov-client.js";
import { createRecallMemoryTool } from "../../src/tools/recall-memory.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClientMock(overrides?: Partial<OVClient>): OVClient {
	return {
		find: vi.fn().mockResolvedValue({ found: 0, memories: [] }),
		...overrides,
	} as unknown as OVClient;
}

const NOOP_CTX = {} as never;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recall_memory tool", () => {
	let client: OVClient;

	beforeEach(() => {
		client = makeClientMock();
	});

	it("returns JSON-encoded find result on success", async () => {
		vi.mocked(client.find).mockResolvedValue({
			found: 1,
			memories: [{ uri: "viking://u/m/p/1", relevance: 0.9, summary: "4-space indent" }],
		});

		const tool = createRecallMemoryTool(client);
		const result = await tool.execute("tc1", { query: "code style" }, undefined, undefined, NOOP_CTX);

		expect(
			result.content[0].type === "text" ? (result.content[0] as { type: "text"; text: string }).text : "",
		).not.toContain("Error");
		const parsed = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");
		expect(parsed.found).toBe(1);
		expect(parsed.memories[0].summary).toBe("4-space indent");
	});

	it("maps 'preferences' scope to target URI", async () => {
		const tool = createRecallMemoryTool(client);
		await tool.execute("tc2", { query: "indent", scope: "preferences" }, undefined, undefined, NOOP_CTX);

		expect(client.find).toHaveBeenCalledWith(
			"indent",
			expect.objectContaining({ targetUri: "viking://user/memories/preferences/" }),
		);
	});

	it("maps 'entities' scope to target URI", async () => {
		const tool = createRecallMemoryTool(client);
		await tool.execute("tc3", { query: "project X", scope: "entities" }, undefined, undefined, NOOP_CTX);

		expect(client.find).toHaveBeenCalledWith(
			"project X",
			expect.objectContaining({ targetUri: "viking://user/memories/entities/" }),
		);
	});

	it("uses memories root URI for 'all' scope (default)", async () => {
		const tool = createRecallMemoryTool(client);
		await tool.execute("tc4", { query: "anything" }, undefined, undefined, NOOP_CTX);

		expect(client.find).toHaveBeenCalledWith(
			"anything",
			expect.objectContaining({ targetUri: "viking://user/memories/" }),
		);
	});

	it("respects custom limit parameter", async () => {
		const tool = createRecallMemoryTool(client);
		await tool.execute("tc5", { query: "query", limit: 10 }, undefined, undefined, NOOP_CTX);

		expect(client.find).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 10 }));
	});

	it("returns isError=true and message when find throws", async () => {
		vi.mocked(client.find).mockRejectedValue(new Error("connection refused"));

		const tool = createRecallMemoryTool(client);
		const result = await tool.execute("tc6", { query: "fail" }, undefined, undefined, NOOP_CTX);

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Memory service unavailable");
		expect(text).toContain("connection refused");
	});
});
