// packages/agent/src/landing-zone/nodes.ts

import type { EvidenceSource } from "@devops-agent/shared";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
	collectEvidenceSource,
	DEFAULT_LANDING_ZONE_COLLECTORS,
	evidenceContext,
	type LandingZoneEvidenceCollectors,
} from "./evidence.ts";
import { selectLandingZoneKnowledge } from "./knowledge-selector.ts";
import { memoryEnrichLandingZone, recordLandingZoneTurn, renderLandingZonePriorMemory } from "./memory.ts";
import { reconcileEvidence } from "./reconciliation.ts";
import { assessRisk } from "./risk.ts";
import type { LandingZoneStateType } from "./state.ts";
import type { LandingZoneIntent } from "./types.ts";

function latestText(messages: BaseMessage[]): string {
	const content = messages.at(-1)?.content;
	if (typeof content === "string") return content.toLowerCase();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join(" ")
		.toLowerCase();
}

const REVIEW_PATTERN = /\b(review|validate|check|plan|assessment|audit)\b/;
const LEARNING_PATTERN =
	/\b(learn|teach|example|show me|how|what is|explain|explanation|summary|guide|documentation)\b/;
const CHANGE_PATTERN =
	/\b(change|create|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate)\b/;
const INFORMATIONAL_ARTIFACT_PATTERN =
	/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|write|provide|give(?: me)?|show me|update)\s+(?:an?\s+|the\s+)?(?:review|plan|assessment|audit|check|example|explanation|summary|guide|documentation)\b/;
const DIRECT_CHANGE_PATTERN =
	/^(?:please\s+)?(?:change|create|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate)\b|\b(?:can you|could you|would you|need to|want to|go ahead and|we should|we must|i should|i need to)\s+(?:change|create|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate)\b/;
const CONJUNCTIVE_CHANGE_PATTERN =
	/\band\s+(?:please\s+)?(?:change|create|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate)\b/;
const HOW_ACTION_PATTERN =
	/\b(change|create|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|review|validate|check|plan|assess|audit)\b/;
const INFORMATIONAL_QUESTION_PATTERN = /^(?:what|which|who|where|when|why|how|does|do|did|is|are|was|were)\b/;
const PROSPECTIVE_QUESTION_CHANGE_PATTERN =
	/^(?:what|which|who|where|when|why)\b.*(?:\b(?:should|can|could|would|will|may|might)\s+(?:we|i|you|be)\s+|\bto\s+)(?:change|create|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate)\b/;

function clauseRequestsChange(clause: string): boolean {
	if (INFORMATIONAL_ARTIFACT_PATTERN.test(clause)) return false;
	if (DIRECT_CHANGE_PATTERN.test(clause)) return true;
	const conjunctiveChange = clause.match(CONJUNCTIVE_CHANGE_PATTERN);
	if (conjunctiveChange?.index !== undefined) {
		const prefix = clause.slice(0, conjunctiveChange.index);
		const howIndex = prefix.search(/\bhow\b/);
		if (howIndex === -1 || !HOW_ACTION_PATTERN.test(prefix.slice(howIndex))) return true;
	}
	if (PROSPECTIVE_QUESTION_CHANGE_PATTERN.test(clause)) return true;
	return (
		CHANGE_PATTERN.test(clause) &&
		!LEARNING_PATTERN.test(clause) &&
		!REVIEW_PATTERN.test(clause) &&
		!INFORMATIONAL_QUESTION_PATTERN.test(clause)
	);
}

export async function bootstrapLandingZone(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	return {
		requestId: state.requestId || crypto.randomUUID(),
		outcome: "pending",
		gitlabEvidence: null,
		okfEvidence: null,
		terraformDocsEvidence: null,
		awsDocsEvidence: null,
		awsApiEvidence: null,
		memoryEvidence: null,
		knowledgeGraphEvidence: null,
		landingZoneTopology: null,
		priorMemory: [],
		changeCandidate: null,
		candidateValidations: [],
		candidateValidationPassed: false,
		proposedChangeReview: null,
		reviewDecision: null,
		amendmentInstructions: null,
		proposalIteration: 0,
		mergeRequest: null,
		pipelineObservation: null,
	};
}

export async function classifyLandingZoneRequest(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	const text = latestText(state.messages);
	const reviewRequested = REVIEW_PATTERN.test(text);
	const learningRequested = LEARNING_PATTERN.test(text);
	const clauses = text.split(/\s*(?:[,;]|\b(?:and then|then|also)\b)\s*/).filter(Boolean);
	const explicitChangeRequested = clauses.some(clauseRequestsChange);
	let intent: LandingZoneIntent = "understand";
	if (explicitChangeRequested) intent = "propose-change";
	else if (reviewRequested) intent = "review";
	else if (learningRequested) intent = "learn";
	return { intent };
}

export async function resolveLandingZoneScope(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	const text = latestText(state.messages);
	const repositoryScope = new Set<string>();
	const accountScope = [...new Set(text.match(/\b\d{12}\b/g) ?? [])];
	if (/\b(account|vending)\b/.test(text)) repositoryScope.add("aws-lz-account-creator");
	if (/\b(vpc|subnet|workload network)\b/.test(text)) repositoryScope.add("aws-lz-network-workloads");
	if (/\b(core network|cloud wan|ipam|transit gateway|direct connect)\b/.test(text)) {
		repositoryScope.add("aws-lz-network-core");
	}
	if (/\b(dns|post-vending|post vending)\b/.test(text)) repositoryScope.add("aws-lz-post-vending");
	if (/\b(gitlab project|repository)\b/.test(text)) repositoryScope.add("dhco-gitlab-terraform");
	if (/\b(runner|runners)\b/.test(text)) repositoryScope.add("gitlab-k8s-runners-lzv2");
	return { repositoryScope: [...repositoryScope], accountScope };
}

