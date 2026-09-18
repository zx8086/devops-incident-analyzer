// apps/web/src/lib/stores/pi-fleet.svelte.ts
// SIO-1650: runes wrapper around the pure pi-fleet reducer. Fetches the peer
// listing, sends one prompt to the selected spoke and re-polls the message by id
// until the reply is terminal or the pane budget is spent. Replies stay data.
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import {
	PiActionPollResponseSchema,
	PiActionStartResponseSchema,
	PiFleetAgentsResponseSchema,
	PiFleetMailboxResponseSchema,
	PiFleetMessageResponseSchema,
	PiFleetMessageStatusResponseSchema,
} from "../pi-fleet-types.ts";
import {
	applyActionResult,
	applyActionStart,
	applyAgents,
	applyLoadError,
	applyMailbox,
	applySendResult,
	applyStatus,
	clearConversation,
	expireEntry,
	failEntry,
	initialPiFleetState,
	isTerminal,
	type PiFleetSelection,
	type PiFleetState,
	patchEntry,
	selectPeer,
	shouldKeepPolling,
	startEntry,
} from "./pi-fleet-reducer.ts";

const PANE_OPEN_STORAGE_KEY = "pi-fleet-pane-open";
// SIO-1778: pause between retries of a FAILED action poll (a successful poll already
// blocks for one hub await slice, so it needs none).
const POLL_RETRY_DELAY_MS = 3_000;

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
	// SIO-1811: bumped by clear(). Async work captures it at start and drops its
	// result if it no longer matches, so a late reply cannot land on a board the
	// operator has since cleared. Plain `let`, not $state -- nothing renders it.
	let generation = 0;

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

	// SIO-1811: called by the header's clear button, so the pane beside the answer
	// is cleared with it.
	//
	// The generation counter is what makes a clear stick (Greptile, PR #842). Async
	// work started by the old conversation can finish after it: pollUntilTerminal
	// and applyStatus/applyActionResult are safe on their own, because patchEntry
	// maps over existing entries and a removed one is simply not found -- but
	// applyMailbox SPREADS into the record, so a mailbox read in flight across a
	// clear puts the old listing back on the fresh board. Measured, not assumed:
	// a probe over the reducers confirmed entries stay at 0 while mailboxes
	// returned to 1. Every write below is now gated on the generation it started
	// in, which also stops runAction's poll loop, the one loop with no
	// entry-existence check of its own.
	function clear() {
		generation += 1;
		fleet = clearConversation(fleet);
	}

	async function pollUntilTerminal(id: string, startedIn: number) {
		while (true) {
			// The entry check alone already stops this loop after a clear; the
			// generation check makes that explicit rather than incidental.
			if (startedIn !== generation) return;
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
		const startedIn = generation;
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
			if (startedIn !== generation) return;
			fleet = applySendResult(fleet, id, parsed.data);
			await pollUntilTerminal(id, startedIn);
		} catch (error) {
			if (startedIn !== generation) return;
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

	// SIO-1778: a verify/investigate card's Approve. The send and the wait happen here,
	// visibly, in short requests. SIO-1789: the pane entry renders the validated result;
	// the card gets it back only to show a status line and raise follow-up cards. Works
	// without pane tokens: the action route sends as the analyzer principal, so an
	// unconfigured pane means the entry is not shown and the card renders the result itself.
	async function runAction(action: PendingAction, reportContent: string): Promise<ActionResult> {
		const id = crypto.randomUUID();
		const startedIn = generation;
		const label = action.tool === "investigate-with-pi" ? "investigate" : "verify";
		// SIO-1811: this loop runs to its own deadline (up to 300 s) and, unlike
		// pollUntilTerminal, never checks that its entry still exists. Abandoned once
		// the board it belongs to has been cleared.
		const abandoned = (): ActionResult => ({
			actionId: action.id,
			tool: action.tool,
			status: "error",
			error: "the conversation was cleared while this action was running",
		});
		const failed = (message: string): ActionResult => {
			if (startedIn !== generation) return abandoned();
			fleet = failEntry(fleet, id, message);
			return { actionId: action.id, tool: action.tool, status: "error", error: message };
		};
		// The listing can land mid-action (configured false -> true). The card hides its
		// result as soon as a pane exists, so a pane that could not be opened at the start
		// is opened when the result arrives. One that WAS opened stays as the user left it.
		const reveal = () => {
			if (fleet.configured && !open) toggle();
		};
		const revealedAtStart = fleet.configured;
		reveal();
		const estate = typeof action.params.estate === "string" ? action.params.estate : "pi agent";
		fleet = startEntry(fleet, { id, hubKey: "", target: estate, prompt: "", sentAt: Date.now(), label });
		try {
			const started = PiActionStartResponseSchema.safeParse(
				await readJson(
					await fetch("/api/pi/actions", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action, reportContent }),
					}),
				),
			);
			if (!started.success) return failed("unexpected /api/pi/actions response shape");
			if (startedIn !== generation) return abandoned();
			const start = started.data;
			if (start.hubKey !== undefined) {
				fleet = patchEntry(fleet, id, { hubKey: start.hubKey, target: start.target, prompt: start.prompt });
			}
			if (!start.started) {
				if (!revealedAtStart) reveal();
				fleet = applyActionResult(fleet, id, start.result);
				return start.result;
			}
			fleet = applyActionStart(fleet, id, start.msgId);
			const deadline = Date.now() + start.budgetMs;
			// The route waits one hub slice per request, so no client-side sleep on the
			// happy path. A failed poll is NOT terminal: the server keeps the started
			// action until it finalizes, so a tunnel blip or one 502 from the hub must not
			// throw away a 15-minute investigation that is still running (Greptile, PR #807).
			// Only a 404 ends it -- the server no longer knows this message.
			const NO_REPLY = "no reply within the action budget";
			let lastError = NO_REPLY;
			while (Date.now() < deadline) {
				// Stop the moment the board this action belongs to is cleared, rather
				// than polling on for the rest of the budget against a gone entry.
				if (startedIn !== generation) return abandoned();
				let polled: ReturnType<typeof PiActionPollResponseSchema.safeParse>;
				try {
					const res = await fetch(`/api/pi/actions?msgId=${encodeURIComponent(start.msgId)}`);
					if (res.status === 404) return failed("the server no longer tracks this action (it may have restarted)");
					polled = PiActionPollResponseSchema.safeParse(await readJson(res));
				} catch (error) {
					lastError = error instanceof Error ? error.message : String(error);
					await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS));
					continue;
				}
				if (!polled.success) return failed("unexpected /api/pi/actions poll response shape");
				if (polled.data.pending) {
					// A poll that got through supersedes an earlier transport error: if the
					// deadline passes now, the reason is "no reply", not a blip that recovered
					// (Greptile, PR #807 -- the card and the pane would otherwise disagree).
					lastError = NO_REPLY;
					continue;
				}
				if (startedIn !== generation) return abandoned();
				if (!revealedAtStart) reveal();
				fleet = applyActionResult(fleet, id, polled.data.result);
				return polled.data.result;
			}
			if (startedIn !== generation) return abandoned();
			fleet = expireEntry(fleet, id, start.budgetMs);
			return { actionId: action.id, tool: action.tool, status: "error", error: lastError };
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
	}

	async function loadMailbox(hubKey: string, estates: string[]) {
		const startedIn = generation;
		mailboxBusy = hubKey;
		try {
			// SIO-1705: the scope travels with the request so the hub-side read is anchored
			// per estate; filtering client-side after a cap dropped rows that were never fetched.
			const scope = estates.length > 0 ? `&estates=${encodeURIComponent(estates.join(","))}` : "&estates=";
			const body = await readJson(await fetch(`/api/pi/mailbox?hubKey=${encodeURIComponent(hubKey)}${scope}`));
			const parsed = PiFleetMailboxResponseSchema.safeParse(body);
			if (!parsed.success) throw new Error("unexpected /api/pi/mailbox response shape");
			if (startedIn !== generation) return;
			fleet = applyMailbox(fleet, parsed.data);
		} catch (error) {
			if (startedIn !== generation) return;
			fleet = applyLoadError(fleet, describeLoadFailure(error, `read the ${hubKey} inbox`));
		} finally {
			// Always released: this read is finished either way, and a stale flag would
			// leave the refresh button spinning forever after a clear.
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
		clear,
		send,
		runAction,
		loadMailbox,
		toggle,
		restoreOpen,
	};
}

export const piFleetStore = createPiFleetStore();
