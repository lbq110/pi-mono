import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OVClient } from "../src/ov-client.js";
import { SessionManager } from "../src/session-manager.js";

// ─── Minimal mock of OVClient ─────────────────────────────────────────────────

function makeClientMock(overrides?: Partial<OVClient>): OVClient {
	return {
		health: vi.fn().mockResolvedValue(true),
		createSession: vi.fn().mockResolvedValue({ session_id: "ov-sess-1" }),
		addMessage: vi.fn().mockResolvedValue(undefined),
		commitSession: vi.fn().mockResolvedValue({ memories_extracted: 2 }),
		find: vi.fn(),
		ls: vi.fn(),
		addResource: vi.fn(),
		...overrides,
	} as unknown as OVClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
	let client: OVClient;
	let manager: SessionManager;

	beforeEach(() => {
		client = makeClientMock();
		manager = new SessionManager(client);
	});

	// ── ensureSession() ───────────────────────────────────────────────────────

	describe("ensureSession()", () => {
		it("creates an OV session and returns its ID", async () => {
			const id = await manager.ensureSession();
			expect(id).toBe("ov-sess-1");
			expect(client.createSession).toHaveBeenCalledOnce();
		});

		it("is idempotent — only creates one session across multiple calls", async () => {
			await manager.ensureSession();
			await manager.ensureSession();
			await manager.ensureSession();
			expect(client.createSession).toHaveBeenCalledOnce();
		});

		it("returns null when createSession throws", async () => {
			const failClient = makeClientMock({
				createSession: vi.fn().mockRejectedValue(new Error("network error")),
			});
			const mgr = new SessionManager(failClient);
			const id = await mgr.ensureSession();
			expect(id).toBeNull();
		});

		it("exposes the session ID via getSessionId()", async () => {
			expect(manager.getSessionId()).toBeNull();
			await manager.ensureSession();
			expect(manager.getSessionId()).toBe("ov-sess-1");
		});
	});

	// ── syncMessages() ────────────────────────────────────────────────────────

	describe("syncMessages()", () => {
		beforeEach(async () => {
			// Ensure a session exists before syncing
			await manager.ensureSession();
		});

		it("sends all messages on first call", async () => {
			const msgs = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
			];
			await manager.syncMessages(msgs);

			expect(client.addMessage).toHaveBeenCalledTimes(2);
			expect(client.addMessage).toHaveBeenNthCalledWith(1, "ov-sess-1", "user", "Hello");
			expect(client.addMessage).toHaveBeenNthCalledWith(2, "ov-sess-1", "assistant", "Hi there!");
			expect(manager.getSyncedCount()).toBe(2);
		});

		it("is incremental — only sends new messages on subsequent calls", async () => {
			const msgs = [
				{ role: "user", content: "First" },
				{ role: "assistant", content: "Second" },
				{ role: "user", content: "Third" },
			];

			await manager.syncMessages(msgs.slice(0, 2));
			vi.clearAllMocks();

			await manager.syncMessages(msgs);
			expect(client.addMessage).toHaveBeenCalledOnce();
			expect(client.addMessage).toHaveBeenCalledWith("ov-sess-1", "user", "Third");
		});

		it("stops on first addMessage error to preserve ordering", async () => {
			const addMessageMock = vi
				.fn()
				.mockResolvedValueOnce(undefined) // msg[0] ok
				.mockRejectedValueOnce(new Error("timeout")); // msg[1] fails
			client = makeClientMock({ addMessage: addMessageMock });
			manager = new SessionManager(client);
			await manager.ensureSession();

			const msgs = [
				{ role: "user", content: "A" },
				{ role: "assistant", content: "B" },
				{ role: "user", content: "C" },
			];
			await manager.syncMessages(msgs);

			expect(manager.getSyncedCount()).toBe(1); // only first was synced
		});

		it("does nothing when no session exists", async () => {
			const freshManager = new SessionManager(client);
			await freshManager.syncMessages([{ role: "user", content: "hi" }]);
			expect(client.addMessage).not.toHaveBeenCalled();
		});
	});

	// ── commitSession() ───────────────────────────────────────────────────────

	describe("commitSession()", () => {
		it("calls commitSession on the client", async () => {
			await manager.ensureSession();
			const result = await manager.commitSession();
			expect(result?.memories_extracted).toBe(2);
			expect(client.commitSession).toHaveBeenCalledWith("ov-sess-1");
		});

		it("returns null when no session exists", async () => {
			const result = await manager.commitSession();
			expect(result).toBeNull();
			expect(client.commitSession).not.toHaveBeenCalled();
		});

		it("returns null (swallows error) when commit throws", async () => {
			const failClient = makeClientMock({
				commitSession: vi.fn().mockRejectedValue(new Error("commit failed")),
			});
			const mgr = new SessionManager(failClient);
			await mgr.ensureSession();
			const result = await mgr.commitSession();
			expect(result).toBeNull();
		});
	});

	// ── syncAndCommit() ───────────────────────────────────────────────────────

	describe("syncAndCommit()", () => {
		it("syncs then commits in order", async () => {
			await manager.ensureSession();
			const callOrder: string[] = [];
			vi.mocked(client.addMessage).mockImplementation(async () => {
				callOrder.push("addMessage");
			});
			vi.mocked(client.commitSession).mockImplementation(async () => {
				callOrder.push("commitSession");
				return { memories_extracted: 1 };
			});

			await manager.syncAndCommit([{ role: "user", content: "hello" }]);

			expect(callOrder).toEqual(["addMessage", "commitSession"]);
		});

		it("does nothing when no session exists", async () => {
			await manager.syncAndCommit([{ role: "user", content: "hello" }]);
			expect(client.addMessage).not.toHaveBeenCalled();
			expect(client.commitSession).not.toHaveBeenCalled();
		});
	});
});
