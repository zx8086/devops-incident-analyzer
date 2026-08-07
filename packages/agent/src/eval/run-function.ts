// packages/agent/src/eval/run-function.ts
import { ToolErrorCategorySchema, ToolErrorKindSchema } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { type FirstAttemptSummary, summarizeFirstAttempts } from "../alignment.ts";
import { buildGraph } from "../graph.ts";
import { createMcpClient } from "../mcp-bridge.ts";
import { extractTextFromContent } from "../message-utils.ts";
import { getAgent } from "../prompt-context.ts";
import { buildKnowledgeCandidates } from "./citation-grounding-evaluator.ts";
import {
	appendRecordedOutput,
	exampleKey,
	fixturesDir,
	readRecordedOutputs,
	recordingToolMiddleware,
	runWithExampleTag,
} from "./fixture-recorder.ts";
import { buildSubagentReports } from "./subagent-reports.ts";
import {
	buildToolTrajectory,
	checkResponseHealth,
	type ResponseHealthFinding,
	type ToolTrajectory,
} from "./tool-trajectory.ts";

// SIO-1371 (CodeRabbit PR #590): dataset examples arrive from LangSmith as untyped JSON --
// validate at the boundary so a malformed example fails loudly as a harness error instead of
// invoking the graph with an empty query and grading the resulting non-answer.
const RunAgentInputsSchema = z.object({
	query: z.string().min(1),
	// Mirrors apps/web/src/lib/server/agent.ts:invokeAgent's targetDataSources/
	// targetDeployments/uiAwsEstates initial-state fields, so an incident-replay example that
	// carries the real UI selections a user had active exercises the SAME fixed-target path
	// production runs use, instead of falling through to free entity extraction.
	uiSelectedDataSources: z.array(z.string()).optional(),
	uiSelectedElasticDeployments: z.array(z.string()).optional(),
	uiSelectedAwsEstates: z.array(z.string()).optional(),
	// SIO-1398: tool names the example declares as known-good live anchors -- they must return
	// rows, so an empty result is a finding rather than a result. Carried on INPUTS rather than
	// outputs because only inputs reach this target function, and the empty-anchor check needs
	// rawJson, which exists only here (the trajectory deliberately drops it).
	knownGoodAnchorTools: z.array(z.string()).optional(),
});

let cachedGraph: Awaited<ReturnType<typeof buildGraph>> | undefined;
let mcpReady: Promise<void> | undefined;

// Pure env-var -> config mapping, split out from ensureMcpConnected so it is unit-testable
// without mocking createMcpClient or buildGraph. A prior version of this test mocked the whole
// mcp-bridge.ts module to capture this object, which replaced the module's ENTIRE namespace for
// every OTHER test file loaded afterward in the same bun process (a documented bun mock.module
// cross-file leak -- reference_bun_mock_namespace_live_binding_poisoning) and broke an unrelated
// test in __tests__/mcp-bridge.boot-strict-integration.test.ts. Testing this mapping directly
// needs no mock at all.
//
// SIO-1375 follow-up (2026-08-05): awsUrl was missing here since this function was first
// written -- every AWS sub-agent invocation across every SIO-1374/SIO-1375 eval run (both
// legs, before and after the aggregator/validator/gitlab fixes) hit getToolsForDataSource("aws")
// returning 0 tools and logged "No MCP tools available, skipping", making evidence_aws/
// subagent_accuracy_aws unconditionally 0.000. Confirmed via a live curl against the AWS MCP
// server (HTTP 200, 49 tools) that the server itself was healthy the entire time -- this was a
// harness config gap, not an environment/connectivity issue. Matches production's
// apps/web/src/lib/server/agent.ts:224 (`awsUrl: process.env.AWS_MCP_URL`).
export function buildEvalMcpConfig(env: NodeJS.ProcessEnv = process.env): Parameters<typeof createMcpClient>[0] {
	return {
		elasticUrl: env.ELASTIC_MCP_URL,
		kafkaUrl: env.KAFKA_MCP_URL,
		capellaUrl: env.COUCHBASE_MCP_URL,
		konnectUrl: env.KONNECT_MCP_URL,
		gitlabUrl: env.GITLAB_MCP_URL,
		atlassianUrl: env.ATLASSIAN_MCP_URL,
		awsUrl: env.AWS_MCP_URL,
	};
}

