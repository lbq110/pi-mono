import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isDev = process.env.APP_ENV !== "production";

export const logger = pino({
	level,
	...(isDev
		? {
				transport: {
					target: "pino-pretty",
					options: { colorize: true },
				},
			}
		: {}),
});

export type ModuleName = "collector" | "analyzer" | "reporter" | "notification" | "job" | "cli" | "db";

export function createChildLogger(module: ModuleName) {
	return logger.child({ module });
}
