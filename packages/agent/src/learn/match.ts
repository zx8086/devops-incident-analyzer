// agent/src/learn/match.ts
//
// SIO-1126: match the fetched ticket to a stored KG Incident. Vector KNN over
// Incident.embedding (the graphEnrich machinery) plus a deterministic pin for
// any incident whose summary literally mentions the ticket key. The human
// confirms the match in the learnMatchGate interrupt (ticket.ts); "none of
// these" makes applyLearnings create a fresh Incident keyed jira:<key>.

import { getGraphStore, rootCauseForIncident, similarIncidents } from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { truncateForEmbedding } from "@devops-agent/shared";
import { AIMessage } from "@langchain/core/messages";
import { getEmbedder } from "../graph-knowledge.ts";
import type { AgentStateType } from "../state.ts";
import type { HilMatchCandidate } from "./ticket.ts";

const logger = getLogger("agent:learn:match");

const MAX_CANDIDATES = 3;

export function buildMatchEmbedText(summary: string, description: string): string {
	return truncateForEmbedding(`${summary}\n${description}`);
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
