import type { OVConfig } from "./config.js";

/** A single memory result from a find query. */
export interface MemoryItem {
	uri: string;
	relevance: number;
	summary: string;
}

/** Formatted result from find(). */
export interface FindResult {
	found: number;
	memories: MemoryItem[];
}

/** Raw response envelope from OpenViking REST API. */
interface OVResponse<T> {
	status: string;
	result: T;
}

/** HTTP client for the OpenViking REST API.
 *
 * Uses native fetch with AbortController-based timeouts.
 * All methods degrade gracefully: callers should handle thrown errors.
 */
export class OVClient {
	private readonly baseUrl: string;
	private readonly apiKey: string | null;
	private readonly timeout: number;

	constructor(config: OVConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.apiKey = config.apiKey;
		this.timeout = config.timeout;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		queryParams?: Record<string, string>,
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeout);

		try {
			let url = `${this.baseUrl}${path}`;
			if (queryParams && Object.keys(queryParams).length > 0) {
				url += `?${new URLSearchParams(queryParams).toString()}`;
			}

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (this.apiKey) {
				headers.Authorization = `Bearer ${this.apiKey}`;
			}

			const response = await fetch(url, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText} — ${method} ${path}`);
			}

			const json = (await response.json()) as OVResponse<T>;
			return json.result;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Returns true when OpenViking is reachable and healthy. */
	async health(): Promise<boolean> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			const response = await fetch(`${this.baseUrl}/health`, {
				signal: controller.signal,
			});
			return response.ok;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Create a new session and return its ID. */
	async createSession(): Promise<{ session_id: string }> {
		return this.request<{ session_id: string }>("POST", "/api/v1/sessions");
	}

	/** Append a message to an existing session. */
	async addMessage(sessionId: string, role: string, content: string): Promise<void> {
		await this.request("POST", `/api/v1/sessions/${sessionId}/messages`, {
			role,
			content,
		});
	}

	/** Commit a session, triggering memory extraction.
	 * Returns the number of memories extracted (if reported by the server).
	 */
	async commitSession(sessionId: string): Promise<{ memories_extracted?: number }> {
		return this.request<{ memories_extracted?: number }>("POST", `/api/v1/sessions/${sessionId}/commit`);
	}

	/** Semantic search across the memory store.
	 * @param query - Natural language query
	 * @param options.targetUri - Scope URI (e.g. "viking://user/memories/preferences/"), or "" for global
	 * @param options.limit - Maximum results to return (default 10)
	 * @param options.scoreThreshold - Minimum relevance score (0–1)
	 */
	async find(
		query: string,
		options?: {
			targetUri?: string;
			limit?: number;
			scoreThreshold?: number | null;
		},
	): Promise<FindResult> {
		const raw = await this.request<unknown>("POST", "/api/v1/search/find", {
			query,
			target_uri: options?.targetUri ?? "",
			limit: options?.limit ?? 10,
			score_threshold: options?.scoreThreshold ?? null,
		});
		return normalizeFindResult(raw);
	}

	/** List the contents of a Viking URI (directory listing). */
	async ls(uri: string): Promise<unknown[]> {
		return this.request<unknown[]>("GET", "/api/v1/fs/ls", undefined, {
			uri,
			output: "agent",
		});
	}

	/** Add a local file or directory to the OpenViking knowledge base. */
	async addResource(path: string, reason = "", instruction = "", wait = false): Promise<unknown> {
		return this.request<unknown>("POST", "/api/v1/resources", {
			path,
			reason,
			instruction,
			wait,
		});
	}
}

/** Normalise the various result shapes that OpenViking may return from /find.
 *
 * OV server returns: { memories: [...], resources: [...], skills: [...], total: N }
 * We merge all result types into a flat list of MemoryItem.
 */
function normalizeFindResult(raw: unknown): FindResult {
	if (!raw || typeof raw !== "object") {
		return { found: 0, memories: [] };
	}

	let items: unknown[];

	if (Array.isArray(raw)) {
		// Older or direct array format
		items = raw;
	} else {
		const r = raw as Record<string, unknown>;
		// OV server format: { memories, resources, skills, total }
		const memoriesArr = Array.isArray(r.memories) ? (r.memories as unknown[]) : [];
		const resourcesArr = Array.isArray(r.resources) ? (r.resources as unknown[]) : [];
		const skillsArr = Array.isArray(r.skills) ? (r.skills as unknown[]) : [];

		if (memoriesArr.length > 0 || resourcesArr.length > 0 || skillsArr.length > 0) {
			items = [...memoriesArr, ...resourcesArr, ...skillsArr];
		} else {
			// Fallback for other shapes
			const candidate = r.items ?? r.results ?? r.hits ?? [];
			items = Array.isArray(candidate) ? candidate : [];
		}
	}

	const memories: MemoryItem[] = items
		.map((item) => {
			const i = (item ?? {}) as Record<string, unknown>;
			return {
				uri: String(i.uri ?? i.path ?? ""),
				relevance: Number(i.score ?? i.relevance ?? 0),
				summary: String(i.abstract ?? i.summary ?? i.content ?? i.text ?? ""),
			};
		})
		// Filter out low-relevance directory entries (score < 0.3 typically means just a folder match)
		.filter((m) => m.relevance >= 0.3 || m.uri.endsWith(".md") || m.uri.endsWith(".txt"));

	return { found: memories.length, memories };
}