export async function selectPvhKnowledge(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	const selection = selectLandingZoneKnowledge(state.intent, state.repositoryScope, [latestText(state.messages)]);
	return { repositoryScope: selection.repositories, selectedKnowledge: selection.entries };
}

export async function recallLandingZoneMemory(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	return memoryEnrichLandingZone(state);
}

export interface LandingZoneEvidenceNodeOptions {
	collectors?: LandingZoneEvidenceCollectors;
	awsLiveStateAuthorized?: boolean;
}

const EVIDENCE_STATE_KEYS = {
	gitlab: "gitlabEvidence",
	"pvh-okf": "okfEvidence",
	"terraform-docs": "terraformDocsEvidence",
	"aws-docs": "awsDocsEvidence",
	"aws-api": "awsApiEvidence",
	memory: "memoryEvidence",
	"knowledge-graph": "knowledgeGraphEvidence",
} as const;

export function createLandingZoneEvidenceNode(source: EvidenceSource, options: LandingZoneEvidenceNodeOptions = {}) {
	return async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
		const result = await collectEvidenceSource(
			source,
			evidenceContext(state, options.awsLiveStateAuthorized),
			options.collectors ?? DEFAULT_LANDING_ZONE_COLLECTORS,
		);
		return { [EVIDENCE_STATE_KEYS[source]]: result } as Partial<LandingZoneStateType>;
	};
}

export async function joinLandingZoneEvidence(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	const outcomes = [
		state.gitlabEvidence,
		state.okfEvidence,
		state.terraformDocsEvidence,
		state.awsDocsEvidence,
		state.awsApiEvidence,
		state.memoryEvidence,
		state.knowledgeGraphEvidence,
	].filter((outcome) => outcome !== null);
	return { evidenceResults: outcomes.flatMap((outcome) => outcome.evidence) };
}

export async function reconcileLandingZoneEvidence(
	state: LandingZoneStateType,
): Promise<Partial<LandingZoneStateType>> {
	const comparisons = reconcileEvidence(state.evidenceResults);
	const conflicts = comparisons
		.filter((comparison) => comparison.alignment === "divergent" || comparison.alignment === "exception")
		.map(
			(comparison) =>
				`${comparison.claim}: ${comparison.alignment}; retain the live implementation and escalate before changing it.`,
		);
	const unavailableSources = [
		state.gitlabEvidence,
		state.okfEvidence,
		state.terraformDocsEvidence,
		state.awsDocsEvidence,
		state.awsApiEvidence,
		state.memoryEvidence,
		state.knowledgeGraphEvidence,
	]
		.filter((outcome) => outcome?.status === "unavailable")
		.map((outcome) => outcome?.source)
		.filter((source): source is EvidenceSource => source !== undefined);
	const status = (() => {
		if (comparisons.length === 0) return "unknown" as const;
		if (conflicts.length > 0) return "conflicting-evidence" as const;
		if (comparisons.some((comparison) => comparison.alignment === "unverified")) return "unknown" as const;
		if (comparisons.some((comparison) => comparison.alignment === "unresolved")) return "pending" as const;
		return "aligned" as const;
	})();
	const conclusion = (() => {
		if (status === "unknown")
			return "Evidence is unavailable or unverified; no repository-specific conclusion can be made.";
		if (status === "conflicting-evidence") {
			return "Authoritative sources disagree; preserve the live implementation and request a platform decision before change.";
		}
		if (status === "pending")
			return "Available evidence supports an explanation, but the full contract is not yet corroborated.";
		return "Current PVH, repository, Terraform, and AWS evidence is aligned for the evaluated claims.";
	})();
	return {
		reconciliation: {
			status,
			conclusion,
			comparisons,
			conflicts,
			unavailableSources,
		},
	};
}

export async function assessLandingZoneRisk(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	if (!state.reconciliation) {
		const blockedReason = "Evidence reconciliation is required before risk can be assessed.";
		return {
			blockedReason,
			risk: {
				level: "blocked",
				reasons: [blockedReason],
				requiresHumanDecision: true,
				blocked: true,
				stopConditions: [blockedReason],
				requiredEvidenceSources: state.intent === "propose-change" ? ["gitlab"] : [],
			},
		};
	}
	const risk = assessRisk(state.reconciliation, {
		intent: state.intent,
		requestText: latestText(state.messages),
		currentEvidenceSources: state.evidenceResults
			.filter((item) => item.status === "observed" && item.freshness.status === "current")
			.map((item) => item.source),
		repositories: state.repositoryScope,
		evidence: state.evidenceResults,
	});
	const blockedReason = risk.blocked ? (risk.stopConditions[0] ?? "The proposed change is blocked by policy.") : null;
	return {
		blockedReason,
		risk,
	};
}

export async function answerLandingZoneQuestion(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	if (state.blockedReason) {
		return { messages: [new AIMessage(state.blockedReason)], response: state.blockedReason, outcome: "blocked" };
	}
	const conclusion = state.reconciliation?.conclusion ?? "No evidence conclusion is available.";
	const limits = state.risk?.reasons ?? [];
	const answer = limits.length > 0 ? `${conclusion} Limits: ${limits.join(" ")}` : conclusion;
	const priorMemory =
		state.reconciliation?.status === "aligned"
			? renderLandingZonePriorMemory(state.priorMemory, state.evidenceResults)
			: "";
	const response = `${answer}${priorMemory}`;
	return {
		messages: [new AIMessage(response)],
		response,
		outcome: "answered",
	};
}
export async function teardownLandingZone(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	recordLandingZoneTurn(state);
	return {};
}
