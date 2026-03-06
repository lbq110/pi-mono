/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Key differences:
 * - Slack uses *bold* (single asterisk), not **bold**
 * - Slack has no heading syntax; we convert # to bold lines
 * - Slack tables don't exist; we convert to aligned preformatted blocks
 * - Slack uses • for bullet lists
 */
export function markdownToSlackMrkdwn(md: string): string {
	const lines = md.split("\n");
	const result: string[] = [];
	let tableBuffer: string[][] = [];

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		const isTableRow = /^\s*\|/.test(line);
		const isSeparatorRow = /^\s*\|[\s:|-]+\|\s*$/.test(line);

		if (isTableRow) {
			if (isSeparatorRow) continue;
			// Parse cells: strip outer pipes, split by inner pipes
			const cells = line
				.replace(/^\s*\|\s*/, "")
				.replace(/\s*\|\s*$/, "")
				.split(/\s*\|\s*/);
			tableBuffer.push(cells);
			continue;
		}

		// If we just exited a table, flush it
		if (tableBuffer.length > 0) {
			flushTable(tableBuffer, result);
			tableBuffer = [];
		}

		// Headings → bold line with emoji preserved
		if (/^#{1,3}\s+/.test(line)) {
			line = line.replace(/^#{1,3}\s+/, "");
			line = line.replace(/\*\*(.+?)\*\*/g, "$1");
			result.push(`*${line}*`);
			continue;
		}

		// Bold: **text** → *text*
		line = line.replace(/\*\*(.+?)\*\*/g, "*$1*");

		// Ensure Slack mrkdwn bold renders: closing * must have space before CJK punctuation
		line = line.replace(/\*([：:，。、；！？）」』】])/g, "* $1");

		// Bullet points: *   text → •  text
		line = line.replace(/^\*\s{1,3}/, "•  ");

		// Horizontal rules
		if (/^---+$/.test(line.trim())) {
			result.push("─".repeat(40));
			continue;
		}

		result.push(line);
	}

	// Flush any remaining table
	if (tableBuffer.length > 0) {
		flushTable(tableBuffer, result);
	}

	return result.join("\n");
}

/**
 * Render a collected table as a clean key-value list.
 * Avoids monospace alignment issues with CJK text in Slack.
 *
 * For 2-column tables:  • *col1*:  col2
 * For 3+ column tables: • *col1*:  col2 — col3
 */
function flushTable(rows: string[][], out: string[]): void {
	if (rows.length < 2) return;

	const dataRows = rows.slice(1);

	out.push("");
	for (const row of dataRows) {
		const label = row[0] ?? "";
		const value = row[1] ?? "";
		const extra = row.slice(2).filter((c) => c.trim() !== "" && c.trim() !== "-");

		let line = `•  *${label}*:  ${value}`;
		if (extra.length > 0) {
			line += ` — ${extra.join(" / ")}`;
		}
		out.push(line);
	}
	out.push("");
}
