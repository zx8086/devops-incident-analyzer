// packages/agent/src/landing-zone/nodes.ts

import type { EvidenceSource } from "@devops-agent/shared";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import {
	deterministicLandingZoneAnswer,
	type LandingZoneAnswerGenerator,
	renderLandingZoneAnswer,
	synthesizeLandingZoneAnswer,
} from "./answer.ts";
import { validateLandingZoneAnswer } from "./answer-validation.ts";
import {
	collectEvidenceSource,
	DEFAULT_LANDING_ZONE_COLLECTORS,
	evidenceContext,
	type LandingZoneEvidenceCollectors,
} from "./evidence.ts";
import { selectLandingZoneKnowledge } from "./knowledge-selector.ts";
import { memoryEnrichLandingZone, recordLandingZoneTurn, renderLandingZonePriorMemory } from "./memory.ts";
import { reconcileEvidence } from "./reconciliation.ts";
import { resolveLandingZoneRequest } from "./request-resolution.ts";
import { assessRisk } from "./risk.ts";
import type { LandingZoneStateType } from "./state.ts";
import { type LandingZoneIntent, LandingZoneRepositorySchema } from "./types.ts";

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
	/\b(change|create|recreate|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|import|force-unlock)\b|\bterraform state (?:rm|mv|push|pull)\b/;
const INFORMATIONAL_ARTIFACT_PATTERN =
	/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|write|provide|give(?: me)?|show me|update)\s+(?:an?\s+|the\s+)?(?:review|plan|assessment|audit|check|example|explanation|summary|guide|documentation)\b/;
const DIRECT_CHANGE_PATTERN =
	/^(?:please\s+)?(?:change|create|recreate|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|import|force-unlock)\b|^terraform state (?:rm|mv|push|pull)\b|\b(?:can you|could you|would you|need to|want to|go ahead and|we should|we must|i should|i need to)\s+(?:change|create|recreate|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|import|force-unlock)\b/;
const CONJUNCTIVE_CHANGE_PATTERN =
	/\band\s+(?:please\s+)?(?:change|create|recreate|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|import|force-unlock)\b/;
const HOW_ACTION_PATTERN =
	/\b(change|create|recreate|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|import|force-unlock|review|validate|check|plan|assess|audit)\b|\bterraform state (?:rm|mv|push|pull)\b/;
const INFORMATIONAL_QUESTION_PATTERN = /^(?:what|which|who|where|when|why|how|does|do|did|is|are|was|were)\b/;
const PROSPECTIVE_QUESTION_CHANGE_PATTERN =
	/^(?:what|which|who|where|when|why)\b.*(?:\b(?:should|can|could|would|will|may|might)\s+(?:we|i|you|be)\s+|\bto\s+)(?:change|create|recreate|add|modify|update|implement|apply|destroy|delete|remove|allow|grant|commit|migrate|import|force-unlock)\b/;

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
		requestResolution: null,
		clarificationCount: 0,
		gitlabEvidence: null,
		okfEvidence: null,
		terraformDocsEvidence: null,
		awsDocsEvidence: null,
		awsApiEvidence: null,
		memoryEvidence: null,
		knowledgeGraphEvidence: null,
		landingZoneTopology: null,
		answerResult: null,
		answerValidation: null,
		answerRetryCount: 0,
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
	const resolution = await resolveLandingZoneRequest(state);
	if (resolution.clarification?.startsWith("This changes scope from ")) return { requestResolution: resolution };
	return {
		requestResolution: resolution,
		repositoryScope: resolution.repositories,
		accountScope: resolution.accountIds,
	};
}

