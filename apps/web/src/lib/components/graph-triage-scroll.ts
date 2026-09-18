// apps/web/src/lib/components/graph-triage-scroll.ts
// SIO-1812: when the triage pane brings the running node into view. Kept apart from
// GraphTriagePanel.svelte for the same reason as pi-fleet-scroll.ts (SIO-1800): the
// scroll itself is browser-only, and this is the part that can be tested.

// The incident graph is 32 nodes tall, so the running node leaves the viewport within a
// few rows. The pane calls itself "a map of a turn in flight" -- a map you have to scroll
// by hand to follow the moving part is not one.

// A node id, or "" when nothing is running. Several branches can share a node name during
// a fan-out, so the FIRST active id is the one to follow: activeNodes is insertion-ordered
// and the earliest entry is the branch that has been running longest, which keeps the view
// anchored instead of flicking between parallel Sends.
export function runningFingerprint(activeNodes: ReadonlyMap<string, number>): string {
	for (const id of activeNodes.keys()) return id;
	return "";
}

// Follow the turn, but never take the view from someone who is reading.
//
// `following` is explicit state, NOT "is the scroller near the bottom" (Greptile, PR
// #843). Borrowing pi-fleet-scroll's isAtBottom looked right -- same question, same
// tolerance -- but the fleet pane APPENDS, so there "following" and "at the bottom" are
// the same position. This pane CENTRES a node in a 32-node graph, so right after the very
// first reveal the scroller sits mid-content and an at-bottom test reads false. Following
// would switch itself off after one node and stay off for the rest of the turn. Measured,
// not reasoned: centring node 5 of 32 leaves scrollTop 120 in a 2400px scroller, which
// isAtBottom rejects.
//
// The panel owns the flag: it starts true, a scroll the panel did not cause clears it, and
// returning to the bottom sets it again.
//
// Nothing running (between nodes, or before the turn starts) is not a reason to move.
export function shouldRevealRunning(change: {
	runningChanged: boolean;
	hasRunning: boolean;
	following: boolean;
}): boolean {
	return change.hasRunning && change.runningChanged && change.following;
}
