import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OVClient } from "../ov-client.js";
import type { SessionManager } from "../session-manager.js";

const SaveParams = Type.Object({
	content: Type.String({
		description:
			"The information to save to long-term memory. Be specific and self-contained so the information is useful on its own in future sessions.",
	}),
});

export function createSaveMemoryTool(
	client: OVClient,
	sessionManager: SessionManager,
): ToolDefinition<typeof SaveParams> {
	return {
		name: "save_memory",
		label: "Save Memory",
		description:
			"Explicitly save important information to long-term memory for future sessions. Use for user preferences, important decisions, key project facts, coding style rules, or any context that should persist.",
		parameters: SaveParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			// Ensure a session exists (idempotent)
			const sessionId = await sessionManager.ensureSession();

			if (!sessionId) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Memory service unavailable: could not establish session",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			try {
				// Append as an assistant message so OV's extraction pipeline captures it
				await client.addMessage(sessionId, "assistant", `[Memory Note] ${params.content}`);

				return {
					content: [
						{
							type: "text" as const,
							text: `Saved to memory: "${params.content}"`,
						},
					],
					details: undefined,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to save memory: ${message}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	};
}
