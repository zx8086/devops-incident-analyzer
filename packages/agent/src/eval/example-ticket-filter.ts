// packages/agent/src/eval/example-ticket-filter.ts
// SIO-1454: pure helper behind run-incident-replay-eval.ts's --ticket flag. Lives outside the
// CLI because that script starts an eval at import time, so anything unit-testable must not
// require importing it. ticketKey is stamped on every dataset example's metadata since SIO-1378.

export interface TicketFilterableExample {
	metadata?: Record<string, unknown>;
}

export function filterExamplesByTicket<T extends TicketFilterableExample>(
	examples: T[],
	ticketKey: string,
): { matched: T[]; availableTicketKeys: string[] } {
	const matched = examples.filter((e) => e.metadata?.ticketKey === ticketKey);
	const availableTicketKeys = [
		...new Set(examples.map((e) => e.metadata?.ticketKey).filter((k): k is string => typeof k === "string")),
	].sort();
	return { matched, availableTicketKeys };
}
