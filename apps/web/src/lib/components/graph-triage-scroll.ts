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
// `atBottom` is deliberately the same question pi-fleet-scroll.ts asks, and this module
// reuses its isAtBottom/BOTTOM_SLACK_PX rather than restating the tolerance: a reader
// within the slack of the end is following the pane, anyone further up is reading
// something older and is left alone until they come back.
//
// Nothing running (between nodes, or before the turn starts) is not a reason to move.
export function shouldRevealRunning(change: {
	runningChanged: boolean;
	hasRunning: boolean;
	atBottom: boolean;
}): boolean {
	return change.hasRunning && change.runningChanged && change.atBottom;
}
