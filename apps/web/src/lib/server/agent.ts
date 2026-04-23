// apps/web/src/lib/server/agent.ts
import { buildGraph, createMcpClient, getAgent } from "@devops-agent/agent";
import { complianceToMetadata, getRecursionLimit } from "@devops-agent/gitagent-bridge";
import type { AttachmentMeta, DataSourceContext } from "@devops-agent/shared";
import { isKillSwitchActive, KillSwitchError } from "@devops-agent/shared";
import type { MessageContentComplex } from "@langchain/core/messages";

// SIO-621: Derive recursion limit from gitagent runtime.max_turns instead of hardcoding.
// getRecursionLimit doubles max_turns to account for agent->tool round trips.
function getGraphRecursionLimit(): number {
	const agent = getAgent();
	return getRecursionLimit(agent.manifest.runtime?.max_turns);
}

// SIO-621: Derive graph-level timeout from gitagent runtime.timeout (seconds).
// Prevents runaway pipelines (e.g. 4 datasources with retries) from running indefinitely.
const DEFAULT_GRAPH_TIMEOUT_S = 300;
function getGraphTimeoutMs(): number {
	const agent = getAgent();
	const timeoutS = agent.manifest.runtime?.timeout ?? DEFAULT_GRAPH_TIMEOUT_S;
	return timeoutS * 1000;
}

let mcpReady: Promise<void> | null = null;
let graphPromise: ReturnType<typeof buildGraph> | null = null;

function getMcpConfig() {
	return {
		elasticUrl: process.env.ELASTIC_MCP_URL,
		kafkaUrl: process.env.KAFKA_MCP_URL,
		capellaUrl: process.env.COUCHBASE_MCP_URL,
		konnectUrl: process.env.KONNECT_MCP_URL,
		gitlabUrl: process.env.GITLAB_MCP_URL,
		atlassianUrl: process.env.ATLASSIAN_MCP_URL_LOCAL,
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
		// SIO-649: Specific Elastic deployment IDs to query; the sub-agent fans out across them.
		targetDeployments?: string[];
		isFollowUp?: boolean;
		dataSourceContext?: DataSourceContext;
		attachmentContentBlocks?: MessageContentComplex[];
		attachmentMeta?: AttachmentMeta[];
		metadata?: Record<string, unknown>;
	},
) {
	// SIO-637: Kill switch prevents new graph invocations
	if (isKillSwitchActive()) throw new KillSwitchError();

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
			targetDeployments: options.targetDeployments ?? [],
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
			recursionLimit: getGraphRecursionLimit(),
			signal: AbortSignal.timeout(getGraphTimeoutMs()),
			metadata: {
				...complianceToMetadata(getAgent().manifest.compliance),
				...options.metadata,
			},
		},
	);
}
