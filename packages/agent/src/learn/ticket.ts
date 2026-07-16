// agent/src/learn/ticket.ts
//
// SIO-1126: fetch + parse the Jira ticket for the HIL learning lane. The fetch is
// a DIRECT MCP invoke of atlassian_getJiraIssue with fields:"*" (the
// resolve-identifiers pattern): "*" skips the wrapper's 4KB description
// truncation (the agent's incident report IS the description), and a direct
// invoke bypasses SUBAGENT_TOOL_RESULT_CAP_BYTES, which only applies inside the
// sub-agent LLM loop. Parsing is pure and fixture-tested; comment bodies may be
// plain strings or ADF documents depending on the upstream proxy, so the
// flattener tolerates both and never throws.

import { isKnowledgeGraphEnabled } from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { getToolsForDataSource } from "../mcp-bridge.ts";
import type { AgentStateType } from "../state.ts";
import { normalizeToolContent } from "../sub-agent.ts";
import { isHilLearningEnabled } from "./config.ts";

const logger = getLogger("agent:learn:ticket");

export interface TicketComment {
	author: string;
	createdAt: string;
	body: string;
}

export interface TicketResolution {
	key: string;
	summary: string;
	status: string;
	resolutionDate?: string;
	description: string;
	comments: TicketComment[];
}

// SIO-1126: match-gate candidate shape lives in shared (the web app renders it);
// re-exported here so lane modules and state.ts import it locally.
export type { HilMatchCandidate } from "@devops-agent/shared";

// Flatten a Jira field value into plain text. Handles plain strings, ADF
// documents ({type:"doc",content:[...]}), and arrays; falls back to JSON so a
// surprising shape degrades to something the LLM can still read.
export function flattenAtlassianText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	// Inline siblings (text nodes) concatenate directly; block-level nodes
	// (paragraph/doc) append their own trailing newline below.
	if (Array.isArray(value)) return value.map(flattenAtlassianText).filter(Boolean).join("");
	if (typeof value === "object") {
		const node = value as { text?: unknown; content?: unknown; type?: unknown };
		const parts: string[] = [];
		if (typeof node.text === "string") parts.push(node.text);
		if (Array.isArray(node.content)) parts.push(flattenAtlassianText(node.content));
		if (parts.length > 0) {
			// Paragraph-level nodes read better with a line break between blocks.
			return node.type === "paragraph" || node.type === "doc" ? `${parts.join("")}\n` : parts.join("");
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

// The Rovo proxy wraps mentions/smartlinks in <custom ...>...</custom> tags;
// strip the tags but keep the inner text.
function stripCustomTags(text: string): string {
	return text.replace(/<\/?custom[^>]*>/g, "");
}

function cleanBody(value: unknown): string {
	return stripCustomTags(flattenAtlassianText(value)).trim();
}

interface RawComment {
	author?: { displayName?: unknown } | string;
	created?: unknown;
	body?: unknown;
}

// Parse the atlassian_getJiraIssue payload (already normalized to a string by
// normalizeToolContent). Returns null when the payload is unparseable or has no
// issue fields -- the caller soft-fails the lane with a user-facing message.
export function parseJiraIssuePayload(raw: unknown, key: string): TicketResolution | null {
	const text = typeof raw === "string" ? raw : JSON.stringify(raw);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		logger.warn({ key }, "Jira issue payload was not valid JSON");
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const issue = parsed as { key?: unknown; fields?: Record<string, unknown> };
	const fields = issue.fields;
	if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) return null;

	const status = fields.status as { name?: unknown } | undefined;
	const commentField = fields.comment as { comments?: unknown } | undefined;
	const rawComments = Array.isArray(commentField?.comments) ? (commentField.comments as RawComment[]) : [];

	const comments: TicketComment[] = rawComments.map((c) => {
		const author =
			typeof c.author === "string" ? c.author : typeof c.author?.displayName === "string" ? c.author.displayName : "";
		return {
			author,
			createdAt: typeof c.created === "string" ? c.created : "",
			body: cleanBody(c.body),
		};
	});

	return {
		key: typeof issue.key === "string" ? issue.key : key,
		summary: typeof fields.summary === "string" ? fields.summary : "",
		status: typeof status?.name === "string" ? status.name : "",
		resolutionDate: typeof fields.resolutiondate === "string" ? fields.resolutiondate : undefined,
		description: cleanBody(fields.description),
		comments,
	};
}

// Cap the ticket for the distiller prompt. Per-body caps first; if the total
// still exceeds the budget, drop the OLDEST comments -- resolution comments
// arrive late, and the description (the agent's own report) is head-truncated
// last because the distiller mainly needs its conclusions, which lead.
const DEFAULT_PER_BODY_CHARS = 6_000;
const DEFAULT_TOTAL_CHARS = 28_000;
const DESCRIPTION_HEAD_CHARS = 10_000;

function capText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated]`;
}

export function capTicketForPrompt(
	ticket: TicketResolution,
	opts?: { perBodyChars?: number; totalChars?: number },
): TicketResolution {
	const perBody = opts?.perBodyChars ?? DEFAULT_PER_BODY_CHARS;
	const total = opts?.totalChars ?? DEFAULT_TOTAL_CHARS;

	let description = capText(ticket.description, DESCRIPTION_HEAD_CHARS);
	let comments = ticket.comments.map((c) => ({ ...c, body: capText(c.body, perBody) }));

	const size = () => description.length + comments.reduce((n, c) => n + c.body.length, 0);
	while (size() > total && comments.length > 1) {
		comments = comments.slice(1);
	}
	if (size() > total) {
		description = capText(description, Math.max(2_000, total - (comments[0]?.body.length ?? 0)));
	}
	return { ...ticket, description, comments };
}

const FETCH_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`ticket fetch timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function laneAbort(reason: string, userMessage: string): Partial<AgentStateType> {
	return {
		messages: [new AIMessage(userMessage)],
		partialFailures: [{ node: "learnFetchTicket", reason }],
	};
}

