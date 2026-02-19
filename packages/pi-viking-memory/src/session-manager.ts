import type { OVClient } from "./ov-client.js";

/** A minimal message shape we sync to OpenViking. */
export interface SyncMessage {
	role: string;
	content: string;
}

/** Manages a single OpenViking session bound to one pi-mono session.
 *
 * Design rules:
 * - ensureSession() is idempotent: calls after the first are no-ops.
 * - syncMessages() is incremental: only messages not yet synced are sent.
 * - All methods swallow errors so the extension never crashes pi-mono.
 */
export class SessionManager {
	private ovSessionId: string | null = null;
	private syncedCount = 0;
	private readonly client: OVClient;

	constructor(client: OVClient) {
		this.client = client;
	}

	/** Create an OV session if one doesn't already exist.
	 * Returns the session ID, or null on failure.
	 */
	async ensureSession(): Promise<string | null> {
		if (this.ovSessionId !== null) return this.ovSessionId;

		try {
			const { session_id } = await this.client.createSession();
			this.ovSessionId = session_id;
			this.syncedCount = 0;
			return session_id;
		} catch {
			return null;
		}
	}

	/** Incrementally sync new messages to OV.
	 * Only messages at index >= syncedCount are sent.
	 * Stops on the first error to preserve ordering.
	 */
	async syncMessages(messages: SyncMessage[]): Promise<void> {
		if (this.ovSessionId === null) return;

		const pending = messages.slice(this.syncedCount);
		for (const msg of pending) {
			try {
				await this.client.addMessage(this.ovSessionId, msg.role, msg.content);
				this.syncedCount++;
			} catch {
				// Stop on first failure — ordering must be preserved
				break;
			}
		}
	}

	/** Trigger memory extraction for the current session.
	 * Returns the server result, or null on failure.
	 */
	async commitSession(): Promise<{ memories_extracted?: number } | null> {
		if (this.ovSessionId === null) return null;

		try {
			return await this.client.commitSession(this.ovSessionId);
		} catch {
			return null;
		}
	}

	/** Convenience: sync then commit in one call. */
	async syncAndCommit(messages: SyncMessage[]): Promise<void> {
		if (this.ovSessionId === null) return;
		await this.syncMessages(messages);
		await this.commitSession();
	}

	/** The active OV session ID, or null if no session has been created yet. */
	getSessionId(): string | null {
		return this.ovSessionId;
	}

	/** How many messages have been successfully synced so far. */
	getSyncedCount(): number {
		return this.syncedCount;
	}
}
