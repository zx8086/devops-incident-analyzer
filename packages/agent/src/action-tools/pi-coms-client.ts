// agent/src/action-tools/pi-coms-client.ts
// SIO-1635: minimal client for the pi-coms hub (plain HTTP, no SSE). One short-lived
// registration per action: the hub requires a registered sender to send, but a reaped
// sender does not break /await or the target's reply, so we register, send, await,
// and deregister inside a single executeAction call.
import { getLogger } from "@devops-agent/observability";
import type {
	AgentCard,
	InboxListing,
	InboxMessage,
	MessageStatus,
	SendResponse,
} from "@devops-agent/pi-coms/contracts";
import {
	type PiComsConfig,
	PiComsConfigSchema,
	type PiComsEnvironment,
	PiComsEnvironmentSchema,
	type PiComsHubConfig,
} from "@devops-agent/shared";
import { z } from "zod";

const logger = getLogger("agent:action-tools:pi-coms-client");

export const PI_COMS_DEFAULT_PROJECT = "default";
export const PI_COMS_DEFAULT_FALLBACK_TARGET = "ops";
const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;
const DEFAULT_INVESTIGATE_TIMEOUT_MS = 900_000;
// The legacy single-hub variables describe one hub; this names its environment.
const DEFAULT_SINGLE_HUB_ENVIRONMENT: PiComsEnvironment = "dev";

// SIO-1666: keyed by selector (AWS profile / account), not environment. Each hub
// declares the environment it serves and the estates it owns, so an estate is
// routed by an explicit binding rather than by its name suffix.
const HubsJsonSchema = z.record(
	z.string().min(1),
	z.object({
		serverUrl: z.string().url(),
		authToken: z.string().min(1),
		project: z.string().min(1).optional(),
		fallbackTarget: z.string().min(1).optional(),
		environment: PiComsEnvironmentSchema,
		estates: z.array(z.string().min(1)),
	}),
);

function nonEmpty(value: string | undefined): string | undefined {
	return value && value !== "" ? value : undefined;
}

