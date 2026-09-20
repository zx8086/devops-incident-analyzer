// packages/agent/src/fleet-inbox-node.ts
// SIO-1652: fetchFleetInbox. Reads each assessed estate's pi-coms inbox and its
// hub's ops inbox for the incident window and writes the fleetInboxDigest
// sidecar. Deterministic, registered always, edged only when
// PI_COMS_INBOX_ENABLED is true (SIO-640 edge-gate idiom), placed right before
// aggregate so the structured summary reaches this turn's prompt. Every read is
// bounded and soft-fails per estate: a hub outage never fails the turn.
import { getLogger } from "@devops-agent/observability";
import type { FleetInboxEstate, PiComsConfig, PiComsEnvironment, PiComsHubConfig } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
	type FetchLike,
	isPiComsConfigured,
	PiComsClient,
	type PiInboxMessage,
	resolvePiComsConfig,
} from "./action-tools/pi-coms-client.ts";
import { estatesFromState, selectHubForEstate } from "./action-tools/pi-verifier.ts";
import { collectFocusServices } from "./extract-findings.ts";
import {
	accountIdForEstate,
	attributableToEstate,
	buildEstateDigest,
	type EstateIdentity,
	excludedSenderPrefixes,
	fleetInboxTimeoutMs,
	type IncidentWindow,
	incidentWindow,
	isExcludedSender,
	isFleetInboxEnabled,
	MAILBOX_MAX_PAGES,
	MAILBOX_READ_LIMIT,
	windowFloorCursor,
	withinWindow,
} from "./fleet-inbox.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:fleet-inbox");

export type FleetInboxDeps = { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => number };

type FleetInboxState = Pick<
	AgentStateType,
	"awsTargetEstates" | "dataSourceResults" | "investigationFocus" | "normalizedIncident"
>;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// `stoppedBy` is the error that ENDED a partial walk, when one did: the pages
// already read are kept, and the cause travels with them so a 401 or a 5xx is
// not reported as a benign limit.
type Read =
	| { inbox: string; messages: PiInboxMessage[]; truncated: boolean; stoppedBy?: string }
	| { inbox: string; error: string };

// SIO-1828: the window, not just the newest page. Without `since` the hub returns the
// newest MAILBOX_READ_LIMIT rows, so an incident older than those rows read as an empty
// inbox -- the silent short read this ticket is about. With a floor cursor at the window
// start the hub pages FORWARD (`msg_id > ? ORDER BY msg_id ASC`), so the walk starts at
// the window and the caps below bound it. `truncated` is set when the caps stop the walk
// with rows still unread, so a short read is stated rather than silent.
async function readInbox(client: PiComsClient, inbox: string, budgetMs: number, window: IncidentWindow): Promise<Read> {
	const since = windowFloorCursor(window.from);
	try {
		// No usable cursor (unparseable window): the pre-SIO-1828 newest-first read.
		if (since === undefined) {
			const messages = await withTimeout(
				client.mailbox(inbox, { limit: MAILBOX_READ_LIMIT }),
				budgetMs,
				`mailbox ${inbox}`,
			);
			return { inbox, messages, truncated: false };
		}
		// One deadline for the whole walk, so paging cannot extend the per-estate
		// budget: each page gets whatever is left of it.
		const deadline = Date.now() + budgetMs;
		const windowEnd = Date.parse(window.to);
		const messages: PiInboxMessage[] = [];
		let cursor = since;
		let truncated = false;
		let stoppedBy: string | undefined;
		for (let page = 0; page < MAILBOX_MAX_PAGES; page++) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			// A page that times out truncates the walk; it does not discard the pages
			// already in hand (Greptile, PR #858). Losing them would report zero
			// messages for an estate whose window data had already been fetched --
			// the silent-empty failure this ticket exists to remove, made worse.
			let batch: PiInboxMessage[];
			try {
				batch = await withTimeout(
					client.mailbox(inbox, { limit: MAILBOX_READ_LIMIT, since: cursor }),
					remaining,
					`mailbox ${inbox}`,
				);
			} catch (error) {
				// Nothing read at all is a failed read, as before. A later page failing
				// keeps what the earlier ones returned and says the read was capped --
				// but carries the CAUSE, so an auth or 5xx failure is not indistinguishable
				// from hitting a benign limit (Greptile, PR #858).
				if (messages.length === 0) return { inbox, error: describeError(error) };
				truncated = true;
				stoppedBy = describeError(error);
				break;
			}
			messages.push(...batch);
			// A short page means the forward scan reached the end of the mailbox.
			if (batch.length < MAILBOX_READ_LIMIT) break;
			const last = batch[batch.length - 1];
			// Defensive: a page whose last row carries no id would loop on one cursor.
			if (!last?.msg_id) break;
			// The scan is ascending, so once the newest row of a page is past the
			// window there is nothing left to find: stop rather than page through
			// post-window traffic and then call a COMPLETE window capped.
			const newest = Date.parse(last.created_at);
			if (Number.isFinite(newest) && Number.isFinite(windowEnd) && newest > windowEnd) break;
			cursor = last.msg_id;
			// A full last page means rows may remain beyond the page cap.
			if (page === MAILBOX_MAX_PAGES - 1) truncated = true;
		}
		return { inbox, messages, truncated, stoppedBy };
	} catch (error) {
		return { inbox, error: describeError(error) };
	}
}

// The partial-read note for a capped walk: the cap alone, or the cap and what
// stopped it.
function cappedNote(read: { inbox: string; stoppedBy?: string }): string {
	const why = read.stoppedBy ? ` (${read.stoppedBy})` : "";
	return `${read.inbox}: read capped before the end of the window${why}`;
}

