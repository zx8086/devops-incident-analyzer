import { type AnnotationMap, redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { searchAgentMemory } from "../memory-backend.ts";
import { type KeyDecision, recordKeyDecision } from "../memory-writer.ts";
import type { LandingZoneStateType } from "./state.ts";
import type { LandingZoneMemoryKind, LandingZonePriorMemory } from "./types.ts";

const LANDING_ZONE_AGENT = "landing-zone-terraform";
const REVALIDATION_NOTE = true as const;
const UNSAFE_DURABLE_CONTENT =
	/\b(?:terraform\s+state\s+value|plan[- ]sensitive\s+value|sensitive\s+plan\s+value|\.tfstate\b)|[<(]sensitive value[>)]|"sensitive"\s*:\s*true/i;
const SECRET_ASSIGNMENT =
	/\b(password|passwd|secret|token|credential|private[_ -]?key|client[_ -]?secret|access[_ -]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
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

const defaultMemoryDependencies: LandingZoneMemoryDependencies = { search: searchAgentMemory };
const defaultWriteDependencies: LandingZoneMemoryWriteDependencies = { recordDecision: recordKeyDecision };

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
	};
}

function safeDurableText(text: string): string | null {
	if (UNSAFE_DURABLE_CONTENT.test(text)) return null;
	return redactPiiContent(text)
		.replace(AWS_ACCESS_KEY, "[REDACTED]")
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
