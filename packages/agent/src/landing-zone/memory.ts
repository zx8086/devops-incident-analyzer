// packages/agent/src/landing-zone/memory.ts

import { type AnnotationMap, type EvidenceItem, redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { searchAgentMemory } from "../memory-backend.ts";
import { appendDailyLog, type DailyLogEntry, type KeyDecision, recordKeyDecision } from "../memory-writer.ts";
import type { LandingZoneStateType } from "./state.ts";
import type { LandingZoneMemoryKind, LandingZonePriorMemory } from "./types.ts";

const LANDING_ZONE_AGENT = "landing-zone-terraform";
const REVALIDATION_NOTE = true as const;
const UNSAFE_DURABLE_CONTENT =
	/\b(?:terraform\s+state\s+value|plan[- ]sensitive\s+value|sensitive\s+plan\s+value|\.tfstate\b)|[<(]sensitive value[>)]|"sensitive"\s*:\s*true/i;
const SECRET_ASSIGNMENT =
	/\b([a-z][a-z0-9_-]*(?:password|passwd|secret|token|credential|private[_-]?key|client[_-]?secret|access[_-]?key)|password|passwd|secret|token|credential|private[_-]?key|client[_-]?secret|access[_-]?key|(?:database|db|postgres|postgresql|mysql|mongodb|redis|amqp)[_-]?url)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const CONNECTION_CREDENTIALS = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]+@/gi;
const REPOSITORY_MEMORY_KIND: Readonly<Record<string, LandingZoneMemoryKind>> = {
	"aws-lz-account-creator": "account-vending",
	"aws-lz-network-workloads": "network-onboarding",
	"aws-lz-post-vending": "dns-design",
	"dhco-gitlab-terraform": "gitlab-project",
	"gitlab-k8s-runners-lzv2": "runner-onboarding",
};

export interface LandingZoneMemoryScope {
	kind: LandingZoneMemoryKind;
	repository?: string;
	account?: string;
	workflow?: string;
	mrUrl?: string;
	configChangeId?: string;
	validatedClaims?: Readonly<Record<string, string>>;
}

export interface LandingZoneDecisionInput extends LandingZoneMemoryScope {
	requestId: string;
	decision: string;
	rationale?: string;
	reviewed: boolean;
}

export interface LandingZoneOutcomeInput extends LandingZoneMemoryScope {
	requestId: string;
	summary: string;
	confirmed: boolean;
	ttlSeconds?: number;
}

export interface LandingZoneMemoryDependencies {
	search: typeof searchAgentMemory;
}

export interface LandingZoneMemoryWriteDependencies {
	recordDecision: (decision: KeyDecision) => void;
}

export interface LandingZoneTurnMemoryDependencies {
	appendBreadcrumb: (entry: DailyLogEntry) => void;
	recordOutcome: (input: LandingZoneOutcomeInput) => boolean;
}

const defaultMemoryDependencies: LandingZoneMemoryDependencies = { search: searchAgentMemory };
const defaultWriteDependencies: LandingZoneMemoryWriteDependencies = { recordDecision: recordKeyDecision };
const defaultTurnMemoryDependencies: LandingZoneTurnMemoryDependencies = {
	appendBreadcrumb: appendDailyLog,
	recordOutcome: recordLandingZoneOutcome,
};

function latestQuery(messages: BaseMessage[]): string {
	const content = messages.at(-1)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join(" ")
		.trim();
}

function oneValue(values: string[]): string | undefined {
	return values.length === 1 ? values[0] : undefined;
}

export function buildLandingZoneMemoryAnnotations(scope: LandingZoneMemoryScope): AnnotationMap {
	return {
		kind: scope.kind,
		...(scope.repository ? { repository: safeAnnotationValue(scope.repository) } : {}),
		...(scope.account ? { account: safeAnnotationValue(scope.account) } : {}),
		...(scope.workflow ? { workflow: safeAnnotationValue(scope.workflow) } : {}),
		...(scope.mrUrl ? { mr_url: safeAnnotationValue(scope.mrUrl) } : {}),
		...(scope.configChangeId ? { config_change_id: safeAnnotationValue(scope.configChangeId) } : {}),
		...(scope.validatedClaims && Object.keys(scope.validatedClaims).length > 0
			? { validated_claims: safeAnnotationValue(JSON.stringify(scope.validatedClaims)) }
			: {}),
	};
}

