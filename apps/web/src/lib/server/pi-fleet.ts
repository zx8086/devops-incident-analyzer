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
	PiComsHttpError,
	type PiReply,
	resolvePiComsConfig,
	senderNameFor,
	spokesOnly,
} from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";
import type { PiComsEnvironment, PiComsHubConfig } from "@devops-agent/shared";
import { z } from "zod";
import type {
	PiFleetAgentsResponse,
	PiFleetHub,
	PiFleetMailboxResponse,
	PiFleetMessageResponse,
	PiFleetMessageStatusResponse,
} from "../pi-fleet-types.ts";

// Directory-mode hubs bind names to principals: the pane's prefix needs its own
// principal (`just token-create pi-fleet "pi-fleet-*" service <profile>`) and its
// token in PI_COMS_PANE_TOKENS, or the prefix is set to the analyzer's own.
// SIO-1660: this module had no logging at all, so a failing hub surfaced only as
// a string in the pane. Log identity and outcome; never the token, the hub
// object that carries it, the prompt, or the spoke's reply.
const log = getLogger("web:pi-fleet");

const DEFAULT_SENDER_PREFIX = "pi-fleet";
const DEFAULT_AWAIT_MS = PI_COMS_AWAIT_SLICE_MS;
// Above this a single route request outlives the hub's 30 s stale threshold by too much.
const MAX_AWAIT_MS = 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 300_000;
const MAILBOX_DEFAULT_LIMIT = 20;

// SIO-1666: keyed by HUB, not environment -- two hubs sharing an environment need
// two different pane tokens, and one env key could only hold one.
const PaneTokensSchema = z.record(z.string().min(1), z.string().min(1));

export type PiFleetDeps = { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => number };

export class PiFleetRequestError extends Error {
	readonly status: 400 | 404;

	constructor(status: 400 | 404, message: string) {
		super(message);
		this.name = "PiFleetRequestError";
		this.status = status;
	}
}

// SIO-1666: a hub is identified by its KEY (the selector); the environment it
// serves rides along as an attribute.
type PaneHub = { hubKey: string; environment: PiComsEnvironment; hub: PiComsHubConfig };
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

