// packages/agent/src/eval/run-function.ts
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { type FirstAttemptSummary, summarizeFirstAttempts } from "../alignment.ts";
import { buildGraph } from "../graph.ts";
import { createMcpClient } from "../mcp-bridge.ts";
import { extractTextFromContent } from "../message-utils.ts";

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

// Mirrors apps/web/src/lib/server/agent.ts:getMcpConfig + ensureMcpConnected.
// Without this, the supervisor's getToolsForDataSource() returns 0 tools per
// datasource and skips every sub-agent -- the graph terminates without
// dispatching anything and the run-function reads back the original
// HumanMessage as its "response".
function ensureMcpConnected(): Promise<void> {
	if (!mcpReady) {
		mcpReady = createMcpClient({
			elasticUrl: process.env.ELASTIC_MCP_URL,
			kafkaUrl: process.env.KAFKA_MCP_URL,
			capellaUrl: process.env.COUCHBASE_MCP_URL,
			konnectUrl: process.env.KONNECT_MCP_URL,
			gitlabUrl: process.env.GITLAB_MCP_URL,
			atlassianUrl: process.env.ATLASSIAN_MCP_URL,
		});
	}
	return mcpReady;
}

export async function runAgent(inputs: z.infer<typeof RunAgentInputsSchema>): Promise<{
	output: {
		response: string;
		targetDataSources: string[];
		confidenceCap?: number;
		firstAttempts: FirstAttemptSummary[];
	};
}> {
	const parsed = RunAgentInputsSchema.parse(inputs);
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
	return {
		output: {
			response: responseText,
			targetDataSources: finalState.targetDataSources ?? [],
			confidenceCap: finalState.confidenceCap,
			firstAttempts,
		},
	};
}
