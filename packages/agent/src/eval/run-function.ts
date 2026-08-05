// packages/agent/src/eval/run-function.ts
import { ToolErrorCategorySchema } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { type FirstAttemptSummary, summarizeFirstAttempts } from "../alignment.ts";
import { buildGraph } from "../graph.ts";
import { createMcpClient } from "../mcp-bridge.ts";
import { extractTextFromContent } from "../message-utils.ts";
import {
	appendRecordedOutput,
	exampleKey,
	fixturesDir,
	readRecordedOutputs,
	recordingToolMiddleware,
	runWithExampleTag,
} from "./fixture-recorder.ts";
import { buildSubagentReports } from "./subagent-reports.ts";

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

const FrozenOutputSchema = z.object({
	response: z.string(),
	targetDataSources: z.array(z.string()),
	confidenceCap: z.number().optional(),
	firstAttempts: z.array(FirstAttemptSummarySchema),
	subagentReports: z.record(z.string(), z.string()),
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
		return {
			output: {
				response: responseText,
				targetDataSources: finalState.targetDataSources ?? [],
				confidenceCap: finalState.confidenceCap,
				firstAttempts,
				subagentReports,
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
