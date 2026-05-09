// packages/agent/src/eval/run-function.ts
import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "../graph.ts";
import { createMcpClient } from "../mcp-bridge.ts";

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
			atlassianUrl: process.env.ATLASSIAN_MCP_URL_LOCAL,
		});
	}
	return mcpReady;
}

export async function runAgent(inputs: { query: string }): Promise<{
	output: { response: string; targetDataSources: string[]; confidenceCap?: number };
}> {
	await ensureMcpConnected();
	if (!cachedGraph) {
		cachedGraph = await buildGraph({ checkpointerType: "memory" });
	}
	const finalState = await cachedGraph.invoke(
		{ messages: [new HumanMessage(inputs.query)] },
		{ configurable: { thread_id: `eval-${crypto.randomUUID()}` } },
	);
	const lastMessage = finalState.messages.at(-1);
	const responseText =
		typeof lastMessage?.content === "string" ? lastMessage.content : JSON.stringify(lastMessage?.content ?? "");
	return {
		output: {
			response: responseText,
			targetDataSources: finalState.targetDataSources ?? [],
			confidenceCap: finalState.confidenceCap,
		},
	};
}
