// agent/src/learn/match.ts
//
// SIO-1126: match the fetched ticket to a stored KG Incident. Vector KNN over
// Incident.embedding (the graphEnrich machinery) plus a deterministic pin for
// any incident whose summary literally mentions the ticket key. The human
// confirms the match in the learnMatchGate interrupt (ticket.ts); "none of
// these" makes applyLearnings create a fresh Incident keyed jira:<key>.

import {
	getGraphStore,
	incidentById,
	incidentByTicketKey,
	rootCauseForIncident,
	similarIncidents,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { truncateForEmbedding } from "@devops-agent/shared";
import { AIMessage } from "@langchain/core/messages";
import { getEmbedder } from "../graph-knowledge.ts";
import type { AgentStateType } from "../state.ts";
import type { HilMatchCandidate } from "./ticket.ts";

const logger = getLogger("agent:learn:match");

const MAX_CANDIDATES = 3;

// SIO-1132: prefer the ticket's Executive Summary section as the embedding
// input. The stored Incident.embedding vectors are embeddings of the ORIGINAL
// USER QUERY (short symptom text, graphEnrich), so summary-vs-summary is the
// correctly aligned pair -- embedding the whole pasted report dilutes the
// vector with boilerplate (headers, findings tables, estate lists) that every
// report shares, hurting discrimination between different incidents.
//
// After ADF flattening the heading may arrive as "## Executive Summary",
// "**Executive Summary**", or a BARE "Executive Summary" line. Capture the
// prose that follows until the next heading-like line, bounded by a char cap.
const EXEC_SUMMARY_MAX_CHARS = 2_000;
const HEADING_LINE = /^(#{1,6}\s|-{3,}\s*$|\*\*[^*]+\*\*:?\s*$)/;

export function extractExecutiveSummary(description: string): string | null {
	const lines = description.split("\n");
	const isExecHeading = (line: string) =>
		/^executive summary:?$/i.test(
			line
				.trim()
				.replace(/^#{1,6}\s*/, "")
				.replace(/[*_]/g, "")
				.trim(),
		);
	const start = lines.findIndex(isExecHeading);
	if (start === -1) return null;

	const captured: string[] = [];
	let length = 0;
	for (const line of lines.slice(start + 1)) {
		if (HEADING_LINE.test(line.trim())) break;
		captured.push(line);
		length += line.length + 1;
		if (length >= EXEC_SUMMARY_MAX_CHARS) break;
	}
	// Surrogate-safe cap (PR #397 review): a bare slice can split a non-BMP char.
	const text = truncateForEmbedding(captured.join("\n").trim(), EXEC_SUMMARY_MAX_CHARS);
	return text.length > 0 ? text : null;
}

export function buildMatchEmbedText(summary: string, description: string): string {
	const execSummary = extractExecutiveSummary(description);
	// Fallback (no Executive Summary section, e.g. a non-agent ticket): the
	// original head-truncated summary+description behavior.
	return truncateForEmbedding(`${summary}\n${execSummary ?? description}`);
}

// SIO-1133: pull the stamped Request-Id(s) out of a pasted report. The aggregator footer is
// `**Request-Id:** <uuid>`, but ADF flattening / markdown may leave or strip the bold `**`
// markers, so tolerate any run of non-hex separators (asterisks, spaces, colons) between the
// label and the UUID. Case-insensitive; returns ALL matches in text order, lowercased +
// deduped -- a stale footer in an early comment must not hide a valid id in a later one
// (CodeRabbit PR #405). The caller queries each until incidentById hits.
const REQUEST_ID_RE = /Request-Id[:*\s]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
export function extractRequestIds(text: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(REQUEST_ID_RE)) {
		const id = match[1]?.toLowerCase();
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

// learnMatchIncident node: compute candidates + the ticket embedding. Pure
// compute -- the interrupt lives in learnMatchGate so a resume never re-runs
// the embed/KNN. Soft-fails to zero candidates ("none" -> create incident).
export async function learnMatchIncident(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const ticket = state.hilTicket;
	if (!ticket) return {};

	let embedding: number[] = [];
	const candidates: HilMatchCandidate[] = [];
	let pinFailed = false;
	let vectorFailed = false;
	try {
		const store = await getGraphStore();

		// SIO-1134: exact curated lookup FIRST. When a Jira ticket was created from
		// this incident's report (or a prior learn confirmed the match), the key is
		// on the Incident node -- a traditional exact search, no embeddings needed.
		try {
			const curated = await incidentByTicketKey(store, ticket.key);
			if (curated) {
				let hasRootCause = false;
				try {
					hasRootCause = (await rootCauseForIncident(store, curated.id)) !== null;
				} catch {
					// annotation only
				}
				logger.info({ ticket: ticket.key, incidentId: curated.id }, "HIL match resolved by curated ticket link");
				return {
					hilMatchCandidates: [
						{
							id: curated.id,
							summary: curated.summary,
							severity: curated.severity,
							distance: 0,
							hasRootCause,
							via: "ticket-link",
						},
					],
					hilTicketEmbedding: [],
				};
			}
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"curated ticket-link lookup failed; falling back to matching",
			);
		}

		// SIO-1133: exact Request-Id lookup. A report pasted by hand into the ticket carries
		// the deterministic footer `**Request-Id:** <uuid>`, and that uuid IS the KG Incident
		// node id. Scan description + comments; on a hit that exists in the KG, resolve directly
		// (no embeddings) -- authoritative like ticket-link. A stale/foreign id that is not in
		// the KG falls through to the pin/vector fallback below.
		try {
			const haystack = [ticket.description, ...ticket.comments.map((c) => c.body)].join("\n");
			// Query every stamped id in text order until one resolves in the KG -- a stale
			// footer must not shadow a valid id in a later comment (CodeRabbit PR #405).
			for (const requestId of extractRequestIds(haystack)) {
				const incident = await incidentById(store, requestId);
				if (!incident) continue;
				let hasRootCause = false;
				try {
					hasRootCause = (await rootCauseForIncident(store, incident.id)) !== null;
				} catch {
					// annotation only
				}
				logger.info({ ticket: ticket.key, incidentId: incident.id }, "HIL match resolved by report Request-Id");
				return {
					hilMatchCandidates: [
						{
							id: incident.id,
							summary: incident.summary,
							severity: incident.severity,
							distance: 0,
							hasRootCause,
							via: "request-id",
						},
					],
					hilTicketEmbedding: [],
				};
			}
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Request-Id scan failed; falling back to matching",
			);
		}

		// Deterministic pin: the original investigation prompt may have mentioned
		// the ticket key, in which case its Incident summary carries it verbatim.
		try {
			const pinned = await store.run<{ id: string; summary: string; severity: string }>(
				"MATCH (i:Incident) WHERE i.summary CONTAINS $key RETURN i.id AS id, i.summary AS summary, i.severity AS severity LIMIT 3",
				{ key: ticket.key },
			);
			for (const row of pinned) {
				candidates.push({
					id: String(row.id),
					summary: String(row.summary ?? ""),
					severity: String(row.severity ?? ""),
					distance: 0,
					hasRootCause: false,
					via: "ticket-mention",
				});
			}
		} catch (error) {
			pinFailed = true;
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"ticket-mention pin query failed; vector match only",
			);
		}

		try {
			embedding = await getEmbedder()(buildMatchEmbedText(ticket.summary, ticket.description));
			const nearest = await similarIncidents(store, embedding, MAX_CANDIDATES + candidates.length);
			for (const inc of nearest) {
				if (candidates.some((c) => c.id === inc.id)) continue;
				candidates.push({
					id: inc.id,
					summary: inc.summary,
					severity: inc.severity,
					distance: inc.distance,
					hasRootCause: false,
					via: "vector",
				});
			}
		} catch (error) {
			vectorFailed = true;
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"similarity lookup failed; continuing with pinned candidates only",
			);
		}

		// A matching OUTAGE is not a zero-match result: when neither strategy
		// completed, offering only "create new" would mint a duplicate incident.
		// Abort the lane instead (CodeRabbit, PR #392). Clearing hilTicket makes
		// the downstream gates self-skip, so the turn ends with this message.
		if (pinFailed && vectorFailed && candidates.length === 0) {
			return {
				hilTicket: undefined,
				messages: [
					new AIMessage(
						`Matching ${ticket.key} against stored investigations failed (knowledge graph or embedding service unavailable). Nothing was recorded; please try again.`,
					),
				],
				partialFailures: [{ node: "learnMatchIncident", reason: "match-unavailable" }],
			};
		}

		const top = candidates.slice(0, MAX_CANDIDATES);
		// Annotate with existing root causes so the match card can show "already
		// has a recorded cause" -- a correction will replace it.
		await Promise.all(
			top.map(async (c) => {
				try {
					c.hasRootCause = (await rootCauseForIncident(store, c.id)) !== null;
				} catch {
					// annotation only; keep false
				}
			}),
		);

		logger.info({ ticket: ticket.key, candidates: top.length }, "HIL match candidates computed");
		return { hilMatchCandidates: top, hilTicketEmbedding: embedding };
	} catch (error) {
		// Store entirely unavailable: same outage-vs-zero-match rule as above.
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"HIL incident matching failed; aborting the lane",
		);
		return {
			hilTicket: undefined,
			messages: [
				new AIMessage(
					`Matching ${ticket.key} against stored investigations failed (knowledge graph unavailable). Nothing was recorded; please try again.`,
				),
			],
			partialFailures: [{ node: "learnMatchIncident", reason: "match-unavailable" }],
		};
	}
}
