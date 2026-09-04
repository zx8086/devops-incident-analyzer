// agent/src/action-tools/pi-coms-client.ts
// SIO-1635: minimal client for the pi-coms hub (plain HTTP, no SSE). One short-lived
// registration per action: the hub requires a registered sender to send, but a reaped
// sender does not break /await or the target's reply, so we register, send, await,
// and deregister inside a single executeAction call.
import type { PiComsConfig } from "@devops-agent/shared";

export type PiMessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

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

export const PI_COMS_SENDER_NAME = "incident-analyzer";
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

export class PiComsClient {
	readonly sessionId: string;
	private readonly config: PiComsConfig;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private registered = false;

	constructor(config: PiComsConfig, deps: { fetchImpl?: FetchLike; now?: () => number; sessionId?: string } = {}) {
		this.config = config;
		this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
		this.now = deps.now ?? (() => Date.now());
		this.sessionId = deps.sessionId ?? crypto.randomUUID();
	}

	private async http<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
		const init: RequestInit = {
			method,
			headers: {
				authorization: `Bearer ${this.config.authToken}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		};
		if (timeoutMs !== undefined) init.signal = AbortSignal.timeout(timeoutMs);
		const resp = await this.fetchImpl(this.config.serverUrl + path, init);
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
			project: this.config.project,
			session_id: this.sessionId,
			name: PI_COMS_SENDER_NAME,
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
			`/v1/agents?project=${encodeURIComponent(this.config.project)}&include_explicit=true`,
		);
		return reply.agents ?? [];
	}

	async send(target: string, prompt: string, opts: PiSendOptions = {}): Promise<PiSendResult> {
		const reply = await this.http<{ msg_id: string; status: PiMessageStatus; target_session: string | null }>(
			"POST",
			"/v1/messages",
			{
				project: this.config.project,
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

	private async heartbeat(): Promise<void> {
		try {
			await this.http("POST", `/v1/agents/${encodeURIComponent(this.sessionId)}/heartbeat`, {
				project: this.config.project,
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

	async deregister(): Promise<void> {
		if (!this.registered) return;
		this.registered = false;
		try {
			await this.http(
				"DELETE",
				`/v1/agents/${encodeURIComponent(this.sessionId)}?project=${encodeURIComponent(this.config.project)}`,
			);
		} catch {
			// The hub reaps stale sessions on its own; a failed deregister is harmless.
		}
	}
}
