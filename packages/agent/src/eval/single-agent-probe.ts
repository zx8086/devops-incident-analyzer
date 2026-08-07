// packages/agent/src/eval/single-agent-probe.ts
// SIO-1441 tier 2: invokes a single sub-agent directly via the already-exported queryDataSource,
// with no buildGraph() anywhere in the path. Runs against LIVE MCP servers and live Bedrock --
// this repo has no CI and does not mock (see project memory feedback_no_ci_no_mocking).
import { DATA_SOURCE_IDS, type DataSourceResult, redactPiiContent } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildAggregatorMessages, buildResultsBlock } from "../aggregator.ts";
import { createLlm } from "../llm.ts";
import { createMcpClient } from "../mcp-bridge.ts";
import { extractTextFromContent } from "../message-utils.ts";
import { AgentState, type AgentStateType } from "../state.ts";
import { queryDataSource } from "../sub-agent.ts";
import { buildEvalMcpConfig } from "./run-function.ts";

// Materializes AgentState's full default state mechanically from its own channel defaults
// (AnnotationRoot.spec[key].initialValueFactory()) rather than hand-listing all ~65 fields --
// a hand-written literal would silently drift out of sync every time state.ts gains a field.
function defaultAgentState(): AgentStateType {
	const defaults = {} as Record<string, unknown>;
	for (const [key, channel] of Object.entries(AgentState.spec)) {
		const factory = (channel as { initialValueFactory?: () => unknown }).initialValueFactory;
		defaults[key] = typeof factory === "function" ? factory() : undefined;
	}
	return defaults as AgentStateType;
}

// Builds the minimal AgentStateType a single-datasource, non-retry, non-fan-out queryDataSource
// call needs: default state for every field queryDataSource/runSubAgent do not read for this
// path, plus the two fields that actually drive behavior -- currentDataSource (which sub-agent
// and MCP server queryDataSource dispatches to) and one HumanMessage carrying the scenario.
export function buildProbeState(dataSourceId: string, scenario: string): AgentStateType {
	return {
		...defaultAgentState(),
		currentDataSource: dataSourceId,
		messages: [new HumanMessage(scenario)],
	};
}

let mcpReady: Promise<void> | undefined;

// Mirrors run-function.ts's ensureMcpConnected -- without this, getToolsForDataSource() returns
// 0 tools and the sub-agent's ReAct loop has nothing to call. Memoized per-process so a script
// probing multiple datasources in one run only connects once.
function ensureMcpConnected(): Promise<void> {
	if (!mcpReady) {
		mcpReady = createMcpClient(buildEvalMcpConfig());
	}
	return mcpReady;
}

// Invokes a single sub-agent standalone with a fixed scenario -- real MCP tool calls, real
// Bedrock, no buildGraph() anywhere in the path. Returns the DataSourceResult(s) queryDataSource
// produces (usually one; elastic/aws can fan out to multiple deployments/estates, though the
// default empty targetDeployments/awsTargetEstates from buildProbeState keeps this a single call
// for every datasource except when the caller populates those fields itself).
export async function probeSubAgent(dataSourceId: string, scenario: string): Promise<DataSourceResult[]> {
	await ensureMcpConnected();
	const state = buildProbeState(dataSourceId, scenario);
	const result = await queryDataSource(state);
	return result.dataSourceResults ?? [];
}

// The orchestrator (aggregate() in aggregator.ts) is NOT a ReAct/tool-using agent -- it is a
// single-shot text-synthesis call over an already-collected dataSourceResults array. This builds
// the minimal state buildAggregatorMessages needs from a fixture/probe-produced result set: the
// results themselves, targetDataSources (deduped, drives the "only these datasources were
// queried" scope note), and one HumanMessage for the userQuery derivation.
export function buildOrchestratorProbeState(results: DataSourceResult[], scenario: string): AgentStateType {
	return {
		...defaultAgentState(),
		dataSourceResults: results,
		targetDataSources: [...new Set(results.map((r) => r.dataSourceId))],
		messages: [new HumanMessage(scenario)],
	};
}

// Invokes the aggregator's single-shot synthesis call standalone -- real Bedrock, no graph, no
// tool binding (the aggregator never binds tools; it only synthesizes prose from already-
// collected results). Takes probeSubAgent's own output directly, so a full probe run is
// probeSubAgent(...) -> probeOrchestrator([...results], scenario).
// CodeRabbit (PR #632): aggregate() itself redacts its output via redactPiiContent before it is
// used anywhere (aggregator.ts:1676) -- this probe must apply the same policy, not leave it to
// each caller, so live MCP/model content is redacted regardless of how the probe is invoked.
export async function probeOrchestrator(results: DataSourceResult[], scenario: string): Promise<string> {
	const state = buildOrchestratorProbeState(results, scenario);
	const resultsBlock = buildResultsBlock(results);
	const messages = buildAggregatorMessages(state, resultsBlock, results);
	const llm = createLlm("aggregator");
	const response = await llm.invoke(messages);
	return redactPiiContent(extractTextFromContent(response.content));
}

// CodeRabbit (PR #632): the original CLI read env vars with manual truthy checks and a
// type-asserted JSON.parse -- an unknown PROBE_DATASOURCE silently fell back to elastic-agent
// inside queryDataSource (sub-agent.ts:2021, AGENT_NAMES[dataSourceId] ?? "elastic-agent"), and
// malformed/null PROBE_REFERENCE_FINDINGS threw an unhandled exception instead of a clean CLI
// error. Validate all four inputs at the boundary instead. Lives here (not in the CLI file)
// because single-agent-probe-cli.ts calls main() unconditionally at module scope -- importing
// it (e.g. from a test) would trigger a live run and process.exit().
const ProbeEnvSchema = z.object({
	PROBE_DATASOURCE: z.enum(DATA_SOURCE_IDS),
	PROBE_SCENARIO: z.string().min(1),
	PROBE_RUN_ORCHESTRATOR: z.literal("true").optional(),
	PROBE_REFERENCE_FINDINGS: z
		.string()
		.optional()
		.transform((raw, ctx) => {
			if (raw === undefined) return undefined;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				ctx.addIssue({ code: "custom", message: "PROBE_REFERENCE_FINDINGS is not valid JSON" });
				return z.NEVER;
			}
			const result = z.record(z.string(), z.string()).safeParse(parsed);
			if (!result.success) {
				ctx.addIssue({ code: "custom", message: "PROBE_REFERENCE_FINDINGS must be a JSON object of string values" });
				return z.NEVER;
			}
			return result.data;
		}),
});

export interface ParsedProbeEnv {
	dataSourceId: (typeof DATA_SOURCE_IDS)[number];
	scenario: string;
	runOrchestrator: boolean;
	referenceFindings?: { [dataSourceId: string]: string };
}

// Pure, unit-testable without touching process.env directly.
export function parseProbeEnv(
	env: Record<string, string | undefined>,
): { success: true; data: ParsedProbeEnv } | { success: false; error: z.ZodError } {
	const result = ProbeEnvSchema.safeParse(env);
	if (!result.success) return { success: false, error: result.error };
	return {
		success: true,
		data: {
			dataSourceId: result.data.PROBE_DATASOURCE,
			scenario: result.data.PROBE_SCENARIO,
			runOrchestrator: result.data.PROBE_RUN_ORCHESTRATOR === "true",
			referenceFindings: result.data.PROBE_REFERENCE_FINDINGS,
		},
	};
}
