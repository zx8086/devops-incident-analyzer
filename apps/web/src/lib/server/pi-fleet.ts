// apps/web/src/lib/server/pi-fleet.ts
// SIO-1650: hub access for the pi-fleet pane. Spokes are listed per environment
// hub; an operator prompt goes to one spoke on the hub it was listed from (no
// cross-environment access). Every HTTP request waits at most one await slice;
// the browser re-polls by message id. Replies are returned as data and never
// reach an LLM call.
import {
	type FetchLike,
	isPiComsConfigured,
	PI_COMS_AWAIT_SLICE_MS,
	PiComsClient,
	type PiReply,
	resolvePiComsConfig,
	senderNameFor,
} from "@devops-agent/agent";
import type { PiComsEnvironment, PiComsHubConfig } from "@devops-agent/shared";
import { z } from "zod";
import {
	type PiFleetAgentsResponse,
	PiFleetEnvironmentSchema,
	type PiFleetHub,
	type PiFleetMailboxResponse,
	type PiFleetMessageResponse,
	type PiFleetMessageStatusResponse,
} from "../pi-fleet-types.ts";

// Directory-mode hubs bind names to principals: the pane's prefix needs its own
// principal (`just token-create pi-fleet "pi-fleet-*" service <profile>`) and its
// token in PI_COMS_PANE_TOKENS, or the prefix is set to the analyzer's own.
const DEFAULT_SENDER_PREFIX = "pi-fleet";
const DEFAULT_AWAIT_MS = PI_COMS_AWAIT_SLICE_MS;
// Above this a single route request outlives the hub's 30 s stale threshold by too much.
const MAX_AWAIT_MS = 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 300_000;
const MAILBOX_DEFAULT_LIMIT = 20;
const ENVIRONMENTS = PiFleetEnvironmentSchema.options;

const PaneTokensSchema = z.partialRecord(PiFleetEnvironmentSchema, z.string().min(1));

export type PiFleetDeps = { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => number };

export class PiFleetRequestError extends Error {
	readonly status: 400 | 404;

	constructor(status: 400 | 404, message: string) {
		super(message);
		this.name = "PiFleetRequestError";
		this.status = status;
	}
}

type PaneHub = { environment: PiComsEnvironment; hub: PiComsHubConfig };
export type PaneConfig = { senderPrefix: string; awaitMs: number; totalBudgetMs: number; hubs: PaneHub[] };

function nonEmpty(value: string | undefined): string | undefined {
	return value && value !== "" ? value : undefined;
}

function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
	const value = nonEmpty(raw);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
	return parsed;
}

