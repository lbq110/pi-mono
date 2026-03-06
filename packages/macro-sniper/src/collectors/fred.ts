import { createChildLogger } from "../logger.js";

const log = createChildLogger("collector");

const FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/** In-memory cache to avoid redundant API calls within the same process. */
const cache = new Map<string, { data: FredObservation[]; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let requestCount = 0;

export interface FredObservation {
	date: string;
	value: number;
}

export interface FredFetchOptions {
	seriesId: string;
	apiKey: string;
	observationStart?: string;
	observationEnd?: string;
	limit?: number;
}

/** Get total request count for this process (useful for monitoring rate limits). */
export function getFredRequestCount(): number {
	return requestCount;
}

/** Reset request counter (for testing). */
export function resetFredRequestCount(): void {
	requestCount = 0;
}

/** Clear the in-memory cache (for testing). */
export function clearFredCache(): void {
	cache.clear();
}

/**
 * Fetch observations from the FRED API for a given series.
 * Includes retry with exponential backoff, in-memory caching, and request counting.
 */
export async function fetchFredSeries(options: FredFetchOptions): Promise<FredObservation[]> {
	const { seriesId, apiKey, observationStart, observationEnd, limit } = options;

	// Check cache
	const cacheKey = `${seriesId}:${observationStart ?? ""}:${observationEnd ?? ""}:${limit ?? ""}`;
	const cached = cache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		log.debug({ seriesId }, "FRED cache hit");
		return cached.data;
	}

	const params = new URLSearchParams({
		series_id: seriesId,
		api_key: apiKey,
		file_type: "json",
		sort_order: "desc",
	});
	if (observationStart) params.set("observation_start", observationStart);
	if (observationEnd) params.set("observation_end", observationEnd);
	if (limit) params.set("limit", String(limit));

	const url = `${FRED_BASE_URL}?${params.toString()}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			requestCount++;
			log.debug({ seriesId, attempt }, "Fetching FRED series");

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`FRED API returned ${response.status}: ${response.statusText}`);
			}

			const json = (await response.json()) as { observations: { date: string; value: string }[] };
			const observations: FredObservation[] = json.observations
				.filter((obs) => obs.value !== ".")
				.map((obs) => ({
					date: obs.date,
					value: Number.parseFloat(obs.value),
				}));

			// Store in cache
			cache.set(cacheKey, { data: observations, timestamp: Date.now() });

			log.debug({ seriesId, count: observations.length }, "FRED series fetched");
			return observations;
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			// Sanitize error message: never log the API key
			const message = error instanceof Error ? error.message : String(error);
			log.warn(
				{ seriesId, attempt, error: message },
				isLastAttempt ? "FRED fetch failed permanently" : "FRED fetch failed, retrying",
			);

			if (isLastAttempt) throw error;

			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	// Unreachable, but TypeScript needs it
	return [];
}
