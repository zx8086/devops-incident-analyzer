// apps/web/src/lib/server/agent.ts
import { buildGraph, createLlm, createMcpClient } from "@devops-agent/agent";
import type { DataSourceContext } from "@devops-agent/shared";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

let mcpReady: Promise<void> | null = null;
let graphPromise: ReturnType<typeof buildGraph> | null = null;

function getMcpConfig() {
	return {
		elasticUrl: process.env.ELASTIC_MCP_URL,
		kafkaUrl: process.env.KAFKA_MCP_URL,
		capellaUrl: process.env.COUCHBASE_MCP_URL,
		konnectUrl: process.env.KONNECT_MCP_URL,
	};
}

export function ensureMcpConnected(): Promise<void> {
	if (!mcpReady) {
		mcpReady = createMcpClient(getMcpConfig());
	}
	return mcpReady;
}

export async function getGraph() {
	await ensureMcpConnected();

	if (!graphPromise) {
		graphPromise = buildGraph({
			checkpointerType: (process.env.AGENT_CHECKPOINTER_TYPE as "memory" | "sqlite") ?? "memory",
		});
	}
	return graphPromise;
}

export function getFollowUpLlm(): BaseChatModel | null {
	try {
		return createLlm("followUp");
	} catch {
		return null;
	}
}

export async function invokeAgent(
	messages: Array<{ role: string; content: string }>,
	options: {
		threadId: string;
		dataSources?: string[];
		isFollowUp?: boolean;
		dataSourceContext?: DataSourceContext;
		metadata?: Record<string, unknown>;
	},
) {
	const { HumanMessage } = await import("@langchain/core/messages");
	const graph = await getGraph();

	const langchainMessages = messages.filter((m) => m.role === "user").map((m) => new HumanMessage(m.content));

	return graph.streamEvents(
		{
			messages: langchainMessages,
			targetDataSources: options.dataSources ?? [],
			isFollowUp: options.isFollowUp ?? false,
			...(options.dataSourceContext && { dataSourceContext: options.dataSourceContext }),
		},
		{
			configurable: { thread_id: options.threadId },
			version: "v2",
			recursionLimit: 100,
			...(options.metadata && { metadata: options.metadata }),
		},
	);
}