function readHubs(env: NodeJS.ProcessEnv): Record<string, PiComsHubConfig> {
	const raw = nonEmpty(env.PI_COMS_HUBS);
	if (raw !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(`PI_COMS_HUBS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const result = HubsJsonSchema.safeParse(parsed);
		if (!result.success) {
			const issues = result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
			throw new Error(`PI_COMS_HUBS is not a valid hubs map: ${issues}`);
		}
		const hubs: Record<string, PiComsHubConfig> = {};
		for (const [key, hub] of Object.entries(result.data)) {
			if (!hub) continue;
			hubs[key] = {
				serverUrl: hub.serverUrl,
				authToken: hub.authToken,
				project: hub.project ?? PI_COMS_DEFAULT_PROJECT,
				fallbackTarget: hub.fallbackTarget ?? PI_COMS_DEFAULT_FALLBACK_TARGET,
				environment: hub.environment,
				estates: hub.estates,
			};
		}
		return hubs;
	}
	const serverUrl = nonEmpty(env.PI_COMS_NET_SERVER_URL);
	const authToken = nonEmpty(env.PI_COMS_NET_AUTH_TOKEN);
	if (!serverUrl || !authToken) return {};
	const environment = PiComsEnvironmentSchema.parse(
		nonEmpty(env.PI_COMS_NET_ENVIRONMENT) ?? DEFAULT_SINGLE_HUB_ENVIRONMENT,
	);
	// SIO-1666: the legacy single-hub variables describe one hub, so it is keyed
	// by its environment name and claims the estates named in
	// PI_COMS_NET_ESTATES (comma-separated). With one hub there is nothing to
	// disambiguate; the list still has to exist, because routing is now explicit.
	return {
		[environment]: {
			serverUrl,
			authToken,
			project: nonEmpty(env.PI_COMS_NET_PROJECT) ?? PI_COMS_DEFAULT_PROJECT,
			fallbackTarget: nonEmpty(env.PI_COMS_FALLBACK_TARGET) ?? PI_COMS_DEFAULT_FALLBACK_TARGET,
			environment,
			estates: (nonEmpty(env.PI_COMS_NET_ESTATES) ?? "")
				.split(",")
				.map((e) => e.trim())
				.filter((e) => e !== ""),
		},
	};
}

export function isPiComsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = nonEmpty(env.PI_COMS_HUBS);
	if (raw !== undefined) {
		try {
			const parsed: unknown = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
		} catch {
			return false;
		}
	}
	return !!nonEmpty(env.PI_COMS_NET_SERVER_URL) && !!nonEmpty(env.PI_COMS_NET_AUTH_TOKEN);
}

function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		logger.warn({ name, raw, fallback }, "Invalid positive integer env value; using default");
		return fallback;
	}
	return n;
}

function readEstateAgentMap(raw: string | undefined): Record<string, string> {
	if (raw === undefined || raw.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		const result = z.record(z.string(), z.string()).safeParse(parsed);
		if (result.success) return result.data;
		logger.warn({ issues: result.error.issues.length }, "PI_COMS_ESTATE_AGENT_MAP is not a string map; ignoring");
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"PI_COMS_ESTATE_AGENT_MAP is not valid JSON; ignoring",
		);
	}
	return {};
}

// SIO-1655: a capability flag defaults ON. Only an explicit "false" or "0" turns
// a shipped feature off (kill-switch semantics, the HIL_LEARNING_ENABLED /
// RESOLVE_IDENTIFIERS_ENABLED idiom). Read at CALL time, so flipping one needs a
// restart rather than a redeploy.
function readCapability(raw: string | undefined): boolean {
	return raw !== "false" && raw !== "0";
}

// Defaults live here, not in the schema (project rule: no .default() in config schemas).
export function resolvePiComsConfig(env: NodeJS.ProcessEnv = process.env): PiComsConfig {
	return PiComsConfigSchema.parse({
		capabilities: {
			handoff: readCapability(env.PI_HANDOFF_ENABLED),
			inbox: readCapability(env.PI_COMS_INBOX_ENABLED),
			fleetGraph: readCapability(env.PI_FLEET_GRAPH_ENABLED),
		},
		hubs: readHubs(env),
		estateAgentMap: readEstateAgentMap(env.PI_COMS_ESTATE_AGENT_MAP),
		verifyTimeoutMs: readPositiveInt(
			env.PI_COMS_VERIFY_TIMEOUT_MS,
			DEFAULT_VERIFY_TIMEOUT_MS,
			"PI_COMS_VERIFY_TIMEOUT_MS",
		),
		investigateTimeoutMs: readPositiveInt(
			env.PI_COMS_INVESTIGATE_TIMEOUT_MS,
			DEFAULT_INVESTIGATE_TIMEOUT_MS,
			"PI_COMS_INVESTIGATE_TIMEOUT_MS",
		),
	});
}

// Wire shapes come from the hub's own contract (packages/pi-coms/contracts,
// SIO-1654) so the client cannot drift from the server.
export type PiMessageStatus = MessageStatus;
export type PiInboxMessage = InboxMessage;
// The subset of the hub's agent card the verifier routes on.
export type PiAgentCard = Pick<AgentCard, "session_id" | "name" | "status"> & Partial<Pick<AgentCard, "purpose">>;
export type PiSendResult = Pick<SendResponse, "msg_id" | "status" | "target_session">;

export type PiReply = {
	status: PiMessageStatus | "budget_exhausted";
	response: unknown;
	error: string | null;
};

export type PiSendOptions = {
	responseSchema?: object;
	// Above the hub's default message TTL (30 min) the send becomes a durable mailbox
	// entry that survives an offline recipient.
	ttlMs?: number;
	conversationId?: string | null;
};

// The hub reports a rejection as { error, details }, where details carries the
// operator-relevant nouns (a refused registration names the desired name and the
// principal that refused it -- coms-net-server.ts errorJson). SIO-1661: keep that
// detail on the error instead of discarding it, and let a caller that knows more
// than the transport append a line explaining the fix. The first line keeps the
// original format byte-for-byte: pi-fleet-http.ts and existing tests read it.
export class PiComsHttpError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details: PiComsErrorDetails;

	constructor(status: number, code: string, method: string, path: string, details: PiComsErrorDetails = {}) {
		super(`pi-coms hub ${method} ${path} failed: ${status} ${code}`);
		this.name = "PiComsHttpError";
		this.status = status;
		this.code = code;
		this.details = details;
	}

	// Returns a new error of the SAME type carrying extra explanatory lines.
	// Preserving the type matters: piFleetErrorResponse maps PiComsHttpError to
	// 502 and anything else to 500, so a plain Error here would change the status.
	withContext(...lines: string[]): PiComsHttpError {
		const next = new PiComsHttpError(this.status, this.code, "", "", this.details);
		next.message = [this.message, ...lines].join("\n");
		next.stack = this.stack;
		return next;
	}
}

export type PiComsErrorDetails = { name?: string; principal?: string };

// The hub's details object, narrowed. Unknown shapes degrade to {} rather than
// throwing: a diagnostic path must never be the thing that breaks the request.
function readErrorDetails(parsed: unknown): PiComsErrorDetails {
	if (typeof parsed !== "object" || parsed === null || !("details" in parsed)) return {};
	const raw = parsed.details;
	if (typeof raw !== "object" || raw === null) return {};
	const details: PiComsErrorDetails = {};
	if ("name" in raw && typeof raw.name === "string") details.name = raw.name;
	if ("principal" in raw && typeof raw.principal === "string") details.principal = raw.principal;
	return details;
}

// Directory-mode hubs bind names to principals and answer 409 name_taken when a
// live session already holds the name, so each short-lived registration takes a
// unique suffix. The principal's name list must therefore allow the prefix
// pattern "incident-analyzer-*" (see docs/architecture/pi-coms-verification.md).
export const PI_COMS_SENDER_NAME_PREFIX = "incident-analyzer";

export function senderNameFor(sessionId: string, prefix: string = PI_COMS_SENDER_NAME_PREFIX): string {
	return `${prefix}-${sessionId.replace(/-/g, "").slice(0, 8)}`;
}

// SIO-1665: a monitor registers as `monitor-<spoke>` (packages/pi-coms/scripts/
// fleet/tokens.ts mints the pair; the code default is `monitor-aws-<account>`).
// It is a deterministic checker with no model: it reports to the ops inbox but
// cannot answer a question, so it is never a send target. The hub card carries
// no role field, and `purpose` is agent-authored prose; the name is the one
// hub-controlled signal, so the prefix is the discriminator.
export const MONITOR_NAME_PREFIX = "monitor-";

export function isMonitorAgentName(name: string): boolean {
	return name.startsWith(MONITOR_NAME_PREFIX);
}

// A listing fit to address: every card the hub returned minus the monitors.
export function spokesOnly<T extends { name: string }>(agents: readonly T[]): T[] {
	return agents.filter((a) => !isMonitorAgentName(a.name));
}
// Under the hub's 30 s default await and its 30 s stale threshold: each slice is
// followed by a heartbeat so the sender stays online for the whole budget.
export const PI_COMS_AWAIT_SLICE_MS = 25_000;
const FETCH_GRACE_MS = 5_000;

type MessageStatusReply = {
	msg_id: string;
	status: PiMessageStatus;
	response: unknown;
	error: string | null;
};

function isTerminal(status: PiMessageStatus): boolean {
	return status === "complete" || status === "error" || status === "timeout";
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PiComsClientDeps = {
	fetchImpl?: FetchLike;
	now?: () => number;
	sessionId?: string;
	// Name prefix registered on the hub; the principal's name list must allow "<prefix>-*".
	senderPrefix?: string;
};

// SIO-1660: heartbeats are the one high-frequency hub call (one per await slice),
// so they log at debug while every other call logs at info.
function isHeartbeatPath(path: string): boolean {
	return path.endsWith("/heartbeat");
}

// Scoped to one hub: the caller picks the hub for the estate's environment
// (selectHubForEstate in pi-verifier.ts) so a request never crosses environments.
export class PiComsClient {
	readonly sessionId: string;
	private readonly hub: PiComsHubConfig;
	private readonly senderPrefix: string;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private registered = false;

	constructor(hub: PiComsHubConfig, deps: PiComsClientDeps = {}) {
		this.hub = hub;
		this.senderPrefix = deps.senderPrefix ?? PI_COMS_SENDER_NAME_PREFIX;
		this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
		this.now = deps.now ?? (() => Date.now());
		this.sessionId = deps.sessionId ?? crypto.randomUUID();
	}

	private async http<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
		const init: RequestInit = {
			method,
			headers: {
				authorization: `Bearer ${this.hub.authToken}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		};
		if (timeoutMs !== undefined) init.signal = AbortSignal.timeout(timeoutMs);
		// SIO-1660: every hub call funnels through here, so this is the one place
		// that has to be instrumented for a failure to be self-evident. A
		// name_not_allowed 403 on register cost a live-hub curl investigation
		// because this threw a fully-formed PiComsHttpError and logged nothing.
		//
		// NEVER log the request/response body, `hub`, or `authToken`: the shared
		// logger has no redaction, the token is a live secret, and bodies carry
		// prompts and spoke replies. Path is safe (it holds project/session ids,
		// no secrets). Identity and outcome only.
		const started = this.now();
		try {
			const resp = await this.fetchImpl(this.hub.serverUrl + path, init);
			const text = await resp.text();
			let parsed: unknown = null;
			if (text.length > 0) {
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = text;
				}
			}
			if (!resp.ok) {
				const code =
					typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
						? parsed.error
						: text.slice(0, 120) || "unknown";
				logger.warn(
					{ method, path, status: resp.status, error: code, duration_ms: this.now() - started },
					"pi.hub.call.failed",
				);
				throw new PiComsHttpError(resp.status, code, method, path, readErrorDetails(parsed));
			}
			// Heartbeats fire on a timer during every await slice; logging them at
			// info would bury the calls that matter under a beat every 25 s.
			if (isHeartbeatPath(path)) {
				logger.debug({ method, path, status: resp.status, duration_ms: this.now() - started }, "pi.hub.call");
			} else {
				logger.info({ method, path, status: resp.status, duration_ms: this.now() - started }, "pi.hub.call");
			}
			return parsed as T;
		} catch (error) {
			// A transport failure (tunnel down, DNS, abort) never reaches the
			// response branch above, and it is the other half of what went
			// undiagnosed: "fetch failed" with no indication of which hub call.
			if (!(error instanceof PiComsHttpError)) {
				logger.warn(
					{
						method,
						path,
						error: error instanceof Error ? error.message : String(error),
						duration_ms: this.now() - started,
					},
					"pi.hub.call.unreachable",
				);
			}
			throw error;
		}
	}

	async register(): Promise<void> {
		const name = senderNameFor(this.sessionId, this.senderPrefix);
		try {
			await this.registerAs(name);
		} catch (error) {
			// SIO-1661: this is the only frame that knows the name it just sent, and
			// a rejection is always ABOUT that name (403 name_not_allowed when no
			// principal covers it, 409 name_taken when a live session holds it). Kept
			// generic over the status: the hub uses one details shape for both.
			if (error instanceof PiComsHttpError) {
				const principal = error.details.principal;
				throw error.withContext(`  (sender "${name}"${principal ? `; principal "${principal}"` : ""})`);
			}
			throw error;
		}
	}

	private async registerAs(name: string): Promise<void> {
		await this.http("POST", "/v1/agents/register", {
			project: this.hub.project,
			session_id: this.sessionId,
			name,
			purpose: "DevOps incident analyzer: report verification and investigation handoff",
			model: "none",
			color: "#00174F",
			cwd: "",
			// Hidden from pool snapshots and peer listings: nobody should address us.
			explicit: true,
		});
		this.registered = true;
		// SIO-1660: the registered NAME is the thing that fails (name_not_allowed
		// when no principal permits this prefix), so it has to be in the log.
		logger.info(
			{ project: this.hub.project, name: senderNameFor(this.sessionId, this.senderPrefix) },
			"pi.hub.registered",
		);
	}

	async listAgents(): Promise<PiAgentCard[]> {
		const reply = await this.http<{ agents?: PiAgentCard[] }>(
			"GET",
			// include_explicit: an account agent registered with --explicit is still
			// addressable by name, so it must count as online here.
			`/v1/agents?project=${encodeURIComponent(this.hub.project)}&include_explicit=true`,
		);
		return reply.agents ?? [];
	}

	async send(target: string, prompt: string, opts: PiSendOptions = {}): Promise<PiSendResult> {
		const reply = await this.http<{ msg_id: string; status: PiMessageStatus; target_session: string | null }>(
			"POST",
			"/v1/messages",
			{
				project: this.hub.project,
				sender_session: this.sessionId,
				target,
				target_session: null,
				prompt,
				conversation_id: opts.conversationId ?? null,
				response_schema: opts.responseSchema ?? null,
				hops: 0,
				...(opts.ttlMs ? { ttl_ms: opts.ttlMs } : {}),
			},
		);
		// SIO-1660: prompt text is deliberately absent -- identity and outcome only.
		logger.info(
			{ project: this.hub.project, target, msg_id: reply.msg_id, status: reply.status },
			"pi.hub.message.sent",
		);
		return { msg_id: reply.msg_id, status: reply.status, target_session: reply.target_session ?? null };
	}

	async heartbeat(): Promise<void> {
		try {
			await this.http("POST", `/v1/agents/${encodeURIComponent(this.sessionId)}/heartbeat`, {
				project: this.hub.project,
				context_used_pct: 0,
				queue_depth: 0,
				status: "online",
			});
		} catch {
			// Transient: the hub still records the reply on the message; a reaped
			// sender only loses the SSE push we never subscribed to.
		}
	}

	// Long-polls in slices until the message is terminal or the budget is spent.
	// A slice that expires answers status "timeout" from the awaiter, not the
	// message, so it is confirmed against the non-blocking status endpoint.
	async awaitReply(msgId: string, budgetMs: number): Promise<PiReply> {
		const start = this.now();
		const path = `/v1/messages/${encodeURIComponent(msgId)}`;
		while (true) {
			const elapsed = this.now() - start;
			const remaining = budgetMs - elapsed;
			if (remaining <= 0) break;
			const slice = Math.min(PI_COMS_AWAIT_SLICE_MS, remaining);
			const reply = await this.http<MessageStatusReply>(
				"GET",
				`${path}/await?timeout_ms=${slice}`,
				undefined,
				slice + FETCH_GRACE_MS,
			);
			if (reply.status === "timeout") {
				const current = await this.http<MessageStatusReply>("GET", path);
				if (isTerminal(current.status)) {
					// SIO-1660: one summary per await, never the response body (it is
					// spoke-authored text). Logged at the exits rather than per slice,
					// which would emit a line every 25 s for a slow spoke.
					logger.info({ msg_id: msgId, status: current.status, duration_ms: this.now() - start }, "pi.hub.await.done");
					return { status: current.status, response: current.response ?? null, error: current.error ?? null };
				}
			} else if (isTerminal(reply.status)) {
				logger.info({ msg_id: msgId, status: reply.status, duration_ms: this.now() - start }, "pi.hub.await.done");
				return { status: reply.status, response: reply.response ?? null, error: reply.error ?? null };
			}
			await this.heartbeat();
		}
		// A spoke that never answers within budget is the common "it just hangs"
		// report; without this it looked identical to a silent success.
		logger.warn({ msg_id: msgId, budget_ms: budgetMs, duration_ms: this.now() - start }, "pi.hub.await.exhausted");
		return { status: "budget_exhausted", response: null, error: `no reply within ${budgetMs} ms` };
	}

	// The durable inbox: read-many, non-destructive, open to every authenticated
	// peer. `since` is the hub's ULID cursor; `limit` is capped at 100 by the hub.
	async mailbox(name: string, opts: { limit?: number; since?: string } = {}): Promise<PiInboxMessage[]> {
		const params = new URLSearchParams({ project: this.hub.project, name });
		if (opts.limit !== undefined) params.set("limit", String(opts.limit));
		if (opts.since !== undefined) params.set("since", opts.since);
		const reply = await this.http<InboxListing>("GET", `/v1/mailbox?${params.toString()}`);
		return reply.messages ?? [];
	}

	async deregister(): Promise<void> {
		if (!this.registered) return;
		this.registered = false;
		try {
			await this.http(
				"DELETE",
				`/v1/agents/${encodeURIComponent(this.sessionId)}?project=${encodeURIComponent(this.hub.project)}`,
			);
		} catch {
			// The hub reaps stale sessions on its own; a failed deregister is harmless.
		}
	}
}
