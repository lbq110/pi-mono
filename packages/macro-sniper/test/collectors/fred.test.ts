import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFredCache, fetchFredSeries, resetFredRequestCount } from "../../src/collectors/fred.js";

describe("FRED API client", () => {
	beforeEach(() => {
		clearFredCache();
		resetFredRequestCount();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses valid FRED response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					observations: [
						{ date: "2025-03-05", value: "7550000" },
						{ date: "2025-03-04", value: "7540000" },
					],
				}),
				{ status: 200 },
			),
		);

		const result = await fetchFredSeries({ seriesId: "WALCL", apiKey: "test-key", limit: 2 });

		expect(result).toHaveLength(2);
		expect(result[0].date).toBe("2025-03-05");
		expect(result[0].value).toBe(7550000);
	});

	it("filters out missing values (dot notation)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					observations: [
						{ date: "2025-03-05", value: "5.33" },
						{ date: "2025-03-04", value: "." },
						{ date: "2025-03-03", value: "5.31" },
					],
				}),
				{ status: 200 },
			),
		);

		const result = await fetchFredSeries({ seriesId: "SOFR", apiKey: "test-key" });

		expect(result).toHaveLength(2);
		expect(result.every((r) => typeof r.value === "number")).toBe(true);
	});

	it("returns empty array on empty response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ observations: [] }), { status: 200 }),
		);

		const result = await fetchFredSeries({ seriesId: "WALCL", apiKey: "test-key" });
		expect(result).toHaveLength(0);
	});

	it("retries on failure and eventually throws", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("network error"))
			.mockRejectedValueOnce(new Error("network error"))
			.mockRejectedValueOnce(new Error("network error"));

		await expect(fetchFredSeries({ seriesId: "WALCL", apiKey: "test-key" })).rejects.toThrow("network error");
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("retries on HTTP error then succeeds", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("", { status: 500 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ observations: [{ date: "2025-03-05", value: "100" }] }), { status: 200 }),
			);

		const result = await fetchFredSeries({ seriesId: "TEST", apiKey: "test-key" });
		expect(result).toHaveLength(1);
		expect(result[0].value).toBe(100);
	});

	it("uses cache on second call", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ observations: [{ date: "2025-03-05", value: "42" }] }), { status: 200 }),
			);

		await fetchFredSeries({ seriesId: "CACHED", apiKey: "test-key" });
		await fetchFredSeries({ seriesId: "CACHED", apiKey: "test-key" });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
