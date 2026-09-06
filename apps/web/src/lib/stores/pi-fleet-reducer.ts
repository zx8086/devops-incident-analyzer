// apps/web/src/lib/stores/pi-fleet-reducer.ts
// SIO-1650: pure state transitions for the pi-fleet pane. The runes store in
// pi-fleet.svelte.ts only fetches and applies these, so the logic is testable.
import type {
	PiFleetAgentsResponse,
	PiFleetEnvironment,
	PiFleetHub,
	PiFleetMailboxResponse,
	PiFleetMessageResponse,
	PiFleetMessageStatus,
	PiFleetMessageStatusResponse,
	PiFleetPeer,
} from "../pi-fleet-types.ts";

export type PiFleetPeerRow = PiFleetPeer & { environment: PiFleetEnvironment; project: string };
export type PiFleetSelection = { environment: PiFleetEnvironment; name: string };

// Local statuses on top of the hub's: sending (no msgId yet), failed (the route
// or hub refused the send), expired (the pane budget ran out while waiting).
export type PiFleetEntryStatus = PiFleetMessageStatus | "sending" | "failed" | "expired";

export type PiFleetEntry = {
	id: string;
	environment: PiFleetEnvironment;
	target: string;
	prompt: string;
	msgId: string | null;
	sender: string | null;
	sentAt: number;
	status: PiFleetEntryStatus;
	response: unknown;
	error: string | null;
};

export type PiFleetState = {
	configured: boolean;
	loaded: boolean;
	loadError: string | null;
	awaitMs: number;
	totalBudgetMs: number;
	hubs: PiFleetHub[];
	peers: PiFleetPeerRow[];
	selected: PiFleetSelection | null;
	entries: PiFleetEntry[];
	mailboxes: Partial<Record<PiFleetEnvironment, PiFleetMailboxResponse>>;
};

const ENVIRONMENT_ORDER: Record<PiFleetEnvironment, number> = { dev: 0, stg: 1, prd: 2 };

export function initialPiFleetState(): PiFleetState {
	return {
		configured: false,
		loaded: false,
		loadError: null,
		awaitMs: 25_000,
		totalBudgetMs: 300_000,
		hubs: [],
		peers: [],
		selected: null,
		entries: [],
		mailboxes: {},
	};
}

export function applyAgents(state: PiFleetState, response: PiFleetAgentsResponse): PiFleetState {
	const peers: PiFleetPeerRow[] = response.hubs
		.flatMap((hub) => hub.peers.map((peer) => ({ ...peer, environment: hub.environment, project: hub.project })))
		.sort(
			(a, b) => ENVIRONMENT_ORDER[a.environment] - ENVIRONMENT_ORDER[b.environment] || a.name.localeCompare(b.name),
		);
	const stillListed =
		state.selected !== null &&
		peers.some((p) => p.environment === state.selected?.environment && p.name === state.selected?.name);
	return {
		...state,
		configured: response.configured,
		loaded: true,
		loadError: null,
		awaitMs: response.awaitMs,
		totalBudgetMs: response.totalBudgetMs,
		hubs: response.hubs,
		peers,
		selected: stillListed ? state.selected : null,
	};
}

// A failed refresh keeps the last listing on screen with the reason next to it.
export function applyLoadError(state: PiFleetState, message: string): PiFleetState {
	return { ...state, loaded: true, loadError: message };
}

export function selectPeer(state: PiFleetState, selection: PiFleetSelection | null): PiFleetState {
	return { ...state, selected: selection };
}

export function applyMailbox(state: PiFleetState, response: PiFleetMailboxResponse): PiFleetState {
	return { ...state, mailboxes: { ...state.mailboxes, [response.environment]: response } };
}

export function startEntry(
	state: PiFleetState,
	input: { id: string; environment: PiFleetEnvironment; target: string; prompt: string; sentAt: number },
): PiFleetState {
	const entry: PiFleetEntry = {
		...input,
		msgId: null,
		sender: null,
		status: "sending",
		response: null,
		error: null,
	};
	return { ...state, entries: [entry, ...state.entries] };
}

function updateEntry(state: PiFleetState, id: string, patch: Partial<PiFleetEntry>): PiFleetState {
	return { ...state, entries: state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

export function applySendResult(state: PiFleetState, id: string, response: PiFleetMessageResponse): PiFleetState {
	return updateEntry(state, id, {
		msgId: response.msgId,
		sender: response.sender,
		status: response.status,
		response: response.response,
		error: response.error,
	});
}

export function applyStatus(state: PiFleetState, id: string, response: PiFleetMessageStatusResponse): PiFleetState {
	return updateEntry(state, id, { status: response.status, response: response.response, error: response.error });
}

export function failEntry(state: PiFleetState, id: string, message: string): PiFleetState {
	return updateEntry(state, id, { status: "failed", error: message });
}

export function expireEntry(state: PiFleetState, id: string, totalBudgetMs: number): PiFleetState {
	const entry = state.entries.find((e) => e.id === id);
	const target = entry?.target ?? "the spoke";
	return updateEntry(state, id, {
		status: "expired",
		error: `no reply from ${target} within ${Math.round(totalBudgetMs / 1000)} s`,
	});
}

export function isTerminal(status: PiFleetEntryStatus): boolean {
	return (
		status === "complete" || status === "error" || status === "timeout" || status === "failed" || status === "expired"
	);
}

export function shouldKeepPolling(entry: PiFleetEntry, now: number, totalBudgetMs: number): boolean {
	if (isTerminal(entry.status) || entry.status === "sending" || entry.msgId === null) return false;
	return now - entry.sentAt < totalBudgetMs;
}

// Replies are data: strings verbatim, structured replies as pretty JSON. Nothing
// here is interpreted, executed or handed to an LLM.
export function formatReply(response: unknown): string {
	if (response === null || response === undefined) return "";
	if (typeof response === "string") return response;
	return JSON.stringify(response, null, 2);
}
