// packages/pi-coms/contracts/wire.ts
// Hub wire contract: the request and response shapes of scripts/coms-net-server.ts.
// Single source for the hub, the tests and the incident analyzer's hub client
// (SIO-1654). Types only: this file must stay dependency-free so the Pi package
// manifest does not grow a runtime dependency.

export type AgentStatus = "online" | "stale" | "offline";
// No in_progress state: dropped from v1.
export type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

export type AgentCard = {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	context_used_pct: number;
	queue_depth: number;
	status: AgentStatus;
};

export type ComsMessage = {
	msg_id: string;
	project: string;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	target_session: string | null; // null = queued by name, unclaimed
	target_name: string | null;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
	status: MessageStatus;
	mailbox: boolean; // requested TTL beyond the default: retained as inbox history until expiry
	response?: unknown;
	error?: string | null;
	created_at: string;
	delivered_at?: string;
	completed_at?: string;
	expires_at: string;
};

export type RegisterRequest = {
	project: string;
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	explicit: boolean;
};

export type RegisterResponse = {
	ok: true;
	agent: AgentCard;
	heartbeat_interval_ms: number;
	sse_url: string;
};

export type HeartbeatRequest = {
	project: string;
	context_used_pct: number;
	queue_depth: number;
	model?: string;
	status?: AgentStatus;
};

export type SendRequest = {
	project: string;
	sender_session: string;
	target: string;
	target_session: string | null;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
	ttl_ms?: number | null;
};

export type SendResponse = {
	ok: true;
	msg_id: string;
	status: MessageStatus;
	target_session: string | null;
};

export type ResponseSubmitRequest = {
	project: string;
	responder_session: string;
	response: unknown;
	error: string | null;
};

export type ErrorResponse = { ok: false; error: string; details?: unknown };

// Response envelopes the hub builds (see handleListAgents, handleInbox, handleGetMessage).
export type AgentListing = { agents: AgentCard[] };

export type InboxMessage = {
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

export type InboxListing = { ok: true; name: string; messages: InboxMessage[] };

export type MessageLookup = { msg_id: string; status: MessageStatus; response: unknown; error: string | null };
