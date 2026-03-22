// agent/src/tool-retry.ts
import { getLogger } from "@devops-agent/observability";

const logger = getLogger("tool-retry");

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export async function withRetry<T>(
	fn: () => Promise<T>,
	options: { maxRetries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt === maxRetries) {
				logger.error({ error, label: options.label, attempts: attempt + 1 }, "All retries exhausted");
				throw error;
			}

			const delay = baseDelay * 2 ** attempt;
			logger.warn({ error, label: options.label, attempt: attempt + 1, nextDelayMs: delay }, "Retrying after failure");
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw new Error("Unreachable");
}
