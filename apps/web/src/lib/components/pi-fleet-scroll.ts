// apps/web/src/lib/components/pi-fleet-scroll.ts
// SIO-1800: when the fleet pane brings its newest entry into view. The decision is kept
// apart from PiFleetPane.svelte because the scroll itself is browser-only and this is the
// part that can be tested.

// A reader this close to the end is following the pane, not reading something older.
export const BOTTOM_SLACK_PX = 24;

export function isAtBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
	return el.scrollHeight - el.clientHeight - el.scrollTop <= BOTTOM_SLACK_PX;
}

// Changes whenever the newest entry is replaced or its result arrives. The response is
// reduced to present/absent: its content never changes once set, and it can be large.
export function newestFingerprint(
	entries: ReadonlyArray<{ id: string; status: string; response: unknown; error: string | null }>,
): string {
	const last = entries.at(-1);
	if (!last) return "";
	return `${last.id}|${last.status}|${last.response == null ? 0 : 1}|${last.error == null ? 0 : 1}`;
}

// SIO-1794 kept: a NEW entry is always revealed, and a reader who scrolled up is never
// moved by a status patch or an arriving result. SIO-1800 adds the one missing case: an
// entry is added as a short "Waiting" stub, so the scroll-on-add fired before the reply
// existed, and the reply then landed below the fold (108 px and 81 px hidden, measured
// live) for a reader who was sitting at the bottom waiting for exactly that reply.
export function shouldRevealNewest(change: {
	countGrew: boolean;
	newestChanged: boolean;
	wasAtBottom: boolean;
}): boolean {
	return change.countGrew || (change.newestChanged && change.wasAtBottom);
}
