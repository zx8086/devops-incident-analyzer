// apps/web/src/lib/server/agent.ts
import {
	buildGraph,
	buildIacGraph,
	createMcpClient,
	getAgent,
	getAgentByName,
	installGraphWarmer,
	installMemoryPromotion,
	runBootstrap,
	runTeardown,
} from "@devops-agent/agent";
import { complianceToMetadata, getRecursionLimit } from "@devops-agent/gitagent-bridge";
import type { AttachmentMeta, DataSourceContext } from "@devops-agent/shared";
import { isKillSwitchActive, KillSwitchError } from "@devops-agent/shared";
import type { MessageContentComplex } from "@langchain/core/messages";

// SIO-849/SIO-850: wire the lifecycle teardown (open_memory_pr) and bootstrap
// (warm_knowledge_graph) seams once, at module load. Both no-op until their
// feature flag is set.
installMemoryPromotion();
installGraphWarmer();

// SIO-751: Command is imported lazily inside resumeAgent() because eager import
// pulls in @langchain/langgraph's transformer modules which fail to resolve
// `@langchain/core/language_models/stream` under bun test (the test harness
// mocks @devops-agent/agent but not the langgraph dep graph).

// SIO-621: Derive recursion limit from gitagent runtime.max_turns instead of hardcoding.
// getRecursionLimit doubles max_turns to account for agent->tool round trips.
function getGraphRecursionLimit(agentName = "incident-analyzer"): number {
	const agent = getAgentByName(agentName);
	return getRecursionLimit(agent.manifest.runtime?.max_turns);
}

