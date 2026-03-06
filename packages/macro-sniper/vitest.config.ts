import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		extensions: [".ts", ".js"],
	},
	test: {
		globals: false,
		testTimeout: 30_000,
	},
});
