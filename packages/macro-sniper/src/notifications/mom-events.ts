import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("notification");

/**
 * Write a mom immediate event JSON file to trigger Slack push.
 * The mom module watches the events directory and forwards to the specified Slack channel.
 */
export function notifyViaMom(text: string, filename: string, options: { eventsDir: string; channelId: string }): void {
	const { eventsDir, channelId } = options;

	if (!eventsDir || !channelId) {
		log.warn("MOM_EVENTS_DIR or MOM_CHANNEL_ID not configured, skipping notification");
		return;
	}

	if (!existsSync(eventsDir)) {
		mkdirSync(eventsDir, { recursive: true });
	}

	const event = {
		type: "immediate",
		channelId,
		text,
	};

	const filePath = join(eventsDir, `${filename}.json`);
	writeFileSync(filePath, JSON.stringify(event));
	log.info({ filePath }, "Mom event written");
}
