// agent/src/landing-zone/state.ts

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type {
	LandingZoneEvidenceResult,
	LandingZoneIntent,
	LandingZoneOutcome,
	LandingZoneReconciliation,
	LandingZoneRisk,
	ProposedChangeReview,
} from "./types.ts";

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
	evidenceResults: Annotation<LandingZoneEvidenceResult[]>(replace<LandingZoneEvidenceResult[]>([])),
	reconciliation: Annotation<LandingZoneReconciliation | null>(replace<LandingZoneReconciliation | null>(null)),
	risk: Annotation<LandingZoneRisk | null>(replace<LandingZoneRisk | null>(null)),
	response: Annotation<string | null>(replace<string | null>(null)),
	blockedReason: Annotation<string | null>(replace<string | null>(null)),
	outcome: Annotation<LandingZoneOutcome>(replace<LandingZoneOutcome>("pending")),
	proposedChangeReview: Annotation<ProposedChangeReview | null>(replace<ProposedChangeReview | null>(null)),
});

export type LandingZoneStateType = typeof LandingZoneState.State;