function safeDurableText(text: string): string | null {
	if (UNSAFE_DURABLE_CONTENT.test(text)) return null;
	return redactPiiContent(text)
		.replace(AWS_ACCESS_KEY, "[REDACTED]")
		.replace(CONNECTION_CREDENTIALS, "$1://[REDACTED]@")
		.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`);
}

function safeAnnotationValue(value: string): string {
	return safeDurableText(value) ?? "[REDACTED_UNSAFE_VALUE]";
}

export async function memoryEnrichLandingZone(
	state: LandingZoneStateType,
	dependencies: LandingZoneMemoryDependencies = defaultMemoryDependencies,
): Promise<Partial<LandingZoneStateType>> {
	const query = latestQuery(state.messages);
	const repository = oneValue(state.repositoryScope);
	const account = oneValue(state.accountScope);
	const kind = repository ? REPOSITORY_MEMORY_KIND[repository] : undefined;
	const filter: AnnotationMap = {
		...(repository ? { repository } : {}),
		...(account ? { account } : {}),
		...(kind ? { kind } : {}),
	};
	const hits = await dependencies.search(
		LANDING_ZONE_AGENT,
		query,
		Object.keys(filter).length > 0 ? filter : undefined,
		8,
		{ allSessions: true },
	);
	const priorMemory: LandingZonePriorMemory[] = hits.flatMap((hit) => {
		const text = safeDurableText(hit.text);
		if (!text) return [];
		return [
			{
				text,
				annotations: Object.fromEntries(
					Object.entries(hit.annotations).map(([key, value]) => [key, safeAnnotationValue(value)]),
				),
				...(hit.blockId ? { blockId: hit.blockId } : {}),
				advisory: true,
				requiresLiveRevalidation: REVALIDATION_NOTE,
			},
		];
	});
	return { priorMemory };
}

export function recordLandingZoneDecision(
	input: LandingZoneDecisionInput,
	dependencies: LandingZoneMemoryWriteDependencies = defaultWriteDependencies,
): boolean {
	if (!input.reviewed) return false;
	const decision = safeDurableText(input.decision);
	const rationale = input.rationale ? safeDurableText(input.rationale) : undefined;
	if (!decision || (input.rationale && !rationale)) return false;
	dependencies.recordDecision({
		requestId: input.requestId,
		decision,
		...(rationale ? { rationale } : {}),
		annotations: buildLandingZoneMemoryAnnotations(input),
	});
	return true;
}

export function recordLandingZoneOutcome(
	input: LandingZoneOutcomeInput,
	dependencies: LandingZoneMemoryWriteDependencies = defaultWriteDependencies,
): boolean {
	if (!input.confirmed) return false;
	if (input.kind === "in-flight-change" && !(input.ttlSeconds && input.ttlSeconds > 0)) return false;
	const summary = safeDurableText(input.summary);
	if (!summary) return false;
	dependencies.recordDecision({
		requestId: input.requestId,
		decision: summary,
		annotations: buildLandingZoneMemoryAnnotations(input),
		...(input.kind === "in-flight-change" ? { ttlSeconds: input.ttlSeconds } : {}),
	});
	return true;
}

function normalizeClaimValue(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseValidatedClaims(value: string | undefined): Readonly<Record<string, string>> | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const entries = Object.entries(parsed);
		if (
			entries.length === 0 ||
			entries.some(([key, claimValue]) => key.trim().length === 0 || typeof claimValue !== "string")
		)
			return null;
		return Object.fromEntries(entries) as Readonly<Record<string, string>>;
	} catch {
		return null;
	}
}

export function revalidateLandingZonePriorMemory(
	priorMemory: LandingZonePriorMemory[],
	evidenceResults: EvidenceItem[],
): LandingZonePriorMemory[] {
	const currentLiveClaims = new Map(
		evidenceResults.flatMap((item) =>
			item.status === "observed" &&
			item.freshness.status === "current" &&
			(item.source === "gitlab" || item.source === "aws-api") &&
			item.claimValue !== undefined
				? [[item.claimKey, normalizeClaimValue(item.claimValue)] as const]
				: [],
		),
	);
	return priorMemory.filter((item) => {
		const validatedClaims = parseValidatedClaims(item.annotations.validated_claims);
		if (!validatedClaims) return false;
		return Object.entries(validatedClaims).every(
			([claimKey, claimValue]) => currentLiveClaims.get(claimKey) === normalizeClaimValue(claimValue),
		);
	});
}

export function renderLandingZonePriorMemory(
	priorMemory: LandingZonePriorMemory[],
	evidenceResults: EvidenceItem[],
): string {
	const revalidatedMemory = revalidateLandingZonePriorMemory(priorMemory, evidenceResults);
	if (revalidatedMemory.length === 0) return "";
	const items = revalidatedMemory
		.slice(0, 3)
		.map((item) => `- ${item.text.slice(0, 500)}`)
		.join("\n");
	return `\n\nPrior experience (advisory; revalidate against current live evidence):\n${items}`;
}

export function recordLandingZoneTurn(
	state: LandingZoneStateType,
	dependencies: LandingZoneTurnMemoryDependencies = defaultTurnMemoryDependencies,
): boolean {
	const datasources = [...new Set(state.evidenceResults.map((item) => item.source))];
	dependencies.appendBreadcrumb({
		requestId: state.requestId,
		services: state.repositoryScope,
		datasources,
		summary: `${state.intent} turn ended ${state.outcome}. ${state.reconciliation?.conclusion ?? "No evidence conclusion."}`,
	});

	const validatedClaims = Object.fromEntries(
		state.evidenceResults.flatMap((item) =>
			item.source === "gitlab" &&
			item.status === "observed" &&
			item.freshness.status === "current" &&
			item.claimValue !== undefined
				? [[item.claimKey, item.claimValue] as const]
				: [],
		),
	);
	if (
		state.intent !== "review" ||
		state.outcome !== "answered" ||
		state.reconciliation?.status !== "aligned" ||
		Object.keys(validatedClaims).length === 0
	)
		return false;
	return dependencies.recordOutcome({
		requestId: state.requestId,
		summary: `Landing Zone review ended ${state.outcome}: ${state.reconciliation.conclusion}`,
		confirmed: true,
		kind: "plan-outcome",
		...(oneValue(state.repositoryScope) ? { repository: oneValue(state.repositoryScope) } : {}),
		...(oneValue(state.accountScope) ? { account: oneValue(state.accountScope) } : {}),
		workflow: state.intent,
		configChangeId: state.requestId,
		validatedClaims,
	});
}
