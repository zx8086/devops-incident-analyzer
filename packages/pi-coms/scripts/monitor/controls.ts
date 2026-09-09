// scripts/monitor/controls.ts

// Operator controls that survive a monitor restart: whether findings are
// sent to the account's Pi agent at all, and whether the check cycles run.
// They live in the snapshots table so no schema change is needed (SIO-1673).

export type MonitorControls = {
	investigate: boolean;
	investigateReason: string;
	investigateSince: string;
	paused: boolean;
	pausedReason: string;
	pausedSince: string;
};

export type ControlCommand =
	| { kind: "investigate"; on: boolean; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "resume" };

export type ControlStore = {
	getSnapshot(name: string): Record<string, string> | null;
	setSnapshot(name: string, v: Record<string, string>): void;
};

export const CONTROLS_SNAPSHOT = "controls";

// Kill-switch idiom shared with the analyzer's capability flags: only an
// explicit "false" or "0" turns the default off.
export function envInvestigateDefault(v: string | undefined): boolean {
	return v !== "false" && v !== "0";
}

export function parseControlCommand(raw: string): ControlCommand | null {
	const trimmed = raw.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "resume") return { kind: "resume" };
	if (lower === "pause" || lower.startsWith("pause ")) {
		return { kind: "pause", reason: trimmed.slice("pause".length).trim() };
	}
	if (lower.startsWith("investigate ")) {
		const rest = trimmed.slice("investigate ".length).trim();
		const [word, ...reasonParts] = rest.split(/\s+/);
		const state = (word ?? "").toLowerCase();
		if (state !== "on" && state !== "off") return null;
		return { kind: "investigate", on: state === "on", reason: reasonParts.join(" ") };
	}
	return null;
}

// The env value is the boot default only; a persisted control always wins.
export function readControls(store: ControlStore, defaults: { investigate: boolean }): MonitorControls {
	const snap = store.getSnapshot(CONTROLS_SNAPSHOT);
	return {
		investigate: snap?.investigate === undefined ? defaults.investigate : snap.investigate === "on",
		investigateReason: snap?.investigate_reason ?? "",
		investigateSince: snap?.investigate_since ?? "",
		paused: snap?.paused === "1",
		pausedReason: snap?.paused_reason ?? "",
		pausedSince: snap?.paused_since ?? "",
	};
}

export function applyControl(
	store: ControlStore,
	current: MonitorControls,
	cmd: ControlCommand,
	now: Date = new Date(),
): MonitorControls {
	const ts = now.toISOString();
	let next: MonitorControls;
	switch (cmd.kind) {
		case "investigate":
			next = { ...current, investigate: cmd.on, investigateReason: cmd.reason, investigateSince: ts };
			break;
		case "pause":
			next = { ...current, paused: true, pausedReason: cmd.reason, pausedSince: ts };
			break;
		case "resume":
			next = { ...current, paused: false, pausedReason: "", pausedSince: ts };
			break;
	}
	store.setSnapshot(CONTROLS_SNAPSHOT, {
		investigate: next.investigate ? "on" : "off",
		investigate_reason: next.investigateReason,
		investigate_since: next.investigateSince,
		paused: next.paused ? "1" : "0",
		paused_reason: next.pausedReason,
		paused_since: next.pausedSince,
	});
	return next;
}

const withReason = (reason: string, since: string): string => {
	const parts = [reason, since ? `since ${since}` : ""].filter(Boolean);
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
};

export function describeControls(c: MonitorControls): string {
	const inv = c.investigate ? "on" : `off${withReason(c.investigateReason, c.investigateSince)}`;
	const paused = c.paused ? `yes${withReason(c.pausedReason, c.pausedSince)}` : "no";
	return `investigate: ${inv}, paused: ${paused}`;
}

export function investigationDisabledFailure(c: MonitorControls): string {
	return `investigation disabled by operator${c.investigateReason ? `: ${c.investigateReason}` : ""}`;
}
