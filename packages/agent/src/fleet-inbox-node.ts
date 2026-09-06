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
import {
	accountIdForEstate,
	attributableToEstate,
	buildEstateDigest,
	type EstateIdentity,
	excludedSenderPrefixes,
	fleetInboxTimeoutMs,
	incidentWindow,
	isExcludedSender,
	isFleetInboxEnabled,
	MAILBOX_READ_LIMIT,
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

type Read = { inbox: string; messages: PiInboxMessage[] } | { inbox: string; error: string };

async function readInbox(client: PiComsClient, inbox: string, budgetMs: number): Promise<Read> {
	try {
		const messages = await withTimeout(
			client.mailbox(inbox, { limit: MAILBOX_READ_LIMIT }),
			budgetMs,
			`mailbox ${inbox}`,
		);
		return { inbox, messages };
	} catch (error) {
		return { inbox, error: describeError(error) };
	}
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
		opsReads.set(environment, readInbox(client, hub.fallbackTarget, budgetMs));
	}
	const estateReads = routed.map((r) => {
		const entry = r.environment ? clients.get(r.environment) : undefined;
		return entry
			? readInbox(entry.client, r.estate, budgetMs)
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
		});
	});

	for (const estate of digestEstates) {
		if (estate.error) logger.warn({ estate: estate.estate, error: estate.error }, "fetchFleetInbox: partial read");
	}
	return {
		fleetInboxDigest: {
			windowFrom: window.from,
			windowTo: window.to,
			generatedAt: new Date(now()).toISOString(),
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
