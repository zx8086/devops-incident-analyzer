// packages/agent/src/landing-zone/state.ts

import type {
	EvidenceItem,
	EvidenceReconciliation,
	LandingZoneRiskAssessment,
	LandingZoneTopologyEvent,
	ResponseCitation,
	TopologyEvidenceState,
} from "@devops-agent/shared";
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { EvidenceCollectionOutcome } from "./evidence.ts";
import type {
	LandingZoneCandidate,
	LandingZoneCandidateValidation,
	LandingZoneIntent,
	LandingZoneMergeRequest,
	LandingZoneOutcome,
	LandingZonePipelineObservation,
	LandingZonePriorMemory,
	LandingZoneReviewDecision,
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
	authorizedAccountScope: Annotation<string[]>(replace<string[]>([])),
	selectedKnowledge: Annotation<string[]>(replace<string[]>([])),
	gitlabEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	okfEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	terraformDocsEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	awsDocsEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	awsApiEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	memoryEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	knowledgeGraphEvidence: Annotation<EvidenceCollectionOutcome | null>(replace<EvidenceCollectionOutcome | null>(null)),
	evidenceResults: Annotation<EvidenceItem[]>(replace<EvidenceItem[]>([])),
	priorMemory: Annotation<LandingZonePriorMemory[]>(replace<LandingZonePriorMemory[]>([])),
	reconciliation: Annotation<EvidenceReconciliation | null>(replace<EvidenceReconciliation | null>(null)),
	risk: Annotation<LandingZoneRiskAssessment | null>(replace<LandingZoneRiskAssessment | null>(null)),
	response: Annotation<string | null>(replace<string | null>(null)),
	responseCitations: Annotation<ResponseCitation[]>(replace<ResponseCitation[]>([])),
	topologyStates: Annotation<TopologyEvidenceState[]>(replace<TopologyEvidenceState[]>([])),
	landingZoneTopology: Annotation<LandingZoneTopologyEvent | null>(replace<LandingZoneTopologyEvent | null>(null)),
	blockedReason: Annotation<string | null>(replace<string | null>(null)),
	outcome: Annotation<LandingZoneOutcome>(replace<LandingZoneOutcome>("pending")),
	changeCandidate: Annotation<LandingZoneCandidate | null>(replace<LandingZoneCandidate | null>(null)),
	candidateValidations: Annotation<LandingZoneCandidateValidation[]>(replace<LandingZoneCandidateValidation[]>([])),
	candidateValidationPassed: Annotation<boolean>(replace(false)),
	proposedChangeReview: Annotation<ProposedChangeReview | null>(replace<ProposedChangeReview | null>(null)),
	reviewDecision: Annotation<LandingZoneReviewDecision | null>(replace<LandingZoneReviewDecision | null>(null)),
	amendmentInstructions: Annotation<string | null>(replace<string | null>(null)),
	proposalIteration: Annotation<number>(replace(0)),
	mergeRequest: Annotation<LandingZoneMergeRequest | null>(replace<LandingZoneMergeRequest | null>(null)),
	pipelineObservation: Annotation<LandingZonePipelineObservation | null>(
		replace<LandingZonePipelineObservation | null>(null),
	),
});

export type LandingZoneStateType = typeof LandingZoneState.State;
