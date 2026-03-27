// apps/web/src/lib/server/agent.ts
import { buildGraph, createMcpClient } from "@devops-agent/agent";
import type { AttachmentMeta, DataSourceContext } from "@devops-agent/shared";
import type { MessageContentComplex } from "@langchain/core/messages";

// SIO-606: Match gitagent-bridge getRecursionLimit(25) = 50.
// Accounts for agent->tool round trips in each graph step.
const RECURSION_LIMIT = 50;

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

export async function invokeAgent(
	messages: Array<{ role: string; content: string }>,
	options: {
		threadId: string;
		runId?: string;
		dataSources?: string[];
		isFollowUp?: boolean;
		dataSourceContext?: DataSourceContext;
		attachmentContentBlocks?: MessageContentComplex[];
		attachmentMeta?: AttachmentMeta[];
		metadata?: Record<string, unknown>;
	},
) {
	const { HumanMessage } = await import("@langchain/core/messages");
	const graph = await getGraph();

	// SIO-610: Attach content blocks (images, PDFs, text) to the last user message
	const userMessages = messages.filter((m) => m.role === "user");
	const langchainMessages = userMessages.map((m, i) => {
		if (i === userMessages.length - 1 && options.attachmentContentBlocks?.length) {
			const contentBlocks = [...options.attachmentContentBlocks, { type: "text" as const, text: m.content }];
			// MessageContentComplex includes broader types than HumanMessage expects;
			// ChatBedrockConverse handles the actual type translation at the API layer
			return new HumanMessage({ content: contentBlocks as unknown as string });
		}
		return new HumanMessage(m.content);
	});

	// Pass requestId into graph state so AgentState.requestId matches the web endpoint's value
	const requestId = (options.metadata?.request_id as string) ?? crypto.randomUUID();

	return graph.streamEvents(
		{
			messages: langchainMessages,
			targetDataSources: options.dataSources ?? [],
			isFollowUp: options.isFollowUp ?? false,
			requestId,
			attachmentMeta: options.attachmentMeta ?? [],
			...(options.dataSourceContext && { dataSourceContext: options.dataSourceContext }),
		},
		{
			configurable: {
				thread_id: options.threadId,
				...(options.runId && { run_id: options.runId }),
			},
			version: "v2",
			recursionLimit: RECURSION_LIMIT,
			...(options.metadata && { metadata: options.metadata }),
		},
	);
}
