import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("auth");

const AUTH_FILE = "/root/.pi/agent/auth.json";

/** Buffer before actual expiry to trigger refresh (5 minutes) */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Anthropic OAuth token exchange endpoint */
const TOKEN_ENDPOINT = "https://auth.anthropic.com/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44e4-8f00-c755e0660581";

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
 * Refresh the Anthropic OAuth access token using the refresh token.
 * Returns the new access token, or null on failure.
 */
async function refreshAccessToken(refreshToken: string): Promise<{ access: string; expires: number } | null> {
	try {
		log.info("Refreshing Anthropic OAuth access token");
		const response = await fetch(TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			log.error({ status: response.status, body: body.slice(0, 200) }, "Token refresh failed");
			return null;
		}

		const data = (await response.json()) as {
			access_token: string;
			expires_in: number;
			refresh_token?: string;
		};

		const expires = Date.now() + data.expires_in * 1000;
		log.info({ expiresIn: data.expires_in }, "Access token refreshed");

		// Update auth file with new tokens
		const auth = readAuthFile();
		if (auth) {
			auth.anthropic.access = data.access_token;
			auth.anthropic.expires = expires;
			if (data.refresh_token) {
				auth.anthropic.refresh = data.refresh_token;
			}
			writeAuthFile(auth);
		}

		return { access: data.access_token, expires };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log.error({ error: msg }, "Token refresh error");
		return null;
	}
}

/**
 * Get a valid Anthropic OAuth access token.
 * - If token is still valid, return it.
 * - If expired or about to expire, try to refresh.
 * - Returns null if no token available or refresh fails.
 */
export async function getAnthropicToken(): Promise<string | null> {
	const auth = readAuthFile();
	if (!auth?.anthropic) return null;

	const { access, expires, refresh } = auth.anthropic;

	// Token still valid (with buffer)
	if (Date.now() < expires - EXPIRY_BUFFER_MS) {
		return access;
	}

	// Try to refresh
	log.info("Access token expired or about to expire, refreshing");
	const refreshed = await refreshAccessToken(refresh);
	if (refreshed) {
		return refreshed.access;
	}

	// Refresh failed — token is dead
	return null;
}

/**
 * Check if Anthropic token is available and valid (without refreshing).
 * Used for quick checks.
 */
export function isAnthropicTokenValid(): boolean {
	const auth = readAuthFile();
	if (!auth?.anthropic) return false;
	return Date.now() < auth.anthropic.expires - EXPIRY_BUFFER_MS;
}