// SIO-1379: the A/B leg this process runs -- the sub-agent override is the eval's only
// per-leg variable, so it doubles as the fixture namespace for recorded outputs/tool calls.
function currentLeg(env: NodeJS.ProcessEnv = process.env): string {
	return env.EVAL_SUB_AGENT_MODEL_OVERRIDE ?? "manifest-default";
}

// SIO-1379: replay-outputs re-parses each recorded output instead of trusting the JSONL
// blindly -- a hand-edited or truncated store must fail the example loudly as a harness
// error, never feed the judge a half-shaped output. (CodeRabbit PR #594: firstAttempts is
// validated against the real FirstAttemptSummary shape via the shared ToolErrorCategory
// enum, not waved through as unknown[] + cast.)
const FirstAttemptSummarySchema = z.object({
	dataSourceId: z.string(),
	firstStatus: z.enum(["success", "error"]),
	firstCategory: ToolErrorCategorySchema.optional(),
	firstDurationMs: z.number(),
	recovered: z.boolean(),
});

// SIO-1398: the trajectory member carries a DEFAULT, unlike every sibling above. Fixtures
// recorded before this field existed have no `toolTrajectory` key, and this parse is strict --
// without the default, every previously recorded leg would fail here and replay-outputs (the
// cheap judge-iteration mode) would break on its first example. An empty trajectory is also
// the semantically right fallback: the evaluators emit NO feedback at totalCalls === 0 rather
// than scoring a perfect 1.0, so a pre-SIO-1398 fixture is simply not graded on tool calls.
const FrozenToolTrajectorySchema = z
	.object({
		calls: z.array(
			z.object({
				dataSourceId: z.string(),
				deploymentId: z.string().optional(),
				toolName: z.string(),
				outcome: z.enum(["success", "error"]),
				category: ToolErrorCategorySchema.optional(),
				kind: ToolErrorKindSchema.optional(),
				statusCode: z.number().optional(),
				recovered: z.boolean().optional(),
				hallucinatedName: z.string().optional(),
				isAlignmentRetry: z.boolean(),
			}),
		),
		byDataSource: z.record(z.string(), z.object({ total: z.number(), errors: z.number() })),
		totalCalls: z.number(),
	})
	.default({ calls: [], byDataSource: {}, totalCalls: 0 });

// Exported for the backward-compat regression test: a fixture recorded before SIO-1398 must
// keep parsing here, or replay-outputs breaks for every previously recorded leg.
export const FrozenOutputSchema = z.object({
	response: z.string(),
	targetDataSources: z.array(z.string()),
	confidenceCap: z.number().optional(),
	firstAttempts: z.array(FirstAttemptSummarySchema),
	subagentReports: z.record(z.string(), z.string()),
	toolTrajectory: FrozenToolTrajectorySchema,
	// Same default rationale as toolTrajectory: absent on every pre-SIO-1398 fixture.
	responseHealth: z
		.array(
			z.object({
				rule: z.enum(["prose-only-error", "empty-anchor", "latency-unit-confusion", "future-dated-window"]),
				dataSourceId: z.string(),
				toolName: z.string(),
				detail: z.string(),
			}),
		)
		.default([]),
	// SIO-1442: same tri-state contract as state.ts's selectedRunbooks (null = selector didn't
	// run; [] = ran, chose none; [names] = these). Default null, not [], so a pre-SIO-1442
	// fixture reads as "unknown" rather than misreporting "the selector ran and chose nothing."
	selectedRunbooks: z.array(z.string()).nullable().default(null),
	// CodeRabbit (PR #633): the runbook-selection-vs-usage evaluator originally called getAgent()
	// LIVE at evaluation time to read runbookSelection.always_select -- so re-grading a recorded
	// run under replay-outputs graded against TODAY's config, not the config that governed the
	// run when it was recorded. Snapshotting always_select here (alongside selectedRunbooks, at
	// the same point the run actually executed) pins the evaluator to run.outputs only, with no
	// live config read. Defaults to [] on a pre-SIO-1442 fixture -- the evaluator only skips
	// grading when selectedRunbooks is null, so an empty alwaysSelectRunbooks on a legacy fixture
	// is inert rather than incorrectly reporting missing entries.
	alwaysSelectRunbooks: z.array(z.string()).default([]),
	// CodeRabbit (PR #633): same fix, same reason, for the citation-grounding evaluator -- it
	// originally called getAgent() live to read runbook knowledge for citation matching, which
	// broke replay-outputs identically. Snapshotted here at record time; defaults to [] on a
	// pre-SIO-1442 fixture, which is inert (citationGrounding finds nothing to match against).
	knowledgeSnapshot: z.array(z.object({ filename: z.string(), content: z.string(), title: z.string() })).default([]),
});

