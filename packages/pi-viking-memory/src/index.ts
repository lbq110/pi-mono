/**
 * pi-viking-memory — OpenViking persistent memory extension for pi-mono
 *
 * Philosophy: tools-first, memory as an opt-in capability.
 *
 * - LLM decides when to call recall_memory / save_memory (active tools).
 * - Session messages are synced transparently on compact / shutdown (passive hooks).
 * - If OpenViking is unreachable, all tools degrade gracefully; pi-mono is unaffected.
 *
 * Installation:
 *   Copy (or symlink) src/index.ts to ~/.pi/agent/extensions/viking-memory.ts
 *   OR launch pi with: pi -e /path/to/pi-viking-memory/src/index.ts
 *
 * Config: ~/.pi/viking-memory.json  (created automatically with defaults on first run)
 */

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
	SessionShutdownEvent,
} from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { OVClient } from "./ov-client.js";
import type { SyncMessage } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";
import { createAddKnowledgeTool } from "./tools/add-knowledge.js";
import { createExploreMemoryTool } from "./tools/explore-memory.js";
import { createRecallMemoryTool } from "./tools/recall-memory.js";
import { createSaveMemoryTool } from "./tools/save-memory.js";

/** Injected into the system prompt when injectMemorySystemPrompt is true (~100 tokens). */
const MEMORY_SYSTEM_PROMPT = `
## Persistent Memory (OpenViking)

You have access to a persistent memory system that stores information across sessions.

Available memory tools:
- **recall_memory(query, scope?)** — Search long-term memory. Scopes: 'preferences', 'entities', 'cases', 'all' (default).
- **save_memory(content)** — Explicitly persist important information for future sessions.
- **explore_memory(uri)** — Browse the memory filesystem, e.g. 'viking://user/memories/'.
- **add_knowledge(path)** — Index a local file or directory for semantic search.

Use recall_memory proactively when context from previous sessions may be relevant.
`.trim();

export default async function vikingMemoryExtension(pi: ExtensionAPI): Promise<void> {
	const config = loadConfig();
	const client = new OVClient(config.openviking);
	const sessionManager = new SessionManager(client);

	// ─── Register LLM-callable tools ────────────────────────────────────────
	pi.registerTool(createRecallMemoryTool(client));
	pi.registerTool(createSaveMemoryTool(client, sessionManager));
	pi.registerTool(createExploreMemoryTool(client));
	pi.registerTool(createAddKnowledgeTool(client));

	// ─── Passive lifecycle hooks ─────────────────────────────────────────────

	/**
	 * before_agent_start
	 * Fired before each agent loop starts (once per user prompt).
	 * - Ensures an OV session exists for this pi session.
	 * - Optionally appends the memory capabilities description to the system prompt.
	 */
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
		const healthy = await client.health();
		if (!healthy) return; // Silent degradation — OV is not running

		await sessionManager.ensureSession();

		if (config.prompts.injectMemorySystemPrompt) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${MEMORY_SYSTEM_PROMPT}`,
			};
		}
	});

	/**
	 * session_compact
	 * Fired after context compaction. Sync all messages accumulated so far and
	 * commit to trigger memory extraction. This ensures memories are preserved
	 * even when context windows are pruned.
	 */
	pi.on("session_compact", async (_event: SessionCompactEvent, ctx: ExtensionContext): Promise<void> => {
		if (!config.behavior.autoSyncMessages) return;
		const messages = extractTextMessages(ctx);
		await sessionManager.syncAndCommit(messages);
	});

	/**
	 * session_shutdown
	 * Fired when pi-mono is about to exit. Final sync + commit so the session's
	 * conversation is committed to OV for memory extraction.
	 */
	pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
		if (!config.behavior.autoCommitOnShutdown) return;
		const messages = extractTextMessages(ctx);
		await sessionManager.syncAndCommit(messages);
	});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract user and assistant text messages from the current session branch.
 * Returns only messages that have a non-empty text body so that tool-call
 * entries and images don't get pushed to OV.
 */
function extractTextMessages(ctx: ExtensionContext): SyncMessage[] {
	const messages: SyncMessage[] = [];

	try {
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type !== "message") continue;

			const msg = entry.message as unknown as Record<string, unknown>;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const text = extractText(msg.content);
			if (text.trim()) {
				messages.push({ role: role as string, content: text });
			}
		}
	} catch {
		// getBranch() may not be available in all contexts — fail silently
	}

	return messages;
}

/** Flatten message content into a plain string. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c?.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}
