// extensions/inboundPolicy.ts

// What to do with an inbound hub prompt before it can become a model turn.
// Every turn on a spoke is a full read of its context; automated senders
// (monitor investigations, analyzer verifications) carry a response schema
// and must not be able to wake the agent without limit (SIO-1673).

export type InboundDecision = { kind: "turn" } | { kind: "notice" } | { kind: "refuse"; reason: string };

export type InboundFacts = {
	senderName: string;
	mailbox: boolean;
	hasSchema: boolean;
	// Percent of the context window in use; null right after a compaction.
	contextPct: number | null;
	mutePatterns: string[];
	refuseAbovePct: number;
};

export function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

export function parseMutePatterns(v: string | undefined): string[] {
	return (v ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function decideInbound(f: InboundFacts): InboundDecision {
	if (f.mailbox) return { kind: "notice" };
	for (const pattern of f.mutePatterns) {
		if (globToRegExp(pattern).test(f.senderName)) {
			return { kind: "refuse", reason: `recipient muted (${pattern})` };
		}
	}
	// A human prompt never carries a schema and always gets a turn; the rail
	// only holds back automated callers once the window is nearly full.
	if (f.hasSchema && f.contextPct !== null && f.contextPct >= f.refuseAbovePct) {
		return {
			kind: "refuse",
			reason: `recipient context at ${Math.round(f.contextPct)}%, refusing investigation`,
		};
	}
	return { kind: "turn" };
}