function estateIdentity(estate: string, config: PiComsConfig, env: NodeJS.ProcessEnv): EstateIdentity {
	const agent = config.estateAgentMap[estate] ?? estate;
	return { estate, accountId: accountIdForEstate(estate, env), agentNames: [...new Set([estate, agent])] };
}

export async function runFetchFleetInbox(
	state: FleetInboxState,
	deps: FleetInboxDeps = {},
): Promise<Partial<Pick<AgentStateType, "fleetInboxDigest">>> {
	const env = deps.env ?? process.env;
	// Disabled or unconfigured: pure no-op, never touch state.
	if (!isFleetInboxEnabled(env) || !isPiComsConfigured(env)) return {};
	const estates = estatesFromState(state).sort();
	// Enabled but nothing assessed this turn: clear a stale prior-turn digest.
	if (estates.length === 0) return { fleetInboxDigest: undefined };

	let config: PiComsConfig;
	try {
		config = resolvePiComsConfig(env);
	} catch (error) {
		logger.warn({ error: describeError(error) }, "fetchFleetInbox: pi-coms config invalid; no digest");
		return { fleetInboxDigest: undefined };
	}
	const now = deps.now ?? (() => Date.now());
	const window = incidentWindow(state, new Date(now()));
	const budgetMs = fleetInboxTimeoutMs(env);
	const excluded = excludedSenderPrefixes(env);
	// SIO-1815: the same union every findings card is scoped with.
	const focusServices = collectFocusServices(state);

	// One client per environment hub; the ops inbox is read once per hub and
	// then attributed per estate. An estate whose environment has no hub gets an
	// error row and never falls back to another environment's hub.
	const clients = new Map<PiComsEnvironment, { hub: PiComsHubConfig; client: PiComsClient }>();
	const routed: { estate: string; environment: PiComsEnvironment | undefined; error: string | null }[] = [];
	for (const estate of estates) {
		const selection = selectHubForEstate(estate, config);
		if (!selection.ok) {
			routed.push({ estate, environment: undefined, error: selection.error });
			continue;
		}
		if (!clients.has(selection.environment)) {
			clients.set(selection.environment, {
				hub: selection.hub,
				client: new PiComsClient(selection.hub, { fetchImpl: deps.fetchImpl, now: deps.now }),
			});
		}
		routed.push({ estate, environment: selection.environment, error: null });
	}

	const opsReads = new Map<PiComsEnvironment, Promise<Read>>();
	for (const [environment, { hub, client }] of clients) {
		opsReads.set(environment, readInbox(client, hub.fallbackTarget, budgetMs, window));
	}
	const estateReads = routed.map((r) => {
		const entry = r.environment ? clients.get(r.environment) : undefined;
		return entry
			? readInbox(entry.client, r.estate, budgetMs, window)
			: Promise.resolve<Read>({ inbox: r.estate, error: r.error ?? "" });
	});
	const [ops, own] = await Promise.all([
		Promise.all([...opsReads.entries()].map(async ([environment, p]) => [environment, await p] as const)),
		Promise.all(estateReads),
	]);
	const opsByEnvironment = new Map(ops);

	const digestEstates: FleetInboxEstate[] = routed.map((r, i) => {
		const environment =
			r.environment ?? (r.estate.endsWith("-stg") ? "stg" : r.estate.endsWith("-dev") ? "dev" : "prd");
		const identity = estateIdentity(r.estate, config, env);
		const errors: string[] = [];
		const messages: { inbox: string; message: PiInboxMessage }[] = [];
		const inboxes: string[] = [];
		if (r.error) errors.push(r.error);
		const ownRead = own[i];
		if (ownRead) {
			inboxes.push(ownRead.inbox);
			if ("error" in ownRead) {
				if (!r.error) errors.push(ownRead.error);
			} else {
				for (const message of ownRead.messages) messages.push({ inbox: ownRead.inbox, message });
				// SIO-1828: a capped walk read only part of the window. Say so -- a silently
				// short read is exactly the failure mode this paging replaced.
				if (ownRead.truncated) errors.push(cappedNote(ownRead));
			}
		}
		const opsRead = r.environment ? opsByEnvironment.get(r.environment) : undefined;
		if (opsRead) {
			inboxes.push(opsRead.inbox);
			if ("error" in opsRead) errors.push(`${opsRead.inbox}: ${opsRead.error}`);
			else {
				for (const message of opsRead.messages) {
					if (attributableToEstate(message, identity)) messages.push({ inbox: opsRead.inbox, message });
				}
				if (opsRead.truncated) errors.push(cappedNote(opsRead));
			}
		}
		const kept = messages.filter(
			({ message }) => !isExcludedSender(message, excluded) && withinWindow(message, window),
		);
		return buildEstateDigest({
			estate: r.estate,
			environment,
			inboxes: [...new Set(inboxes)],
			messages: kept,
			error: errors.length > 0 ? errors.join("; ") : null,
			focusServices,
		});
	});

	for (const estate of digestEstates) {
		if (estate.error) logger.warn({ estate: estate.estate, error: estate.error }, "fetchFleetInbox: partial read");
	}
	// Counts and the monitor's own category names only; never a body (SIO-1660).
	logger.info(
		{
			focusServices,
			estates: digestEstates.map((e) => ({
				estate: e.estate,
				reports: e.counts.total,
				focusReports: e.counts.focus,
				families: e.families.map((f) => `${f.family}=${f.count}/${f.focus}`),
			})),
		},
		"fetchFleetInbox: digest built",
	);
	return {
		fleetInboxDigest: {
			windowFrom: window.from,
			windowTo: window.to,
			generatedAt: new Date(now()).toISOString(),
			focusServices,
			estates: digestEstates,
		},
	};
}

export async function fetchFleetInbox(
	state: AgentStateType,
	_config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	return runFetchFleetInbox(state);
}
