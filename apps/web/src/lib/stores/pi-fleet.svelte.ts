// apps/web/src/lib/stores/pi-fleet.svelte.ts
// SIO-1650: runes wrapper around the pure pi-fleet reducer. Fetches the peer
// listing, sends one prompt to the selected spoke and re-polls the message by id
// until the reply is terminal or the pane budget is spent. Replies stay data.
import {
	PiFleetAgentsResponseSchema,
	type PiFleetEnvironment,
	PiFleetMailboxResponseSchema,
	PiFleetMessageResponseSchema,
	PiFleetMessageStatusResponseSchema,
} from "../pi-fleet-types.ts";
import {
	applyAgents,
	applyLoadError,
	applyMailbox,
	applySendResult,
	applyStatus,
	expireEntry,
	failEntry,
	initialPiFleetState,
	isTerminal,
	type PiFleetSelection,
	type PiFleetState,
	selectPeer,
	shouldKeepPolling,
	startEntry,
} from "./pi-fleet-reducer.ts";

const PANE_OPEN_STORAGE_KEY = "pi-fleet-pane-open";

async function readJson(res: Response): Promise<unknown> {
	const body: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		const message =
			typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
				? body.error
				: `request failed (${res.status})`;
		throw new Error(message);
	}
	return body;
}

function createPiFleetStore() {
	let fleet = $state<PiFleetState>(initialPiFleetState());
	let open = $state(false);
	let busy = $state(false);
	let mailboxBusy = $state<PiFleetEnvironment | null>(null);

	async function load() {
		try {
			const body = await readJson(await fetch("/api/pi/agents"));
			const parsed = PiFleetAgentsResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/agents response shape");
			fleet = applyAgents(fleet, parsed.data);
		} catch (error) {
			fleet = applyLoadError(fleet, error instanceof Error ? error.message : String(error));
		}
	}

	function select(selection: PiFleetSelection | null) {
		fleet = selectPeer(fleet, selection);
	}

	async function pollUntilTerminal(id: string) {
		while (true) {
			const entry = fleet.entries.find((e) => e.id === id);
			if (!entry) return;
			if (isTerminal(entry.status)) return;
			if (!shouldKeepPolling(entry, Date.now(), fleet.totalBudgetMs)) {
				fleet = expireEntry(fleet, id, fleet.totalBudgetMs);
				return;
			}
			// The route itself waits one hub slice, so no client-side sleep is needed.
			const params = new URLSearchParams({ environment: entry.environment, msgId: entry.msgId ?? "" });
			const body = await readJson(await fetch(`/api/pi/messages?${params.toString()}`));
			const parsed = PiFleetMessageStatusResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/messages response shape");
			fleet = applyStatus(fleet, id, parsed.data);
		}
	}

	async function send(prompt: string) {
		const selection = fleet.selected;
		const text = prompt.trim();
		if (!selection || text === "" || busy) return;
		const id = crypto.randomUUID();
		fleet = startEntry(fleet, { id, ...selection, target: selection.name, prompt: text, sentAt: Date.now() });
		busy = true;
		try {
			const body = await readJson(
				await fetch("/api/pi/messages", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ environment: selection.environment, target: selection.name, prompt: text }),
				}),
			);
			const parsed = PiFleetMessageResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/messages response shape");
			fleet = applySendResult(fleet, id, parsed.data);
			await pollUntilTerminal(id);
		} catch (error) {
			fleet = failEntry(fleet, id, error instanceof Error ? error.message : String(error));
		} finally {
			busy = false;
		}
	}

	async function loadMailbox(environment: PiFleetEnvironment) {
		mailboxBusy = environment;
		try {
			const body = await readJson(await fetch(`/api/pi/mailbox?environment=${encodeURIComponent(environment)}`));
			const parsed = PiFleetMailboxResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/mailbox response shape");
			fleet = applyMailbox(fleet, parsed.data);
		} catch (error) {
			fleet = applyLoadError(fleet, error instanceof Error ? error.message : String(error));
		} finally {
			mailboxBusy = null;
		}
	}

	function toggle() {
		open = !open;
		try {
			localStorage.setItem(PANE_OPEN_STORAGE_KEY, open ? "1" : "0");
		} catch {
			// Storage unavailable (private mode); the toggle still works for the session.
		}
	}

	// localStorage is absent during SSR; the page calls this from onMount.
	function restoreOpen() {
		try {
			open = localStorage.getItem(PANE_OPEN_STORAGE_KEY) === "1";
		} catch {
			open = false;
		}
	}

	return {
		get state() {
			return fleet;
		},
		get configured() {
			return fleet.configured;
		},
		get open() {
			return open;
		},
		get busy() {
			return busy;
		},
		get mailboxBusy() {
			return mailboxBusy;
		},
		load,
		select,
		send,
		loadMailbox,
		toggle,
		restoreOpen,
	};
}

export const piFleetStore = createPiFleetStore();
