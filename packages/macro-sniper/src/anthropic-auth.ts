import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { refreshAnthropicToken } from "@mariozechner/pi-ai";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("auth");

const AUTH_FILE = "/root/.pi/agent/auth.json";

/** Buffer before actual expiry to trigger refresh (5 minutes) */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface AuthData {
	anthropic: {
		type: "oauth";
		refresh: string;
		access: string;
		expires: number;
	};
}

function readAuthFile(): AuthData | null {
	if (!existsSync(AUTH_FILE)) return null;
	try {
		return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as AuthData;
	} catch {
		return null;
	}
}

function writeAuthFile(data: AuthData): void {
	writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Get a valid Anthropic OAuth access token.
 *
 * Reads from pi's auth.json. If the token is expired or about to expire,
 * refreshes it using pi-ai's refreshAnthropicToken (same endpoint pi uses).
 * Updates auth.json with the new token on successful refresh.
 * Returns null if no token available or refresh fails.
 */
export async function getAnthropicToken(): Promise<string | null> {
	const auth = readAuthFile();
	if (!auth?.anthropic) {
		log.warn("No Anthropic auth data in auth.json");
		return null;
	}

	const { access, expires, refresh } = auth.anthropic;

	// Token still valid (with buffer)
	if (Date.now() < expires - EXPIRY_BUFFER_MS) {
		return access;
	}

	// Token expired or about to expire — refresh using pi-ai's function
	try {
		log.info("Anthropic OAuth token expired or about to expire, refreshing");
		const refreshed = await refreshAnthropicToken(refresh);

		// Update auth.json with new tokens
		auth.anthropic.access = refreshed.access;
		auth.anthropic.expires = refreshed.expires;
		auth.anthropic.refresh = refreshed.refresh;
		writeAuthFile(auth);

		log.info({ expiresAt: new Date(refreshed.expires).toISOString() }, "Anthropic OAuth token refreshed");
		return refreshed.access;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log.error({ error: msg }, "Anthropic OAuth token refresh failed");
		return null;
	}
}

/**
 * Check if Anthropic token is available and valid.
 */
export function isAnthropicTokenValid(): boolean {
	const auth = readAuthFile();
	if (!auth?.anthropic) return false;
	return Date.now() < auth.anthropic.expires - EXPIRY_BUFFER_MS;
}
