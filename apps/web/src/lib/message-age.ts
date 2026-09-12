// apps/web/src/lib/message-age.ts
// SIO-1729: the inbox rendered `message.status`, which is the delivery lifecycle
// of a prompt that expects a reply. A monitor report expects none, so nothing
// ever claims it and every row reads "queued" forever -- observed live: 11 of 11
// messages queued, the newest digest 15 hours old and still labelled as though
// it were pending work. The status carried no information and implied the wrong
// one (something not yet done).
//
// What an operator actually needs off that row is HOW OLD the report is. Status
// is still shown when it is genuinely exceptional (error/timeout).

// Delivery states that say nothing useful for a one-way report: nothing ever
// claims it, so it sits in these forever.
const UNINFORMATIVE = new Set(["queued", "delivered", "complete"]);

export function isNotableStatus(status: string): boolean {
	return !UNINFORMATIVE.has(status);
}

/**
 * Compact age for an inbox row: "just now", "14m", "3h", "2d".
 *
 * Returns "" for a missing or unparseable timestamp so the caller renders
 * nothing rather than "NaN" — an inbox row must never show a broken value.
 */
export function messageAge(createdAt: string | null | undefined, now = Date.now()): string {
	if (!createdAt) return "";
	const t = Date.parse(createdAt);
	if (Number.isNaN(t)) return "";
	const mins = Math.floor((now - t) / 60_000);
	// A clock skewed slightly ahead of the hub must not render "-3m".
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
