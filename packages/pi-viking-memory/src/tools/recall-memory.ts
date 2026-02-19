import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OVClient } from "../ov-client.js";

/** Maps human-friendly scope names to Viking URI prefixes.
 * Note: global search (target_uri="") only matches directory-level abstracts;
 * specifying the memories root ensures individual memory files are searched.
 */
const SCOPE_URI: Record<string, string> = {
	preferences: "viking://user/memories/preferences/",
	entities: "viking://user/memories/entities/",
	cases: "viking://user/memories/cases/",
	all: "viking://user/memories/",
};

const RecallParams = Type.Object({
	query: Type.String({
		description: "Natural language query describing what to search for in memory",
	}),
	scope: Type.Optional(
		Type.Union([Type.Literal("preferences"), Type.Literal("entities"), Type.Literal("cases"), Type.Literal("all")], {
			description:
				"Memory scope to search. 'preferences' for user preferences, 'entities' for known facts/people/projects, 'cases' for past tasks/solutions, 'all' for everything (default).",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5)" })),
});

export function createRecallMemoryTool(client: OVClient): ToolDefinition<typeof RecallParams> {
	return {
		name: "recall_memory",
		label: "Recall Memory",
		description:
			"Search persistent long-term memory from previous sessions. Use this proactively to recall user preferences, past decisions, known entities, project context, or any information that was saved across sessions.",
		parameters: RecallParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			const targetUri = SCOPE_URI[params.scope ?? "all"] ?? "";

			try {
				const result = await client.find(params.query, {
					targetUri,
					limit: params.limit ?? 5,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
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
							text: `Memory service unavailable: ${message}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	};
}
