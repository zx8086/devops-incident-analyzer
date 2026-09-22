// packages/agent/src/landing-zone/nodes.ts

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
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
const CHANGE_PATTERN = /\b(change|create|add|modify|update|implement)\b/;
const INFORMATIONAL_ARTIFACT_PATTERN =
	/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|write|provide|give(?: me)?|show me|update)\s+(?:an?\s+|the\s+)?(?:review|plan|assessment|audit|check|example|explanation|summary|guide|documentation)\b/;
const DIRECT_CHANGE_PATTERN =
	/^(?:please\s+)?(?:change|create|add|modify|update|implement)\b|\b(?:can you|could you|would you|need to|want to|go ahead and|we should|we must|i should|i need to)\s+(?:change|create|add|modify|update|implement)\b/;
const CONJUNCTIVE_CHANGE_PATTERN = /\band\s+(?:please\s+)?(?:change|create|add|modify|update|implement)\b/;

function clauseRequestsChange(clause: string): boolean {
	if (INFORMATIONAL_ARTIFACT_PATTERN.test(clause)) return false;
	if (DIRECT_CHANGE_PATTERN.test(clause)) return true;
	if (!/\bhow\b/.test(clause) && CONJUNCTIVE_CHANGE_PATTERN.test(clause)) return true;
	return CHANGE_PATTERN.test(clause) && !LEARNING_PATTERN.test(clause) && !REVIEW_PATTERN.test(clause);
}

export async function bootstrapLandingZone(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	return { requestId: state.requestId || crypto.randomUUID(), outcome: "pending" };
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
	if (/\b(account|vending)\b/.test(text)) repositoryScope.add("aws-lz-account-creator");
	if (/\b(vpc|subnet|workload network)\b/.test(text)) repositoryScope.add("aws-lz-network-workloads");
	if (/\b(core network|cloud wan|ipam|transit gateway|direct connect)\b/.test(text)) {
		repositoryScope.add("aws-lz-network-core");
	}
	if (/\b(dns|post-vending|post vending)\b/.test(text)) repositoryScope.add("aws-lz-post-vending");
	if (/\b(gitlab project|repository)\b/.test(text)) repositoryScope.add("dhco-gitlab-terraform");
	if (/\b(runner|runners)\b/.test(text)) repositoryScope.add("gitlab-k8s-runners-lzv2");
	return { repositoryScope: [...repositoryScope] };
}

export async function selectPvhKnowledge(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	return {
		selectedKnowledge: [
			"conventions",
			"shared",
			...state.repositoryScope.map((repository) => `repos/${repository}.md`),
		],
	};
}

export async function gatherLandingZoneEvidence(_state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	return { evidenceResults: [] };
}

export async function reconcileLandingZoneEvidence(
	state: LandingZoneStateType,
): Promise<Partial<LandingZoneStateType>> {
	const degradedSources = state.evidenceResults
		.filter((result) => result.status !== "observed")
		.map((result) => result.source);
	return {
		reconciliation: {
			conclusion:
				state.evidenceResults.length > 0
					? "Evidence collected for reconciliation."
					: "Live evidence not collected yet.",
			classification: state.evidenceResults.length > 0 ? "Observed" : "Unverified",
			conflicts: [],
			degradedSources,
		},
	};
}

export async function assessLandingZoneRisk(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	const blocked = state.reconciliation?.classification === "Unverified" && state.intent === "propose-change";
	return {
		blockedReason: blocked ? "A proposed change requires current live evidence." : null,
		risk: {
			level: blocked ? "blocked" : state.intent === "propose-change" ? "high" : "low",
			reasons: blocked ? ["Live repository and work-in-flight evidence is unavailable."] : [],
			requiresHumanDecision: state.intent === "propose-change",
		},
	};
}

export async function answerLandingZoneQuestion(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	if (state.blockedReason) {
		return { messages: [new AIMessage(state.blockedReason)], response: state.blockedReason, outcome: "blocked" };
	}
	const response = state.reconciliation?.conclusion ?? "No evidence conclusion is available.";
	return {
		messages: [new AIMessage(response)],
		response,
		outcome: "answered",
	};
}

export async function teardownLandingZone(_state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	return {};
}
