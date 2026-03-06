import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("job");

export interface JobRunRecord {
	id: number;
	job: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
	durationMs: number | null;
}

/** Record the start of a job run. Returns the inserted row ID. */
export function startJobRun(db: Db, job: string): number {
	const result = db
		.insert(jobRuns)
		.values({
			job,
			status: "running",
			startedAt: new Date().toISOString(),
		})
		.run();

	const id = Number(result.lastInsertRowid);
	log.info({ job, runId: id }, "Job started");
	return id;
}

/** Record the completion of a job run. */
export function finishJobRun(db: Db, runId: number, status: "success" | "error" | "skipped", error?: string): void {
	const now = new Date().toISOString();

	// Read the start time to compute duration
	const rows = db.select().from(jobRuns).where(eq(jobRuns.id, runId)).all();
	const run = rows[0];
	const durationMs = run ? Date.now() - new Date(run.startedAt).getTime() : null;

	db.update(jobRuns)
		.set({
			status,
			finishedAt: now,
			error: error ?? null,
			durationMs,
		})
		.where(eq(jobRuns.id, runId))
		.run();

	log.info({ runId, status, durationMs }, "Job finished");
}

/** Get recent job runs for a given job name. */
export function getRecentJobRuns(db: Db, job: string, limit = 10): JobRunRecord[] {
	const rows = db
		.select()
		.from(jobRuns)
		.where(eq(jobRuns.job, job))
		.orderBy(desc(jobRuns.startedAt))
		.limit(limit)
		.all();

	return rows.map((r) => ({
		id: r.id,
		job: r.job,
		status: r.status,
		startedAt: r.startedAt,
		finishedAt: r.finishedAt,
		error: r.error,
		durationMs: r.durationMs,
	}));
}
