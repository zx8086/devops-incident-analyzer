// packages/agent/src/landing-zone/state.ts

import type {
	EvidenceItem,
	EvidenceReconciliation,
	LandingZoneRiskAssessment,
	ResponseCitation,
	TopologyEvidenceState,
} from "@devops-agent/shared";
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { LandingZoneIntent, LandingZoneOutcome, ProposedChangeReview } from "./types.ts";

const replace = <T>(fallback: T) => ({
	reducer: (_previous: T, next: T) => next,
	default: () => fallback,
});

export const LandingZoneState = Annotation.Root({
	...MessagesAnnotation.spec,
	requestId: Annotation<string>(replace("")),
	intent: Annotation<LandingZoneIntent>(replace<LandingZoneIntent>("understand")),
	repositoryScope: Annotation<string[]>(replace<string[]>([])),
	accountScope: Annotation<string[]>(replace<string[]>([])),
	selectedKnowledge: Annotation<string[]>(replace<string[]>([])),
	evidenceResults: Annotation<EvidenceItem[]>(replace<EvidenceItem[]>([])),
	reconciliation: Annotation<EvidenceReconciliation | null>(replace<EvidenceReconciliation | null>(null)),
	risk: Annotation<LandingZoneRiskAssessment | null>(replace<LandingZoneRiskAssessment | null>(null)),
	response: Annotation<string | null>(replace<string | null>(null)),
	responseCitations: Annotation<ResponseCitation[]>(replace<ResponseCitation[]>([])),
	topologyStates: Annotation<TopologyEvidenceState[]>(replace<TopologyEvidenceState[]>([])),
	blockedReason: Annotation<string | null>(replace<string | null>(null)),
	outcome: Annotation<LandingZoneOutcome>(replace<LandingZoneOutcome>("pending")),
	proposedChangeReview: Annotation<ProposedChangeReview | null>(replace<ProposedChangeReview | null>(null)),
});

export type LandingZoneStateType = typeof LandingZoneState.State;
