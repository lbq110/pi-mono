import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OVClient } from "../ov-client.js";

const AddKnowledgeParams = Type.Object({
	path: Type.String({
		description:
			"Absolute path to the file or directory to add to the knowledge base. The content will be semantically indexed for future search.",
	}),
	reason: Type.Optional(
		Type.String({
			description: "Why this resource is being added (helps with extraction context)",
		}),
	),
	instruction: Type.Optional(
		Type.String({
			description: "Special instructions for how to process this resource",
		}),
	),
});

export function createAddKnowledgeTool(client: OVClient): ToolDefinition<typeof AddKnowledgeParams> {
	return {
		name: "add_knowledge",
		label: "Add Knowledge",
		description:
			"Add a local file or directory to the OpenViking knowledge base. The content is semantically indexed and becomes searchable via recall_memory in future sessions. Useful for project documentation, README files, API specs, or any reference material.",
		parameters: AddKnowledgeParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			try {
				const result = await client.addResource(params.path, params.reason ?? "", params.instruction ?? "");
				return {
					content: [
						{
							type: "text" as const,
							text: `Knowledge added successfully: ${JSON.stringify(result)}`,
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
							text: `Failed to add knowledge for '${params.path}': ${message}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	};
}
