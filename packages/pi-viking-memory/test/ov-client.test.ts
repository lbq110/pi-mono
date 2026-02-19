import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OVConfig } from "../src/config.js";
import { OVClient } from "../src/ov-client.js";

// ─── Fetch mock helpers ────────────────────────────────────────────────────────

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }) {
	return vi.fn().mockResolvedValue({
		ok: response.ok,
		status: response.status ?? (response.ok ? 200 : 500),
		statusText: response.ok ? "OK" : "Internal Server Error",
		json: vi.fn().mockResolvedValue(response.body ?? { status: "ok", result: {} }),
	});
}

function mockFetchOV<T>(result: T) {
	return mockFetch({ ok: true, body: { status: "ok", result } });
}

const BASE_CONFIG: OVConfig = {
	baseUrl: "http://localhost:1933",
	apiKey: null,
	timeout: 5000,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OVClient", () => {
	let client: OVClient;

	beforeEach(() => {
		client = new OVClient(BASE_CONFIG);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── health() ──────────────────────────────────────────────────────────────

	describe("health()", () => {
		it("returns true when server responds 200", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
			expect(await client.health()).toBe(true);
		});

		it("returns false when server responds 500", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
			expect(await client.health()).toBe(false);
		});

		it("returns false when fetch throws (server down)", async () => {
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
			expect(await client.health()).toBe(false);
		});
	});

	// ── createSession() ───────────────────────────────────────────────────────

	describe("createSession()", () => {
		it("POSTs to /api/v1/sessions and returns session_id", async () => {
			const fetchMock = mockFetchOV({ session_id: "sess-abc" });
			vi.stubGlobal("fetch", fetchMock);

			const result = await client.createSession();

			expect(result.session_id).toBe("sess-abc");
			expect(fetchMock).toHaveBeenCalledOnce();
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("http://localhost:1933/api/v1/sessions");
			expect(init.method).toBe("POST");
		});

		it("throws on HTTP error", async () => {
			vi.stubGlobal("fetch", mockFetch({ ok: false, status: 500 }));
			await expect(client.createSession()).rejects.toThrow("HTTP 500");
		});
	});

	// ── addMessage() ──────────────────────────────────────────────────────────

	describe("addMessage()", () => {
		it("POSTs to /api/v1/sessions/{id}/messages with role and content", async () => {
			const fetchMock = mockFetchOV({ message_count: 1 });
			vi.stubGlobal("fetch", fetchMock);

			await client.addMessage("sess-1", "user", "Hello world");

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toContain("/api/v1/sessions/sess-1/messages");
			const body = JSON.parse(init.body as string);
			expect(body).toEqual({ role: "user", content: "Hello world" });
		});
	});

	// ── commitSession() ───────────────────────────────────────────────────────

	describe("commitSession()", () => {
		it("POSTs to /api/v1/sessions/{id}/commit", async () => {
			const fetchMock = mockFetchOV({ memories_extracted: 3 });
			vi.stubGlobal("fetch", fetchMock);

			const result = await client.commitSession("sess-1");

			expect(result.memories_extracted).toBe(3);
			const [url] = fetchMock.mock.calls[0] as [string];
			expect(url).toContain("/api/v1/sessions/sess-1/commit");
		});
	});

	// ── find() ────────────────────────────────────────────────────────────────

	describe("find()", () => {
		it("normalises array result format", async () => {
			const raw = [
				{ uri: "viking://user/memories/pref/1", score: 0.9, abstract: "4-space indent" },
				{ uri: "viking://user/memories/pref/2", score: 0.7, summary: "TypeScript strict mode" },
			];
			vi.stubGlobal("fetch", mockFetchOV(raw));

			const result = await client.find("code style");

			expect(result.found).toBe(2);
			expect(result.memories[0].uri).toBe("viking://user/memories/pref/1");
			expect(result.memories[0].relevance).toBe(0.9);
			expect(result.memories[0].summary).toBe("4-space indent");
		});

		it("normalises {items: [...]} result format", async () => {
			const raw = {
				items: [{ uri: "viking://x", score: 0.5, text: "some content" }],
			};
			vi.stubGlobal("fetch", mockFetchOV(raw));

			const result = await client.find("query");

			expect(result.found).toBe(1);
			expect(result.memories[0].summary).toBe("some content");
		});

		it("sends target_uri when scope provided", async () => {
			const fetchMock = mockFetchOV([]);
			vi.stubGlobal("fetch", fetchMock);

			await client.find("my query", {
				targetUri: "viking://user/memories/preferences/",
				limit: 3,
			});

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string);
			expect(body.target_uri).toBe("viking://user/memories/preferences/");
			expect(body.limit).toBe(3);
		});

		it("returns empty result on null response", async () => {
			vi.stubGlobal("fetch", mockFetchOV(null));
			const result = await client.find("query");
			expect(result).toEqual({ found: 0, memories: [] });
		});
	});

	// ── ls() ──────────────────────────────────────────────────────────────────

	describe("ls()", () => {
		it("GETs /api/v1/fs/ls with uri query param", async () => {
			const fetchMock = mockFetchOV([{ name: "preferences" }, { name: "entities" }]);
			vi.stubGlobal("fetch", fetchMock);

			const result = await client.ls("viking://user/memories/");

			expect(result).toHaveLength(2);
			const [url] = fetchMock.mock.calls[0] as [string];
			expect(url).toContain("/api/v1/fs/ls");
			expect(url).toContain("uri=viking%3A%2F%2Fuser%2Fmemories%2F");
		});
	});

	// ── addResource() ─────────────────────────────────────────────────────────

	describe("addResource()", () => {
		it("POSTs to /api/v1/resources with path", async () => {
			const fetchMock = mockFetchOV({ uri: "viking://resources/readme" });
			vi.stubGlobal("fetch", fetchMock);

			await client.addResource("/home/user/README.md", "project docs");

			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toContain("/api/v1/resources");
			const body = JSON.parse(init.body as string);
			expect(body.path).toBe("/home/user/README.md");
			expect(body.reason).toBe("project docs");
		});
	});

	// ── API key header ─────────────────────────────────────────────────────────

	describe("API key", () => {
		it("includes Authorization header when apiKey is set", async () => {
			const authedClient = new OVClient({
				...BASE_CONFIG,
				apiKey: "secret-key",
			});
			const fetchMock = mockFetchOV({ session_id: "s1" });
			vi.stubGlobal("fetch", fetchMock);

			await authedClient.createSession();

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer secret-key");
		});

		it("omits Authorization header when apiKey is null", async () => {
			const fetchMock = mockFetchOV({ session_id: "s1" });
			vi.stubGlobal("fetch", fetchMock);

			await client.createSession();

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).toBeUndefined();
		});
	});

	// ── trailing slash normalisation ──────────────────────────────────────────

	describe("baseUrl normalisation", () => {
		it("strips trailing slash from baseUrl", async () => {
			const c = new OVClient({ ...BASE_CONFIG, baseUrl: "http://localhost:1933/" });
			const fetchMock = mockFetchOV({ session_id: "s1" });
			vi.stubGlobal("fetch", fetchMock);

			await c.createSession();

			const [url] = fetchMock.mock.calls[0] as [string];
			expect(url).toBe("http://localhost:1933/api/v1/sessions");
		});
	});
});
