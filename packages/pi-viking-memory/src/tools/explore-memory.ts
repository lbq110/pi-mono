import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OVClient } from "../ov-client.js";

const ExploreParams = Type.Object({
	uri: Type.String({
		description:
			"Viking URI to list. Examples: 'viking://user/memories/', 'viking://user/memories/preferences/', 'viking://user/memories/entities/'",
	}),
});

export function createExploreMemoryTool(client: OVClient): ToolDefinition<typeof ExploreParams> {
	return {
		name: "explore_memory",
		label: "Explore Memory",
		description:
			"Browse the memory filesystem to see what has been stored. Use viking:// URIs to navigate the memory structure. Start with 'viking://user/memories/' to see all memory categories.",
		parameters: ExploreParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			try {
				const result = await client.ls(params.uri);
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
							text: `Failed to explore memory at '${params.uri}': ${message}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	};
}