export function gateLandingZoneScope(state: LandingZoneStateType): Partial<LandingZoneStateType> {
	const resolution = state.requestResolution;
	if (!resolution?.clarification) return {};
	const prompt = resolution.clarification;
	const resumed = interrupt({ type: "landing_zone_clarify", question: prompt, message: prompt }) as { answer?: string };
	const answer = resumed.answer?.trim() ?? "";
	const accountIds = [...new Set(answer.match(/\b\d{12}\b/g) ?? [])];
	if (prompt.startsWith("This changes scope from ")) {
		const normalized = answer.toLowerCase();
		const replaceScope = /\b(replace|new|switch|fresh)\b/.test(normalized);
		const retainScope = /\b(retain|keep|both|add|continue)\b/.test(normalized);
		if (!replaceScope && !retainScope) {
			const blockedReason = "Choose whether to retain the previous repository scope or replace it.";
			return {
				messages: [new HumanMessage(answer), new AIMessage(blockedReason)],
				blockedReason,
				response: blockedReason,
				outcome: "blocked",
				clarificationCount: state.clarificationCount + 1,
			};
		}
		const previousRepositories = state.repositoryScope.filter(
			(repository) => LandingZoneRepositorySchema.safeParse(repository).success,
		) as typeof resolution.repositories;
		const repositoryScope = replaceScope
			? resolution.repositories
			: [...new Set([...previousRepositories, ...resolution.repositories])].sort();
		return {
			messages: [new HumanMessage(answer)],
			repositoryScope,
			requestResolution: { ...resolution, repositories: repositoryScope, clarification: null },
			clarificationCount: state.clarificationCount + 1,
		};
	}
	if (resolution.subject === "topology") {
		const resolvedAccountIds = resolution.accountIds.length > 0 ? resolution.accountIds : accountIds;
		const hostnameRequired = resolution.topologyView === "dns";
		const hostname = `${latestText(state.messages)} ${answer}`.match(/\b[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}\b/i)?.[0];
		if (resolvedAccountIds.length !== 1 || (hostnameRequired && !hostname)) {
			const blockedReason = hostnameRequired
				? "Provide one hostname and exactly one authorized 12-digit Landing Zone account ID to continue the trace."
				: "Provide exactly one authorized 12-digit Landing Zone account ID to continue the map.";
			return {
				messages: [new HumanMessage(answer), new AIMessage(blockedReason)],
				blockedReason,
				response: blockedReason,
				outcome: "blocked",
				clarificationCount: state.clarificationCount + 1,
			};
		}
		const [accountId] = resolvedAccountIds;
		if (!state.authorizedAccountScope.includes(accountId ?? "")) {
			const blockedReason = "That Landing Zone account is outside the authorized account scope for this session.";
			return {
				messages: [new HumanMessage(answer), new AIMessage(blockedReason)],
				blockedReason,
				response: blockedReason,
				outcome: "blocked",
				clarificationCount: state.clarificationCount + 1,
			};
		}
		return {
			messages: [new HumanMessage(answer)],
			repositoryScope: resolution.repositories,
			accountScope: resolvedAccountIds,
			requestResolution: {
				...resolution,
				accountIds: resolvedAccountIds,
				accountResolution: resolution.accountIds.length > 0 ? resolution.accountResolution : "explicit",
				clarification: null,
			},
			clarificationCount: state.clarificationCount + 1,
		};
	}
	const blockedReason = "The requested Landing Zone scope is still unresolved after clarification.";
	return {
		messages: [new HumanMessage(answer), new AIMessage(blockedReason)],
		blockedReason,
		response: blockedReason,
		outcome: "blocked",
		clarificationCount: state.clarificationCount + 1,
	};
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
		return "The claims compared from currently collected evidence are aligned. Source availability is reported separately.";
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

export function createSynthesizeLandingZoneAnswerNode(generate?: LandingZoneAnswerGenerator) {
	return async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => ({
		answerResult: await synthesizeLandingZoneAnswer(state, generate),
		answerValidation: null,
		answerRetryCount: state.answerRetryCount + 1,
	});
}

export async function validateLandingZoneAnswerNode(
	state: LandingZoneStateType,
): Promise<Partial<LandingZoneStateType>> {
	if (!state.answerResult || !state.requestResolution) {
		return {
			answerValidation: {
				valid: false,
				issues: ["Answer synthesis did not produce a resolvable Landing Zone answer."],
			},
		};
	}
	return {
		answerValidation: validateLandingZoneAnswer({
			answer: state.answerResult,
			resolution: state.requestResolution,
			evidence: state.evidenceResults,
			unavailableSources: state.reconciliation?.unavailableSources ?? [],
			requestText: latestText(state.messages),
		}),
	};
}

export async function degradeLandingZoneAnswer(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	const fallback = deterministicLandingZoneAnswer(state);
	const issues = state.answerValidation?.issues ?? ["The synthesized answer did not pass validation."];
	return {
		answerResult: {
			...fallback,
			limitations: [
				...fallback.limitations,
				`The generated answer did not pass grounded-answer validation: ${issues.join(" ")}`,
			],
		},
	};
}

export async function publishLandingZoneAnswer(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	if (!state.answerResult) {
		const blockedReason = "No validated Landing Zone answer is available.";
		return {
			messages: [new AIMessage(blockedReason)],
			blockedReason,
			response: blockedReason,
			outcome: "blocked",
		};
	}
	const response = renderLandingZoneAnswer(state.answerResult);
	const priorMemory =
		state.reconciliation?.status === "aligned"
			? renderLandingZonePriorMemory(state.priorMemory, state.evidenceResults)
			: "";
	return {
		messages: [new AIMessage(`${response}${priorMemory}`)],
		response: `${response}${priorMemory}`,
		responseCitations: state.answerResult.citations,
		outcome: "answered",
	};
}
export async function teardownLandingZone(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> {
	recordLandingZoneTurn(state);
	return {};
}