function readPaneTokens(raw: string | undefined): Partial<Record<PiComsEnvironment, string>> {
	const value = nonEmpty(raw);
	if (value === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(`PI_COMS_PANE_TOKENS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const result = PaneTokensSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
		throw new Error(`PI_COMS_PANE_TOKENS is not a valid token map: ${issues}`);
	}
	return result.data;
}

export function resolvePaneConfig(env: NodeJS.ProcessEnv = process.env): PaneConfig | undefined {
	if (!isPiComsConfigured(env)) return undefined;
	const config = resolvePiComsConfig(env);
	const tokens = readPaneTokens(env.PI_COMS_PANE_TOKENS);
	const hubs: PaneHub[] = [];
	for (const environment of ENVIRONMENTS) {
		const hub = config.hubs[environment];
		if (!hub) continue;
		const paneToken = tokens[environment];
		hubs.push({ environment, hub: paneToken ? { ...hub, authToken: paneToken } : hub });
	}
	return {
		senderPrefix: nonEmpty(env.PI_COMS_PANE_SENDER_PREFIX) ?? DEFAULT_SENDER_PREFIX,
		awaitMs: Math.min(
			readPositiveInt(env.PI_COMS_PANE_AWAIT_MS, DEFAULT_AWAIT_MS, "PI_COMS_PANE_AWAIT_MS"),
			MAX_AWAIT_MS,
		),
		totalBudgetMs: readPositiveInt(env.PI_COMS_PANE_TIMEOUT_MS, DEFAULT_TOTAL_BUDGET_MS, "PI_COMS_PANE_TIMEOUT_MS"),
		hubs,
	};
}

function requirePane(deps: PiFleetDeps): PaneConfig {
	const pane = resolvePaneConfig(deps.env ?? process.env);
	if (!pane) throw new PiFleetRequestError(404, "pi-coms hubs are not configured (PI_COMS_HUBS)");
	return pane;
}

function requireHub(pane: PaneConfig, environment: PiComsEnvironment): PaneHub {
	const paneHub = pane.hubs.find((h) => h.environment === environment);
	if (!paneHub) {
		throw new PiFleetRequestError(404, `no pi-coms hub configured for environment "${environment}"; set PI_COMS_HUBS`);
	}
	return paneHub;
}

function clientFor(paneHub: PaneHub, pane: PaneConfig, deps: PiFleetDeps): PiComsClient {
	return new PiComsClient(paneHub.hub, {
		fetchImpl: deps.fetchImpl,
		now: deps.now,
		senderPrefix: pane.senderPrefix,
	});
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function listFleetAgents(deps: PiFleetDeps = {}): Promise<PiFleetAgentsResponse> {
	const pane = resolvePaneConfig(deps.env ?? process.env);
	if (!pane) {
		return {
			configured: false,
			senderPrefix: DEFAULT_SENDER_PREFIX,
			awaitMs: DEFAULT_AWAIT_MS,
			totalBudgetMs: DEFAULT_TOTAL_BUDGET_MS,
			hubs: [],
		};
	}
	// Listing needs only the bearer token, so no registration here. A failing hub
	// keeps its row with the reason; the other hubs still list.
	const hubs: PiFleetHub[] = await Promise.all(
		pane.hubs.map(async (paneHub) => {
			const base = {
				environment: paneHub.environment,
				project: paneHub.hub.project,
				fallbackTarget: paneHub.hub.fallbackTarget,
			};
			try {
				const agents = await clientFor(paneHub, pane, deps).listAgents();
				const peers = agents
					.map((a) => ({ name: a.name, status: a.status, purpose: a.purpose ?? null, sessionId: a.session_id }))
					.sort((a, b) => a.name.localeCompare(b.name));
				return { ...base, peers, error: null };
			} catch (error) {
				return { ...base, peers: [], error: describeError(error) };
			}
		}),
	);
	return {
		configured: true,
		senderPrefix: pane.senderPrefix,
		awaitMs: pane.awaitMs,
		totalBudgetMs: pane.totalBudgetMs,
		hubs,
	};
}

function statusOf(environment: PiComsEnvironment, msgId: string, reply: PiReply): PiFleetMessageStatusResponse {
	return { environment, msgId, status: reply.status, response: reply.response, error: reply.error };
}

export async function sendFleetMessage(
	input: { environment: PiComsEnvironment; target: string; prompt: string },
	deps: PiFleetDeps = {},
): Promise<PiFleetMessageResponse> {
	const pane = requirePane(deps);
	const paneHub = requireHub(pane, input.environment);
	const client = clientFor(paneHub, pane, deps);
	const sentAt = new Date((deps.now ?? Date.now)()).toISOString();
	// The hub requires a registered sender to send; the registration is short-lived
	// and hidden from peer listings (explicit: true in the client).
	await client.register();
	try {
		// No response_schema: the operator reads a free-form reply, no LLM parses it.
		const sent = await client.send(input.target, input.prompt);
		const reply = await client.awaitReply(sent.msg_id, pane.awaitMs);
		return {
			...statusOf(input.environment, sent.msg_id, reply),
			target: input.target,
			sender: senderNameFor(client.sessionId, pane.senderPrefix),
			sentAt,
		};
	} finally {
		await client.deregister();
	}
}

// Re-await by id from a fresh, unregistered client: /await needs only the token,
// and the heartbeat between slices is swallowed by the client when it 404s.
export async function awaitFleetMessage(
	input: { environment: PiComsEnvironment; msgId: string },
	deps: PiFleetDeps = {},
): Promise<PiFleetMessageStatusResponse> {
	const pane = requirePane(deps);
	const paneHub = requireHub(pane, input.environment);
	const reply = await clientFor(paneHub, pane, deps).awaitReply(input.msgId, pane.awaitMs);
	return statusOf(input.environment, input.msgId, reply);
}

export async function readFleetMailbox(
	input: { environment: PiComsEnvironment; name?: string; limit?: number },
	deps: PiFleetDeps = {},
): Promise<PiFleetMailboxResponse> {
	const pane = requirePane(deps);
	const paneHub = requireHub(pane, input.environment);
	const name = input.name ?? paneHub.hub.fallbackTarget;
	const messages = await clientFor(paneHub, pane, deps).mailbox(name, { limit: input.limit ?? MAILBOX_DEFAULT_LIMIT });
	return {
		environment: input.environment,
		name,
		messages: messages.map((m) => ({
			msgId: m.msg_id,
			senderName: m.sender_name,
			targetName: m.target_name,
			prompt: m.prompt,
			status: m.status,
			error: m.error,
			response: m.response,
			createdAt: m.created_at,
			completedAt: m.completed_at,
		})),
	};
}