function readPaneTokens(raw: string | undefined): Record<string, string> {
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
	// SIO-1666: iterate the configured hubs, not the environment enum -- two hubs
	// may share an environment. Pane tokens are keyed by hub for the same reason.
	for (const [hubKey, hub] of Object.entries(config.hubs)) {
		if (!hub) continue;
		const paneToken = tokens[hubKey];
		hubs.push({ hubKey, environment: hub.environment, hub: paneToken ? { ...hub, authToken: paneToken } : hub });
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

function requireHub(pane: PaneConfig, hubKey: string): PaneHub {
	const paneHub = pane.hubs.find((h) => h.hubKey === hubKey);
	if (!paneHub) {
		const known = pane.hubs.map((h) => h.hubKey).join(", ") || "(none)";
		throw new PiFleetRequestError(404, `no pi-coms hub "${hubKey}"; configured hubs are ${known}`);
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

// SIO-1661: a registration rejection is nearly always the prefix/principal
// mismatch documented at the top of this file, and the operator sees only the
// route's 502 body. The client has already named the sender; this frame adds the
// two things only it knows -- which hub, and which prefix produced that name --
// and the exact command to fix it, the way `just coms` does for a missing
// operator principal (packages/pi-coms/justfile). Returns a PiComsHttpError so
// piFleetErrorResponse still answers 502; anything else would become a 500.
function explainRegistrationFailure(error: unknown, hubKey: string, senderPrefix: string): unknown {
	if (!(error instanceof PiComsHttpError)) return error;
	const lines = [`  on hub "${hubKey}" (PI_COMS_PANE_SENDER_PREFIX=${senderPrefix})`];
	if (error.code === "name_not_allowed") {
		lines.push(
			"  No principal on this hub allows that name. Either:",
			`    just token-create ${senderPrefix} "${senderPrefix}-*" service <profile>   and set PI_COMS_PANE_TOKENS`,
			"    or set PI_COMS_PANE_SENDER_PREFIX to a prefix an existing principal allows",
		);
	}
	return error.withContext(...lines);
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
	//
	// SIO-1696: this pane is production incident triage, so only prd hubs are
	// listed. `environment` is the hub attribute SIO-1666 introduced for exactly
	// this question -- do not infer it from an estate name. UI surface only: the
	// send and mailbox paths below still resolve every configured hub, so an
	// operator addressing a dev spoke through the hub CLI is unaffected.
	const hubs: PiFleetHub[] = await Promise.all(
		pane.hubs
			.filter((paneHub) => paneHub.environment === "prd")
			.map(async (paneHub) => {
				const base = {
					hubKey: paneHub.hubKey,
					environment: paneHub.environment,
					project: paneHub.hub.project,
					fallbackTarget: paneHub.hub.fallbackTarget,
				};
				try {
					// SIO-1665: the client lists explicit registrations too (a spoke may be
					// explicit), which also returns every `monitor-*`. Monitors cannot answer a
					// prompt, so they are dropped by name here; their reports still reach the
					// pane through the hub's inbox (`Inbox ops`).
					const agents = spokesOnly(await clientFor(paneHub, pane, deps).listAgents());
					const peers = agents
						.map((a) => ({ name: a.name, status: a.status, purpose: a.purpose ?? null, sessionId: a.session_id }))
						.sort((a, b) => a.name.localeCompare(b.name));
					log.info(
						{ hubKey: paneHub.hubKey, project: paneHub.hub.project, peers: peers.length },
						"pi.fleet.agents.listed",
					);
					return { ...base, peers, error: null };
				} catch (error) {
					// This error was previously visible ONLY as a string in the pane
					// ("fetch failed"), with nothing server-side to say which hub or why.
					log.warn(
						{ hubKey: paneHub.hubKey, project: paneHub.hub.project, error: describeError(error) },
						"pi.fleet.agents.failed",
					);
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

function statusOf(paneHub: PaneHub, msgId: string, reply: PiReply): PiFleetMessageStatusResponse {
	return {
		hubKey: paneHub.hubKey,
		environment: paneHub.environment,
		msgId,
		status: reply.status,
		response: reply.response,
		error: reply.error,
	};
}

export async function sendFleetMessage(
	input: { hubKey: string; target: string; prompt: string },
	deps: PiFleetDeps = {},
): Promise<PiFleetMessageResponse> {
	const pane = requirePane(deps);
	const paneHub = requireHub(pane, input.hubKey);
	const client = clientFor(paneHub, pane, deps);
	const sentAt = new Date((deps.now ?? Date.now)()).toISOString();
	// The hub requires a registered sender to send; the registration is short-lived
	// and hidden from peer listings (explicit: true in the client).
	// SIO-1660: the send path, start to finish. `register` is the step that fails
	// with name_not_allowed when the sender prefix has no matching principal, so
	// the name and environment are logged before the attempt -- that pairing is
	// what a 403 needs in order to be self-explanatory.
	const senderName = senderNameFor(client.sessionId, pane.senderPrefix);
	log.info(
		{ hubKey: paneHub.hubKey, environment: paneHub.environment, target: input.target, sender: senderName },
		"pi.fleet.send.start",
	);
	try {
		await client.register();
	} catch (error) {
		log.warn(
			{ hubKey: paneHub.hubKey, sender: senderName, error: describeError(error) },
			"pi.fleet.send.register_failed",
		);
		// SIO-1661: the log serves whoever is watching the server; this serves the
		// operator, who sees only the route's 502 body.
		throw explainRegistrationFailure(error, paneHub.hubKey, pane.senderPrefix);
	}
	try {
		// No response_schema: the operator reads a free-form reply, no LLM parses it.
		const sent = await client.send(input.target, input.prompt);
		const reply = await client.awaitReply(sent.msg_id, pane.awaitMs);
		// Reply TEXT is never logged: it is spoke-authored and stays data.
		log.info(
			{ hubKey: paneHub.hubKey, target: input.target, msg_id: sent.msg_id, status: reply.status },
			"pi.fleet.send.done",
		);
		return {
			...statusOf(paneHub, sent.msg_id, reply),
			target: input.target,
			sender: senderName,
			sentAt,
		};
	} finally {
		await client.deregister();
	}
}

// Re-await by id from a fresh, unregistered client: /await needs only the token,
// and the heartbeat between slices is swallowed by the client when it 404s.
export async function awaitFleetMessage(
	input: { hubKey: string; msgId: string },
	deps: PiFleetDeps = {},
): Promise<PiFleetMessageStatusResponse> {
	const pane = requirePane(deps);
	const paneHub = requireHub(pane, input.hubKey);
	const reply = await clientFor(paneHub, pane, deps).awaitReply(input.msgId, pane.awaitMs);
	return statusOf(paneHub, input.msgId, reply);
}

export async function readFleetMailbox(
	input: { hubKey: string; name?: string; limit?: number },
	deps: PiFleetDeps = {},
): Promise<PiFleetMailboxResponse> {
	const pane = requirePane(deps);
	const paneHub = requireHub(pane, input.hubKey);
	const name = input.name ?? paneHub.hub.fallbackTarget;
	const messages = await clientFor(paneHub, pane, deps).mailbox(name, { limit: input.limit ?? MAILBOX_DEFAULT_LIMIT });
	// SIO-1660: count only. Mailbox entries carry monitor-authored prompts and
	// spoke replies, which must never reach the log.
	// awaitFleetMessage needs nothing here: pi.hub.await.done already reports it.
	log.info({ hubKey: paneHub.hubKey, name, messages: messages.length }, "pi.fleet.mailbox.read");
	return {
		hubKey: paneHub.hubKey,
		environment: paneHub.environment,
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
