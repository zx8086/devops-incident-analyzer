// agent/src/action-tools/pi-coms-client.ts
// SIO-1635: minimal client for the pi-coms hub (plain HTTP, no SSE). One short-lived
// registration per action: the hub requires a registered sender to send, but a reaped
// sender does not break /await or the target's reply, so we register, send, await,
// and deregister inside a single executeAction call.
import { getLogger } from "@devops-agent/observability";
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

const HubsJsonSchema = z.partialRecord(
	PiComsEnvironmentSchema,
	z.object({
		serverUrl: z.string().url(),
		authToken: z.string().min(1),
		project: z.string().min(1).optional(),
		fallbackTarget: z.string().min(1).optional(),
	}),
);

function nonEmpty(value: string | undefined): string | undefined {
	return value && value !== "" ? value : undefined;
}

function readHubs(env: NodeJS.ProcessEnv): Partial<Record<PiComsEnvironment, PiComsHubConfig>> {
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
		const hubs: Partial<Record<PiComsEnvironment, PiComsHubConfig>> = {};
		for (const [environment, hub] of Object.entries(result.data)) {
			if (!hub) continue;
			hubs[environment as PiComsEnvironment] = {
				serverUrl: hub.serverUrl,
				authToken: hub.authToken,
				project: hub.project ?? PI_COMS_DEFAULT_PROJECT,
				fallbackTarget: hub.fallbackTarget ?? PI_COMS_DEFAULT_FALLBACK_TARGET,
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
	return {
		[environment]: {
			serverUrl,
			authToken,
			project: nonEmpty(env.PI_COMS_NET_PROJECT) ?? PI_COMS_DEFAULT_PROJECT,
			fallbackTarget: nonEmpty(env.PI_COMS_FALLBACK_TARGET) ?? PI_COMS_DEFAULT_FALLBACK_TARGET,
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

// Defaults live here, not in the schema (project rule: no .default() in config schemas).
export function resolvePiComsConfig(env: NodeJS.ProcessEnv = process.env): PiComsConfig {
	return PiComsConfigSchema.parse({
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

export type PiMessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

// One row of the hub's durable inbox (GET /v1/mailbox); mirrors the hub's
// InboxMessage contract in packages/pi-coms/contracts/wire.ts (SIO-1654).
export type PiInboxMessage = {
	msg_id: string;
	sender_name: string;
	target_name: string | null;
	prompt: string;
	status: string;
	error: string | null;
	response: unknown;
	created_at: string;
	delivered_at: string | null;
	completed_at: string | null;
};

export type PiAgentCard = {
	session_id: string;
	name: string;
	status: string;
	purpose?: string;
};

export type PiSendResult = {
	msg_id: string;
	status: PiMessageStatus;
	target_session: string | null;
};

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

export class PiComsHttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, method: string, path: string) {
		super(`pi-coms hub ${method} ${path} failed: ${status} ${code}`);
		this.name = "PiComsHttpError";
		this.status = status;
		this.code = code;
	}
}

// Directory-mode hubs bind names to principals and answer 409 name_taken when a
// live session already holds the name, so each short-lived registration takes a
// unique suffix. The principal's name list must therefore allow the prefix
// pattern "incident-analyzer-*" (see docs/architecture/pi-coms-verification.md).
export const PI_COMS_SENDER_NAME_PREFIX = "incident-analyzer";

export function senderNameFor(sessionId: string, prefix: string = PI_COMS_SENDER_NAME_PREFIX): string {
	return `${prefix}-${sessionId.replace(/-/g, "").slice(0, 8)}`;
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
			throw new PiComsHttpError(resp.status, code, method, path);
		}
		return parsed as T;
	}

	async register(): Promise<void> {
		await this.http("POST", "/v1/agents/register", {
			project: this.hub.project,
			session_id: this.sessionId,
			name: senderNameFor(this.sessionId, this.senderPrefix),
			purpose: "DevOps incident analyzer: report verification and investigation handoff",
			model: "none",
			color: "#00174F",
			cwd: "",
			// Hidden from pool snapshots and peer listings: nobody should address us.
			explicit: true,
		});
		this.registered = true;
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
					return { status: current.status, response: current.response ?? null, error: current.error ?? null };
				}
			} else if (isTerminal(reply.status)) {
				return { status: reply.status, response: reply.response ?? null, error: reply.error ?? null };
			}
			await this.heartbeat();
		}
		return { status: "budget_exhausted", response: null, error: `no reply within ${budgetMs} ms` };
	}

	// The durable inbox: read-many, non-destructive, open to every authenticated
	// peer. `since` is the hub's ULID cursor; `limit` is capped at 100 by the hub.
	async mailbox(name: string, opts: { limit?: number; since?: string } = {}): Promise<PiInboxMessage[]> {
		const params = new URLSearchParams({ project: this.hub.project, name });
		if (opts.limit !== undefined) params.set("limit", String(opts.limit));
		if (opts.since !== undefined) params.set("since", opts.since);
		const reply = await this.http<{ ok: true; name: string; messages?: PiInboxMessage[] }>(
			"GET",
			`/v1/mailbox?${params.toString()}`,
		);
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
