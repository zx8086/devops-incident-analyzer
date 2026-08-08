// packages/agent/src/eval/example-ticket-filter.ts
// SIO-1454: pure helper behind run-incident-replay-eval.ts's --ticket flag. Lives outside the
// CLI because that script starts an eval at import time, so anything unit-testable must not
// require importing it. ticketKey is stamped on every dataset example's metadata since SIO-1378.

import { z } from "zod";

export interface TicketFilterableExample {
	metadata?: Record<string, unknown>;
}

// CodeRabbit (PR #643): metadata arrives untyped from the LangSmith SDK, so the key is Zod-parsed
// at this boundary per the repo-wide validation rule; a non-string ticketKey reads as absent.
const TicketKeySchema = z.string().optional();

function parsedTicketKey(example: TicketFilterableExample): string | undefined {
	const parsed = TicketKeySchema.safeParse(example.metadata?.ticketKey);
	return parsed.success ? parsed.data : undefined;
}

export function filterExamplesByTicket<T extends TicketFilterableExample>(
	examples: T[],
	ticketKey: string,
): { matched: T[]; availableTicketKeys: string[] } {
	const matched = examples.filter((e) => parsedTicketKey(e) === ticketKey);
	const availableTicketKeys = [
		...new Set(examples.map((e) => parsedTicketKey(e)).filter((k): k is string => k !== undefined)),
	].sort();
	return { matched, availableTicketKeys };
}