// learnFetchTicket node: fetch + parse the ticket into state.hilTicket. Any
// failure ends the lane with a user-facing message (the router edge goes to END
// when hilTicket is unset) -- learning never leaves the thread wedged.
export async function learnFetchTicket(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const key = state.hilLearnTicketKey;
	if (!key || !isHilLearningEnabled()) return {};

	if (!isKnowledgeGraphEnabled()) {
		return laneAbort(
			"knowledge-graph-disabled",
			`Learning from ${key} needs the knowledge graph (KNOWLEDGE_GRAPH_ENABLED=true) so the resolution can be matched to a stored incident and written back. It is currently disabled, so nothing was recorded.`,
		);
	}

	const tool = getToolsForDataSource("atlassian").find((t) => t.name === "atlassian_getJiraIssue");
	if (!tool) {
		return laneAbort(
			"atlassian-tool-unavailable",
			`Learning from ${key} needs the Atlassian MCP server (atlassian_getJiraIssue), which is not connected. Nothing was recorded.`,
		);
	}

	try {
		// fields:"*" is required: the wrapper truncates description to 4KB for any
		// projected field list, and the agent's report is the description. The
		// 64KB result cap only applies inside the sub-agent loop, not here.
		const raw = normalizeToolContent(
			await withTimeout(tool.invoke({ issueIdOrKey: key, fields: "*" }), FETCH_TIMEOUT_MS),
		);
		const ticket = parseJiraIssuePayload(raw, key);
		if (!ticket) {
			return laneAbort(
				"ticket-parse-failed",
				`I could not parse ${key} from Jira (empty or unexpected payload). Nothing was recorded.`,
			);
		}
		if (ticket.comments.length === 0 && ticket.description.length === 0) {
			return laneAbort("ticket-empty", `${key} has no description or comments to learn from. Nothing was recorded.`);
		}
		logger.info({ key, comments: ticket.comments.length }, "Fetched ticket for HIL learning");
		return { hilTicket: capTicketForPrompt(ticket) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ key, error: message }, "HIL ticket fetch failed");
		return laneAbort("ticket-fetch-failed", `Fetching ${key} from Jira failed (${message}). Nothing was recorded.`);
	}
}

export interface HilMatchDecision {
	incidentId: string | null;
}

// learnMatchGate node: interrupt #1. Compute (learnMatchIncident) and interrupt
// are split across nodes because LangGraph re-executes an interrupted node from
// its top on resume -- the gate holds only the interrupt + state mapping.
export function learnMatchGate(state: AgentStateType): Partial<AgentStateType> {
	const key = state.hilLearnTicketKey;
	const ticket = state.hilTicket;
	if (!key || !ticket) return {};

	const choice = interrupt({
		type: "hil_learning_match",
		ticketKey: key,
		ticketSummary: ticket.summary,
		candidates: state.hilMatchCandidates,
		message:
			state.hilMatchCandidates.length > 0
				? `Which prior investigation does ${key} correspond to?`
				: `No stored investigation matches ${key}; a new incident record will be created from the ticket.`,
	}) as HilMatchDecision;

	const picked = choice?.incidentId ?? null;
	return {
		hilMatch: picked ? { incidentId: picked, created: false } : { incidentId: `jira:${key}`, created: true },
	};
}