let frozenOutputs: Map<string, unknown> | undefined;

// Mirrors apps/web/src/lib/server/agent.ts:getMcpConfig + ensureMcpConnected.
// Without this, the supervisor's getToolsForDataSource() returns 0 tools per
// datasource and skips every sub-agent -- the graph terminates without
// dispatching anything and the run-function reads back the original
// HumanMessage as its "response".
function ensureMcpConnected(): Promise<void> {
	if (!mcpReady) {
		const config = buildEvalMcpConfig();
		// SIO-1379: record mode wraps every MCP tool with the audit recorder. Set ONLY here in
		// the eval harness -- production wiring never populates toolMiddleware.
		if (process.env.EVAL_FIXTURE_MODE === "record") {
			config.toolMiddleware = recordingToolMiddleware({ dir: fixturesDir(), leg: currentLeg() });
		}
		mcpReady = createMcpClient(config);
	}
	return mcpReady;
}

export async function runAgent(inputs: z.infer<typeof RunAgentInputsSchema>): Promise<{
	output: {
		response: string;
		targetDataSources: string[];
		confidenceCap?: number;
		firstAttempts: FirstAttemptSummary[];
		subagentReports: { [dataSourceId: string]: string };
		toolTrajectory: ToolTrajectory;
		responseHealth: ResponseHealthFinding[];
		selectedRunbooks: string[] | null;
		alwaysSelectRunbooks: string[];
		knowledgeSnapshot: { filename: string; content: string; title: string }[];
	};
}> {
	const parsed = RunAgentInputsSchema.parse(inputs);
	const fixtureMode = process.env.EVAL_FIXTURE_MODE;
	// SIO-1379: replay-outputs never touches MCP, Bedrock, or the graph -- it re-serves the
	// recorded output so evaluator/judge changes re-grade frozen agent behavior in minutes.
	if (fixtureMode === "replay-outputs") {
		if (!frozenOutputs) {
			frozenOutputs = readRecordedOutputs(fixturesDir(), currentLeg());
		}
		const key = exampleKey(parsed.query);
		const stored = frozenOutputs.get(key);
		if (stored === undefined) {
			throw new Error(
				`replay-outputs: no recorded output for example ${key} (query starts "${parsed.query.slice(0, 60)}") in leg "${currentLeg()}" -- record that leg first`,
			);
		}
		return { output: FrozenOutputSchema.parse(stored) };
	}
	const invokeOnce = async () => {
		await ensureMcpConnected();
		if (!cachedGraph) {
			cachedGraph = await buildGraph({ checkpointerType: "memory" });
		}
		const finalState = await cachedGraph.invoke(
			{
				messages: [new HumanMessage(parsed.query)],
				targetDataSources: parsed.uiSelectedDataSources ?? [],
				targetDeployments: parsed.uiSelectedElasticDeployments ?? [],
				uiAwsEstates: parsed.uiSelectedAwsEstates ?? [],
			},
			{ configurable: { thread_id: `eval-${crypto.randomUUID()}` } },
		);
		const lastMessage = finalState.messages.at(-1);
		// SIO-1222: was JSON.stringify for the array case, which handed LangSmith's output.response
		// a JSON blob for the judge to grade -- so a content-shape change would read as a model
		// QUALITY regression in the eval scores rather than a harness bug. That is a bad failure
		// mode for the very harness meant to validate a model swap.
		const responseText = extractTextFromContent(lastMessage?.content);
		// SIO-691: attach per-source first-attempt summary so LangSmith traces distinguish
		// retry-recovered runs from clean first-try runs without log inspection. Field name
		// matches the alignment + aggregator log keys for cross-referencing.
		const firstAttempts = summarizeFirstAttempts(finalState.dataSourceResults ?? []);
		// SIO-1374: raw per-sub-agent findings, isolated from the aggregator's final response text,
		// so the per-sub-agent judge can grade the variable under test (sub-agent model) without the
		// constant (Sonnet 5 aggregator prose) diluting the signal.
		const subagentReports = buildSubagentReports(finalState.dataSourceResults ?? []);
		// SIO-1398: the third projection over the same dataSourceResults the two above read.
		// Carries tool names, closed-enum classifications, and counts only -- never args or
		// rawJson (see the privacy invariant on ToolCallRecord).
		const toolTrajectory = buildToolTrajectory(finalState.dataSourceResults ?? []);
		// Response-health findings are computed HERE, in-process, because this is the only place
		// rawJson exists -- the trajectory deliberately drops it, and the evaluator (which runs
		// against the LangSmith run, not the graph state) could never see it. The findings
		// themselves are name+rule+detail only, so no payload rides along.
		//
		// The known-good anchor names ride on the example's INPUTS (not outputs) precisely so the
		// target function can see them: LangSmith passes only inputs here, and the empty-anchor
		// rule needs to know which tools were promised to return rows.
		const responseHealth = checkResponseHealth(
			finalState.dataSourceResults ?? [],
			new Set(parsed.knownGoodAnchorTools ?? []),
		);
		return {
			output: {
				response: responseText,
				targetDataSources: finalState.targetDataSources ?? [],
				confidenceCap: finalState.confidenceCap,
				firstAttempts,
				subagentReports,
				toolTrajectory,
				responseHealth,
				// SIO-1442: threaded for the tier-3 runbook-selection-vs-usage evaluator, same
				// pattern as toolTrajectory/responseHealth above -- graph state the evaluator (which
				// runs against the LangSmith run, not the graph) could otherwise never see.
				selectedRunbooks: finalState.selectedRunbooks ?? null,
				// CodeRabbit (PR #633): snapshotted HERE, at the moment the run actually executes, so
				// replay-outputs re-grades against the config that governed THIS run rather than
				// whatever agents/incident-analyzer/knowledge/index.yaml says today.
				alwaysSelectRunbooks: getAgent().runbookSelection?.always_select ?? [],
				// CodeRabbit (PR #633): same snapshot-at-record-time fix for the citation-grounding
				// evaluator, which previously read runbook knowledge live via getAgent() at evaluation
				// time instead of at the point the run actually executed.
				knowledgeSnapshot: buildKnowledgeCandidates(getAgent().knowledge),
			},
		};
	};
	if (fixtureMode !== "record") {
		return invokeOnce();
	}
	// SIO-1379: the ALS example tag scopes every recorded tool call to this example (so a
	// future maxConcurrency > 1 cannot cross-tag); the final output lands in the frozen store.
	const result = await runWithExampleTag(exampleKey(parsed.query), invokeOnce);
	appendRecordedOutput(fixturesDir(), currentLeg(), parsed.query, result.output);
	return result;
}
