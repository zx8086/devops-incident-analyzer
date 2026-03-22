/* src/utils/helpers.ts */

/**
 * Utility function to pause execution
 * @param ms Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
