import { createChildLogger } from "../logger.js";
import { markdownToSlackMrkdwn } from "./slack-format.js";

const log = createChildLogger("notification");

interface SlackPostResult {
	ok: boolean;
	error?: string;
	ts?: string;
}

/** Slack section block text limit is 3000 chars. */
const BLOCK_TEXT_LIMIT = 3000;

/**
 * Split text into chunks that fit within Slack's section block text limit.
 * Splits on paragraph boundaries (double newline) to avoid breaking mid-sentence.
 */
function splitIntoChunks(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= limit) {
			chunks.push(remaining);
			break;
		}

		// Find a good split point: last double-newline before limit
		let splitAt = remaining.lastIndexOf("\n\n", limit);
		if (splitAt <= 0) {
			// Fallback: split at last single newline
			splitAt = remaining.lastIndexOf("\n", limit);
		}
		if (splitAt <= 0) {
			// Last resort: hard split at limit
			splitAt = limit;
		}

		chunks.push(remaining.substring(0, splitAt));
		remaining = remaining.substring(splitAt).replace(/^\n+/, "");
	}

	return chunks;
}

/**
 * Build Slack Block Kit blocks from mrkdwn text.
 * Each chunk becomes a section block with type: "mrkdwn".
 */
function buildBlocks(mrkdwn: string): Array<Record<string, unknown>> {
	const chunks = splitIntoChunks(mrkdwn, BLOCK_TEXT_LIMIT);
	return chunks.map((chunk) => ({
		type: "section",
		text: {
			type: "mrkdwn",
			text: chunk,
		},
	}));
}

/**
 * Post a message directly to Slack via Bot Token API.
 * Automatically converts Markdown to Slack mrkdwn format
 * and uses Block Kit for proper rendering.
 * Falls back gracefully if token or channel is missing.
 */
export async function postToSlack(text: string, options: { botToken: string; channelId: string }): Promise<boolean> {
	const { botToken, channelId } = options;

	if (!botToken || !channelId) {
		log.warn("SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not configured, skipping Slack push");
		return false;
	}

	const mrkdwn = markdownToSlackMrkdwn(text);
	const blocks = buildBlocks(mrkdwn);

	try {
		const response = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${botToken}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				channel: channelId,
				text: mrkdwn.substring(0, 200), // Fallback text for notifications
				blocks,
				unfurl_links: false,
				unfurl_media: false,
			}),
		});

		const result = (await response.json()) as SlackPostResult;

		if (!result.ok) {
			log.error({ error: result.error }, "Slack API returned error");
			return false;
		}

		log.info({ channel: channelId, ts: result.ts }, "Message posted to Slack");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error({ error: message }, "Failed to post to Slack");
		return false;
	}
}
