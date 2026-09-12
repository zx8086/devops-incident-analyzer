// apps/web/src/lib/stores/pi-fleet.svelte.ts
// SIO-1650: runes wrapper around the pure pi-fleet reducer. Fetches the peer
// listing, sends one prompt to the selected spoke and re-polls the message by id
// until the reply is terminal or the pane budget is spent. Replies stay data.
import {
	PiFleetAgentsResponseSchema,
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

// SIO-1701: when the request never leaves the browser, fetch rejects with a bare
// "fetch failed" (or "Load failed" in Safari) -- no status, no URL, nothing
// naming which call broke. The banner then read as an unattributed error. A
// server-side failure already arrives explained (readJson lifts the route's
// `error` body, SIO-1661), so only the transport case needs framing here.
function describeLoadFailure(error: unknown, what: string): string {
	const message = error instanceof Error ? error.message : String(error);
	const transport = error instanceof TypeError || message === "fetch failed" || message === "Load failed";
	return transport ? `could not reach the app server to ${what} (${message})` : message;
}

function createPiFleetStore() {
	let fleet = $state<PiFleetState>(initialPiFleetState());
	let open = $state(false);
	let busy = $state(false);
	let mailboxBusy = $state<string | null>(null);

	async function load() {
		try {
			const body = await readJson(await fetch("/api/pi/agents"));
			const parsed = PiFleetAgentsResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/agents response shape");
			fleet = applyAgents(fleet, parsed.data);
		} catch (error) {
			fleet = applyLoadError(fleet, describeLoadFailure(error, "list the fleet spokes"));
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
			const params = new URLSearchParams({ hubKey: entry.hubKey, msgId: entry.msgId ?? "" });
			const body = await readJson(await fetch(`/api/pi/messages?${params.toString()}`));
			const parsed = PiFleetMessageStatusResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/messages response shape");
			fleet = applyStatus(fleet, id, parsed.data);
		}
	}

	// One spoke, one entry. Each target gets its own card so a fan-out reads as
	// several attributed replies rather than one merged blob, and one spoke
	// failing leaves the others' cards intact.
	async function sendOne(target: PiFleetSelection, text: string) {
		const id = crypto.randomUUID();
		fleet = startEntry(fleet, { id, ...target, target: target.name, prompt: text, sentAt: Date.now() });
		try {
			const body = await readJson(
				await fetch("/api/pi/messages", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ hubKey: target.hubKey, target: target.name, prompt: text }),
				}),
			);
			const parsed = PiFleetMessageResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/messages response shape");
			fleet = applySendResult(fleet, id, parsed.data);
			await pollUntilTerminal(id);
		} catch (error) {
			fleet = failEntry(fleet, id, error instanceof Error ? error.message : String(error));
		}
	}

	// SIO-1708: with a spoke selected the prompt goes to it; with none selected it
	// goes to every spoke the pane is SHOWING. `visible` is the estate-scoped list
	// the component renders, passed in rather than recomputed here -- scoping lives
	// in one place (the same reason SIO-1705 passes the estate scope to the
	// mailbox read).
	async function send(prompt: string, visible: PiFleetSelection[] = []) {
		const text = prompt.trim();
		if (text === "" || busy) return;
		const targets = fleet.selected ? [fleet.selected] : visible;
		if (targets.length === 0) return;
		busy = true;
		try {
			// allSettled, not all: one spoke erroring must not abandon the others'
			// polling. sendOne already records its own failure on its own card.
			await Promise.allSettled(targets.map((t) => sendOne(t, text)));
		} finally {
			busy = false;
		}
	}

	async function loadMailbox(hubKey: string, estates: string[]) {
		mailboxBusy = hubKey;
		try {
			// SIO-1705: the scope travels with the request so the hub-side read is anchored
			// per estate; filtering client-side after a cap dropped rows that were never fetched.
			const scope = estates.length > 0 ? `&estates=${encodeURIComponent(estates.join(","))}` : "&estates=";
			const body = await readJson(await fetch(`/api/pi/mailbox?hubKey=${encodeURIComponent(hubKey)}${scope}`));
			const parsed = PiFleetMailboxResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/mailbox response shape");
			fleet = applyMailbox(fleet, parsed.data);
		} catch (error) {
			fleet = applyLoadError(fleet, describeLoadFailure(error, `read the ${hubKey} inbox`));
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
