import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createChildLogger } from "../logger.js";
import * as schema from "./schema.js";

const log = createChildLogger("db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Get or create the database connection.
 * For testing, pass `:memory:` as the path.
 */
export function getDb(dbPath?: string): Db {
	if (_db) return _db;

	const path = dbPath ?? process.env.DATABASE_PATH ?? "./data/macro-sniper.db";
	log.info({ path }, "Opening database");

	_sqlite = new Database(path);
	_sqlite.pragma("journal_mode = WAL");
	_sqlite.pragma("foreign_keys = ON");

	_db = drizzle(_sqlite, { schema });
	return _db;
}

/** Close the database connection (for graceful shutdown). */
export function closeDb(): void {
	if (_sqlite) {
		_sqlite.close();
		_sqlite = null;
		_db = null;
		log.info("Database connection closed");
	}
}

/** Reset the singleton (for testing). */
export function resetDb(): void {
	closeDb();
}
