// packages/agent/src/eval/landing-zone-run-function.ts

import { AsyncLocalStorage } from "node:async_hooks";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { buildLandingZoneGraph } from "../landing-zone/graph.ts";
import type { LandingZoneStateType } from "../landing-zone/state.ts";
import { createMcpClient } from "../mcp-bridge.ts";
import { extractTextFromContent } from "../message-utils.ts";

const LandingZoneEvalInputSchema = z.object({ query: z.string().trim().min(1) }).strict();

let cachedGraph: Awaited<ReturnType<typeof buildLandingZoneGraph>> | undefined;
let mcpReady: Promise<void> | undefined;
const operationStorage = new AsyncLocalStorage<string[]>();

export function classifyLandingZoneToolOperation(toolName: string): string {
	if (/terraform[_-]?apply/i.test(toolName)) return "terraform-apply";
	if (/terraform[_-]?destroy/i.test(toolName)) return "terraform-destroy";
	if (/terraform[_-]?state|force[_-]?unlock/i.test(toolName)) return "terraform-state";
	if (toolName === "lz_create_branch" || toolName === "lz_commit_allowed_files") return "branch-write";
	if (toolName === "lz_open_merge_request") return "open-merge-request";
	return "read";
}

function auditToolMiddleware(_serverName: string, tool: StructuredToolInterface): StructuredToolInterface {
	return new Proxy(tool, {
		get(target, property, receiver) {
			if (property !== "invoke") {
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (input: unknown, config?: unknown) => {
				operationStorage.getStore()?.push(classifyLandingZoneToolOperation(tool.name));
				return target.invoke(input as never, config as never);
			};
		},
	});
}

export function buildLandingZoneEvalMcpConfig(env: NodeJS.ProcessEnv = process.env) {
	return {
		landingZoneIacUrl: env.LANDING_ZONE_IAC_MCP_URL,
		knowledgeGraphUrl: env.KNOWLEDGE_GRAPH_MCP_URL,
		awsUrl: env.AWS_MCP_URL,
		toolMiddleware: auditToolMiddleware,
	};
}

function ensureLandingZoneMcpConnected(): Promise<void> {
	if (!mcpReady) mcpReady = createMcpClient(buildLandingZoneEvalMcpConfig());
	return mcpReady;
}

function records(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(records);
	if (typeof value === "string") {
		const parsed = parseSummary(value);
		return parsed === undefined ? [] : records(parsed);
	}
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	return [record, ...Object.values(record).flatMap(records)];
}

function parseSummary(summary: string): unknown {
	try {
		return JSON.parse(summary);
	} catch {
		return undefined;
	}
}

export function representativeExamplesFromState(state: Pick<LandingZoneStateType, "evidenceResults">): string[] {
	const paths = state.evidenceResults
		.filter((item) => item.source === "gitlab")
		.flatMap((item) => records(parseSummary(item.summary)))
		.flatMap((record) => (Array.isArray(record.examples) ? record.examples : []))
		.flatMap((entry) => {
			if (typeof entry === "string") return [entry];
			if (typeof entry !== "object" || entry === null) return [];
			const path = (entry as Record<string, unknown>).path;
			return typeof path === "string" ? [path] : [];
		});
	return [...new Set(paths)].sort();
}

function projectState(state: LandingZoneStateType, operations: string[]) {
	const lastMessage = state.messages.at(-1);
	const response = state.response ?? extractTextFromContent(lastMessage?.content) ?? "";
	return {
		response,
		intent: state.intent,
		repositoryScope: state.repositoryScope,
		evidenceResults: state.evidenceResults,
		responseCitations: state.responseCitations,
		representativeExamples: representativeExamplesFromState(state),
		reconciliation: state.reconciliation
			? {
					status: state.reconciliation.status,
					unavailableSources: state.reconciliation.unavailableSources,
					comparisons: state.reconciliation.comparisons,
				}
			: null,
		risk: state.risk
			? {
					blocked: state.risk.blocked,
					requiresHumanDecision: state.risk.requiresHumanDecision,
					stopConditions: state.risk.stopConditions,
				}
			: null,
		outcome: state.outcome,
		blockedReason: state.blockedReason,
		changeCandidate: state.changeCandidate
			? { baseBranch: state.changeCandidate.baseBranch, targetBranch: state.changeCandidate.targetBranch }
			: null,
		proposedChangeReview: state.proposedChangeReview ? { reviewId: state.proposedChangeReview.reviewId } : null,
		mergeRequest: state.mergeRequest,
		attemptedOperations: [...new Set(operations.length > 0 ? operations : ["read"])],
	};
}

export async function runLandingZoneAgent(inputs: z.infer<typeof LandingZoneEvalInputSchema>) {
	const parsed = LandingZoneEvalInputSchema.parse(inputs);
	await ensureLandingZoneMcpConnected();
	if (!cachedGraph) cachedGraph = await buildLandingZoneGraph({ checkpointerType: "memory" });
	const operations: string[] = [];
	const state = await operationStorage.run(operations, () =>
		cachedGraph?.invoke(
			{ messages: [new HumanMessage(parsed.query)], requestId: `eval-${crypto.randomUUID()}` },
			{ configurable: { thread_id: `eval-${crypto.randomUUID()}` } },
		),
	);
	if (!state) throw new Error("Landing Zone evaluation graph was not initialized");
	return { output: projectState(state, operations) };
}
