// agent/src/pi-verdict-memory.ts
//
// SIO-1651: turns a pi spoke's verdict into a durable key decision. Both the
// SIO-1635 card path (executePiVerify) and the pi-handoff workflow write
// through here, so a verdict is remembered identically however it was asked
// for.
//
// STRUCTURED FIELDS ONLY. recordKeyDecision renders `decision` into
// key-decisions.md AND forwards it to the agent-memory backend as a durable
// fact, and that text is rendered into the next turn's prompt. A verdict
// carries free text the spoke's model wrote (summary, claims[].evidence,
// additional_observations, recommended_investigation) -- none of it may enter
// memory, because a hub reply is data and must never become an LLM input
// (standing invariant since PR #682). Only enums, counts and ids cross this
// boundary.

import { getLogger } from "@devops-agent/observability";
import type { AnnotationMap, PiVerdict } from "@devops-agent/shared";
import { type KeyDecision, recordKeyDecision } from "./memory-writer.ts";

const logger = getLogger("agent:piVerdictMemory");

export interface VerdictDecisionInput {
	estate: string;
	target: string;
	msgId: string;
	requestId: string;
	verdict: PiVerdict;
}

export interface ClaimTally {
	confirmed: number;
	contradicted: number;
	unverifiable: number;
}

export function tallyClaims(verdict: PiVerdict): ClaimTally {
	const tally: ClaimTally = { confirmed: 0, contradicted: 0, unverifiable: 0 };
	for (const claim of verdict.claims) tally[claim.status] += 1;
	return tally;
}

// Every interpolated value is an enum member, a number, or an id the analyzer
// itself chose (estate, target, msg id) -- never spoke-authored prose.
export function buildVerdictDecision(input: VerdictDecisionInput): KeyDecision {
	const tally = tallyClaims(input.verdict);
	const decision = [
		`pi verify ${input.estate}: ${input.verdict.verdict}`,
		`(claims: ${tally.confirmed} confirmed, ${tally.contradicted} contradicted, ${tally.unverifiable} unverifiable)`,
		`target ${input.target}`,
		`msg ${input.msgId}`,
	].join(" ");

	const annotations: AnnotationMap = {
		kind: "pi-verify",
		estate: input.estate,
		target: input.target,
		verdict: input.verdict.verdict,
		msg_id: input.msgId,
		claims_confirmed: String(tally.confirmed),
		claims_contradicted: String(tally.contradicted),
		claims_unverifiable: String(tally.unverifiable),
	};

	// No `rationale`: it is redacted-but-rendered free text, and nothing
	// structured needs it. The annotations carry everything a later session
	// filters on.
	return { requestId: input.requestId, decision, annotations };
}

// Never throws: a memory write must not change the outcome of a verify that
// already succeeded (the card still renders, the workflow still reports).
export function recordVerdictDecision(input: VerdictDecisionInput): void {
	try {
		recordKeyDecision(buildVerdictDecision(input));
	} catch (error) {
		logger.warn(
			{
				estate: input.estate,
				msg_id: input.msgId,
				error: error instanceof Error ? error.message : String(error),
			},
			"pi verdict key-decision write failed; verify outcome unaffected",
		);
	}
}