// SIO-621: Derive graph-level timeout from gitagent runtime.timeout (seconds).
// SIO-697: GRAPH_TIMEOUT_MS env override takes precedence over manifest; default
// raised to 12 min so a 5-source dispatch with one alignment retry has runway
// to finish instead of aborting the in-flight retry sub-agent.
const DEFAULT_GRAPH_TIMEOUT_S = 720;
function getGraphTimeoutMs(agentName = "incident-analyzer"): number {
	const envRaw = process.env.GRAPH_TIMEOUT_MS;
	if (envRaw != null && envRaw !== "") {
		const parsed = Number(envRaw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	const agent = getAgentByName(agentName);
	const timeoutS = agent.manifest.runtime?.timeout ?? DEFAULT_GRAPH_TIMEOUT_S;
	return timeoutS * 1000;
}

let mcpReady: Promise<void> | null = null;
// Each agent compiles its own graph with its own checkpointer, so their threads
// are isolated without partitioning thread_id. getGraph() keeps returning the
// incident-analyzer graph for backward compatibility.
let graphPromise: ReturnType<typeof buildGraph> | null = null;
let iacGraphPromise: ReturnType<typeof buildIacGraph> | null = null;

function resolveCheckpointerType(): "memory" | "sqlite" {
	return (process.env.AGENT_CHECKPOINTER_TYPE as "memory" | "sqlite") ?? "memory";
}

// SIO-846: agent-session bootstrap runs once per thread, lazily on first
// invoke. Mirrors the mcpReady/graphPromise run-once memoization above. Distinct
// from MCP-server process bootstrap (createMcpApplication) which is per-process.
const bootstrappedThreads = new Set<string>();

async function sessionBootstrap(threadId: string): Promise<void> {
	if (bootstrappedThreads.has(threadId)) return;
	bootstrappedThreads.add(threadId);
	try {
		await runBootstrap();
	} catch {
		// Bootstrap is best-effort; a failure must not block the investigation.
		// runBootstrap already logs its own step failures.
	}
}

// SIO-846: explicit session-end seam. Called by the teardown endpoint (on
// "end session"/beforeunload) and the idle-TTL sweep. Clears the run-once guard
// so a future turn on the same threadId re-bootstraps.
export async function sessionTeardown(threadId: string): Promise<void> {
	bootstrappedThreads.delete(threadId);
	try {
		await runTeardown();
	} catch {
		// Teardown is best-effort; never surface to the user. runTeardown logs.
	}
}

function getMcpConfig() {
	return {
		elasticUrl: process.env.ELASTIC_MCP_URL,
		kafkaUrl: process.env.KAFKA_MCP_URL,
		capellaUrl: process.env.COUCHBASE_MCP_URL,
		konnectUrl: process.env.KONNECT_MCP_URL,
		gitlabUrl: process.env.GITLAB_MCP_URL,
		atlassianUrl: process.env.ATLASSIAN_MCP_URL,
		awsUrl: process.env.AWS_MCP_URL,
		elasticIacUrl: process.env.ELASTIC_IAC_MCP_URL,
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
		graphPromise = buildGraph({ checkpointerType: resolveCheckpointerType() });
	}
	return graphPromise;
}

// elastic-iac maker graph (separate compiled graph + checkpointer).
export async function getIacGraph() {
	await ensureMcpConnected();

	if (!iacGraphPromise) {
		iacGraphPromise = buildIacGraph({ checkpointerType: resolveCheckpointerType() });
	}
	return iacGraphPromise;
}

export async function invokeAgent(
	messages: Array<{ role: string; content: string }>,
	options: {
		threadId: string;
		runId?: string;
		// Which agent/graph to run. Defaults to incident-analyzer; "elastic-iac"
		// routes to the IaC maker graph.
		agentName?: string;
		dataSources?: string[];
		// SIO-649: Specific Elastic deployment IDs to query; the sub-agent fans out across them.
		targetDeployments?: string[];
		// SIO-836: AWS estate IDs the user explicitly selected; awsEstateRouter prefers these over the LLM classifier.
		uiAwsEstates?: string[];
		isFollowUp?: boolean;
		dataSourceContext?: DataSourceContext;
		attachmentContentBlocks?: MessageContentComplex[];
		attachmentMeta?: AttachmentMeta[];
		metadata?: Record<string, unknown>;
		runName?: string;
		tags?: string[];
	},
) {
	// SIO-637: Kill switch prevents new graph invocations
	if (isKillSwitchActive()) throw new KillSwitchError();

	// SIO-846: run agent-session bootstrap once per thread before the first turn.
	await sessionBootstrap(options.threadId);

	const agentName = options.agentName ?? "incident-analyzer";
	const { HumanMessage } = await import("@langchain/core/messages");

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

	// elastic-iac maker graph: a distinct state shape (IacState) and its own graph.
	if (agentName === "elastic-iac") {
		const iacGraph = await getIacGraph();
		return iacGraph.streamEvents(
			{ messages: langchainMessages, requestId },
			{
				configurable: {
					thread_id: options.threadId,
					...(options.runId && { run_id: options.runId }),
				},
				version: "v2",
				recursionLimit: getGraphRecursionLimit(agentName),
				signal: AbortSignal.timeout(getGraphTimeoutMs(agentName)),
				...(options.runName && { runName: options.runName }),
				...(options.tags && { tags: options.tags }),
				metadata: {
					...complianceToMetadata(getAgentByName(agentName).manifest.compliance),
					...options.metadata,
				},
			},
		);
	}

	const graph = await getGraph();
	return graph.streamEvents(
		{
			messages: langchainMessages,
			targetDataSources: options.dataSources ?? [],
			targetDeployments: options.targetDeployments ?? [],
			uiAwsEstates: options.uiAwsEstates ?? [],
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
			...(options.runName && { runName: options.runName }),
			...(options.tags && { tags: options.tags }),
			metadata: {
				...complianceToMetadata(getAgent().manifest.compliance),
				...options.metadata,
			},
		},
	);
}

// SIO-751: resume a graph that was interrupted by detectTopicShift. The
// Command's resume payload is returned by interrupt() inside the node, which
// then writes the appropriate state updates and continues to the supervisor.
export async function resumeAgent(options: {
	threadId: string;
	resumeValue: unknown;
	agentName?: string;
	metadata?: Record<string, unknown>;
	runName?: string;
	tags?: string[];
}) {
	if (isKillSwitchActive()) throw new KillSwitchError();

	const agentName = options.agentName ?? "incident-analyzer";
	// SIO-751: lazy import. See top-of-file comment.
	const { Command } = await import("@langchain/langgraph");
	const config = {
		configurable: { thread_id: options.threadId },
		version: "v2" as const,
		recursionLimit: getGraphRecursionLimit(agentName),
		signal: AbortSignal.timeout(getGraphTimeoutMs(agentName)),
		...(options.runName && { runName: options.runName }),
		...(options.tags && { tags: options.tags }),
		metadata: {
			...complianceToMetadata(getAgentByName(agentName).manifest.compliance),
			...options.metadata,
		},
	};

	// SIO-751: LangGraph 1.3.0 typing for streamEvents declares the input as
	// `UpdateType | CommandInstance | null` but the exported Command class is
	// typed as `Command<unknown, Record<string, unknown>, string>` which TS
	// can't narrow to CommandInstance with our state's generics. Cast through
	// Parameters[0] -- the runtime accepts Command instances per the docs at
	// https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/.
	if (agentName === "elastic-iac") {
		const graph = await getIacGraph();
		const resumeInput = new Command({ resume: options.resumeValue }) as unknown as Parameters<
			typeof graph.streamEvents
		>[0];
		return graph.streamEvents(resumeInput, config);
	}

	const graph = await getGraph();
	const resumeInput = new Command({ resume: options.resumeValue }) as unknown as Parameters<
		typeof graph.streamEvents
	>[0];
	return graph.streamEvents(resumeInput, config);
}

// SIO-751: after a stream completes, check whether the graph paused on an
// interrupt rather than finishing. If so, return the interrupt payload so the
// SSE handler can surface it to the UI. Returns undefined when the graph
// completed normally.
export async function getPendingInterrupt(
	threadId: string,
	agentName = "incident-analyzer",
): Promise<{ value: unknown; id?: string } | undefined> {
	const graph = agentName === "elastic-iac" ? await getIacGraph() : await getGraph();
	const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
	const tasks = snapshot.tasks ?? [];
	for (const task of tasks) {
		const interrupts = (task as { interrupts?: Array<{ value: unknown; id?: string }> }).interrupts ?? [];
		if (interrupts.length > 0) {
			return interrupts[0];
		}
	}
	return undefined;
}

// The IaC graph appends its user-facing output as AIMessages rather than streaming
// tokens through an output node, so the SSE handler reads the final message from
// the checkpointed state once the graph completes (no interrupt pending).
export async function getLastAssistantText(threadId: string, agentName = "incident-analyzer"): Promise<string> {
	const graph = agentName === "elastic-iac" ? await getIacGraph() : await getGraph();
	const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
	const values = snapshot.values as { messages?: Array<{ getType?: () => string; content?: unknown }> };
	const messages = values?.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.getType?.() === "ai") {
			return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
		}
	}
	return "";
}
