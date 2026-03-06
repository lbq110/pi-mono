/**
 * Compute rolling change over N days.
 * Values should be sorted by date ascending (oldest first).
 * Returns the difference between the last and first values, or null if insufficient data.
 */
export function computeRollingChange(values: number[], windowDays: number): number | null {
	if (values.length < windowDays + 1) return null;
	const latest = values[values.length - 1];
	const nAgo = values[values.length - 1 - windowDays];
	return latest - nAgo;
}

/**
 * Compute simple moving average over the last N values.
 * Values should be sorted by date ascending (oldest first).
 * Returns null if insufficient data.
 */
export function computeMovingAverage(values: number[], window: number): number | null {
	if (values.length < window) return null;
	const slice = values.slice(-window);
	const sum = slice.reduce((a, b) => a + b, 0);
	return sum / window;
}
