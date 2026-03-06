import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBtcOpenInterest, fetchBtcPrice } from "../../src/collectors/binance.js";

describe("Binance API client", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("fetchBtcPrice", () => {
		it("parses valid price response", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(JSON.stringify({ symbol: "BTCUSDT", price: "72499.98" }), { status: 200 }),
			);

			const result = await fetchBtcPrice();

			expect(result).not.toBeNull();
			expect(result!.price).toBe(72499.98);
			expect(result!.date).toBeTruthy();
		});

		it("returns null on invalid price", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(JSON.stringify({ symbol: "BTCUSDT", price: "invalid" }), { status: 200 }),
			);

			const result = await fetchBtcPrice();
			expect(result).toBeNull();
		});

		it("returns null after retries exhausted", async () => {
			vi.spyOn(globalThis, "fetch")
				.mockRejectedValueOnce(new Error("timeout"))
				.mockRejectedValueOnce(new Error("timeout"))
				.mockRejectedValueOnce(new Error("timeout"));

			const result = await fetchBtcPrice();
			expect(result).toBeNull();
		});
	});

	describe("fetchBtcOpenInterest", () => {
		it("parses valid OI response", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(JSON.stringify({ symbol: "BTCUSDT", openInterest: "89444.951", time: 1709654400000 }), {
					status: 200,
				}),
			);

			const result = await fetchBtcOpenInterest();

			expect(result).not.toBeNull();
			expect(result!.openInterest).toBe(89444.951);
			expect(result!.date).toBeTruthy();
		});

		it("returns null on HTTP error after retries", async () => {
			vi.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(new Response("", { status: 500 }))
				.mockResolvedValueOnce(new Response("", { status: 502 }))
				.mockResolvedValueOnce(new Response("", { status: 503 }));

			const result = await fetchBtcOpenInterest();
			expect(result).toBeNull();
		});
	});
});
