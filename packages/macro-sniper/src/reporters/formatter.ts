/**
 * Post-process the LLM output.
 * Strips leading/trailing whitespace and any accidental code fences.
 */
export function formatReport(raw: string): string {
	let text = raw.trim();

	// Remove wrapping code fences if the LLM accidentally added them
	if (text.startsWith("```markdown")) {
		text = text.slice("```markdown".length);
	} else if (text.startsWith("```md")) {
		text = text.slice("```md".length);
	} else if (text.startsWith("```")) {
		text = text.slice(3);
	}

	if (text.endsWith("```")) {
		text = text.slice(0, -3);
	}

	return text.trim();
}
