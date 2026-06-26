// apps/web/src/lib/server/agent.ts
import { connect as netConnect } from "node:net";
import {
	buildGraph,
	buildIacGraph,
	createMcpClient,
	getAgent,
	getAgentByName,
	type IacStateType,
	type IacTurnOutcome,
	iacTurnOutcome,
	installAgentMemory,
	installGraphWarmer,
	installMemoryPromotion,
	installSkillLearner,
	needsPruning,
	pruneState,
	runBootstrap,
	runPostTurn,
	runTeardown,
	type SkillLearnerTurn,
	setSessionOutcome,
} from "@devops-agent/agent";
import { complianceToMetadata, getRecursionLimit } from "@devops-agent/gitagent-bridge";
import { startKnowledgeGraphServer } from "@devops-agent/mcp-server-knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import type { AttachmentMeta, DataSourceContext } from "@devops-agent/shared";
import { isKillSwitchActive, KillSwitchError } from "@devops-agent/shared";
import type { BaseMessage, MessageContentComplex } from "@langchain/core/messages";
import { startIacReconcileCron } from "./iac-reconcile-cron.ts";

// SIO-849/SIO-850: wire the lifecycle teardown (open_memory_pr) and bootstrap
// (warm_knowledge_graph) seams once, at module load. Both no-op until their
// feature flag is set.
installMemoryPromotion();
installGraphWarmer();
// SIO-938: wire the agent-memory recall/flush seams. No-op unless
// LIVE_MEMORY_BACKEND=agent-memory.
installAgentMemory();
// SIO-1015: wire the skill-learning post-turn seam. The learner core lives in
// @devops-agent/agent but state reads (getGraph/getState) live here, so we inject
// a reader. No-op unless SKILL_LEARNING_ENABLED + agent-memory backend.
installSkillLearner(readCompletedTurn);
// SIO-1005: start the in-process Bun.cron that reconciles proposed iac-change memory facts to their
// real terminal state. Shares this process's MCP bridge + memory client. Enabled implicitly by the
// agent-memory backend (LIVE_MEMORY_BACKEND=agent-memory); a no-op on any other backend.
startIacReconcileCron();

// SIO-987: is a TCP server already listening on host:port? A successful connect means yes (something
// -- a standalone KG server -- already owns the port). Resolves false on connect refused/timeout.
// Short timeout so module-load is not delayed. Never throws.
function isPortInUse(host: string, port: number, timeoutMs = 300): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = netConnect({ host, port });
		const done = (inUse: boolean) => {
			socket.destroy();
			resolve(inUse);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false)); // ECONNREFUSED -> nothing listening
	});
}

// SIO-967: mount the knowledge-graph MCP server IN-PROCESS. Embedded lbug takes an
// exclusive file lock, so the graph can only be opened by ONE process -- and the agent
// pipeline's record* nodes already open it here. Running the server in this same
// process lets its kg_* tools reuse the single getGraphStore() singleton while still
// being reachable over localhost like every other MCP server. Gated on
// KNOWLEDGE_GRAPH_ENABLED; best-effort so a start failure never blocks the app.
const kgMcpLog = getLogger("agent:knowledge-graph-mcp");
let knowledgeGraphMcpUrl: string | undefined;
if (process.env.KNOWLEDGE_GRAPH_ENABLED === "true" || process.env.KNOWLEDGE_GRAPH_ENABLED === "1") {
	const host = process.env.KNOWLEDGE_GRAPH_MCP_HOST ?? "127.0.0.1";
	const port = process.env.KNOWLEDGE_GRAPH_MCP_PORT ?? "9087";
	const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
	knowledgeGraphMcpUrl = `http://${probeHost}:${port}`;
	const onKgStartFailure = (err: unknown) => {
		knowledgeGraphMcpUrl = undefined;
		kgMcpLog.warn(
			{ error: err instanceof Error ? err.message : String(err) },
			"in-process knowledge-graph MCP server failed to start; kg_* tools unavailable",
		);
	};
	// SIO-987: pre-flight check. If something is ALREADY listening on the KG port, a standalone KG
	// server is running -- do NOT try to bind (that produced a misleading EADDRINUSE + "Fatal" log).
	// Skip the in-process start and warn clearly: the agent writes the graph IN-PROCESS via the
	// getGraphStore() singleton, so a standalone server holding the embedded-lbug exclusive lock will
	// LOCK OUT those writes (the graph silently never populates). The kg_* read tools still register
	// against the existing instance (knowledgeGraphMcpUrl stays set). The check runs in a fire-and-
	// forget async IIFE so module evaluation is never blocked.
	(async () => {
		if (await isPortInUse(probeHost, Number(port))) {
			kgMcpLog.warn(
				{ url: knowledgeGraphMcpUrl },
				"a knowledge-graph server is already running on this port (likely started standalone). The agent " +
					"writes the graph IN-PROCESS and will be LOCKED OUT by a standalone server's exclusive lbug lock -- " +
					"graph writes will fail silently. Stop the standalone server; the agent starts the KG itself when " +
					"KNOWLEDGE_GRAPH_ENABLED=true. Registering the existing instance's read-only kg_* tools for now.",
			);
			return;
		}
		// SIO-986: truly best-effort. startKnowledgeGraphServer() can throw SYNCHRONOUSLY during eager
		// module evaluation (loadConfig / transport setup), so wrap in try/catch (sync) AND .catch (async)
		// -- neither a thrown error nor a rejected promise propagates past here; a failure only disables kg_*.
		try {
			await startKnowledgeGraphServer();
			kgMcpLog.info({ url: knowledgeGraphMcpUrl }, "in-process knowledge-graph MCP server started");
		} catch (err) {
			onKgStartFailure(err);
		}
	})();
}

const pruneLog = getLogger("agent:state-pruning");
// SIO-958: session lifecycle visibility (why/when a conversation's session ends).
const sessionLog = getLogger("agent:session-lifecycle");

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

// SIO-956: a session = one conversation, and it ends ONLY when the user starts a
// new one -- Clear, switch agent, new conversation, or a real page unload
// (pagehide). There is deliberately NO idle-TTL sweep and NO visibilitychange
// trigger: SIO-952's time-based sweep + tab-hide beacon ended sessions
// mid-conversation (a multi-minute fleet-apply turn was torn down at 2:54 when
// the tab was backgrounded), dropping that turn's live-memory writes and
// spamming SESSION_ALREADY_ENDED. Conversation-end is a user action, not a timer.

async function sessionBootstrap(threadId: string, agentName: string, firstUserQuery?: string): Promise<void> {
	if (bootstrappedThreads.has(threadId)) return;
	bootstrappedThreads.add(threadId);
	try {
		// SIO-938: threadId -> Agent Memory session, agentName -> user, firstUserQuery
		// seeds semantic recall over the agent's past sessions.
		await runBootstrap({ threadId, agentName, firstUserQuery });
	} catch {
		// Bootstrap is best-effort; a failure must not block the investigation.
		// runBootstrap already logs its own step failures.
	}
}

// SIO-846: explicit session-end seam. Called by the teardown endpoint when the
// user starts a new conversation (Clear / switch agent / new conversation) or on
// a real page unload (pagehide). Clears the run-once guard so a future turn on
// the same threadId re-bootstraps.
// SIO-958: `reason` records WHY the session ended (the frontend trigger) so an
// "unexpected" end is diagnosable from the backend log, not silent.
export async function sessionTeardown(
	threadId: string,
	agentName = "incident-analyzer",
	reason = "unspecified",
): Promise<void> {
	bootstrappedThreads.delete(threadId);
	sessionLog.info({ threadId, agentName, reason }, "agent session ending");
	try {
		await runTeardown({ threadId, agentName });
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
		// SIO-967: in-process server started above; undefined when KG is disabled or
		// the server failed to start, so the bridge simply registers no kg_* tools.
		knowledgeGraphUrl: knowledgeGraphMcpUrl,
	};
}

export function ensureMcpConnected(): Promise<void> {
	if (!mcpReady) {
		mcpReady = createMcpClient(getMcpConfig());
	}
	return mcpReady;
}

// SIO-482: active SSE connection count for the /health endpoint. The stream
// route increments on ReadableStream start and decrements on close/cancel.
let activeSseConnections = 0;
export function incrementSseConnections(): void {
	activeSseConnections += 1;
}
export function decrementSseConnections(): void {
	activeSseConnections = Math.max(0, activeSseConnections - 1);
}
export function getActiveSseConnections(): number {
	return activeSseConnections;
}

// SIO-482: runtime status for /health, without leaking module internals.
// graphReady/iacGraphReady reflect whether each compiled graph singleton has
// been initialized (lazily, on first invoke); mcpReady reflects the MCP client.
export function getAgentRuntimeStatus(): {
	graphReady: boolean;
	iacGraphReady: boolean;
	mcpInitialized: boolean;
	checkpointerType: "memory" | "sqlite";
} {
	return {
		graphReady: graphPromise !== null,
		iacGraphReady: iacGraphPromise !== null,
		mcpInitialized: mcpReady !== null,
		checkpointerType: resolveCheckpointerType(),
	};
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

	const agentName = options.agentName ?? "incident-analyzer";

	// SIO-846/SIO-938: run agent-session bootstrap once per thread before the
	// first turn. The latest user message seeds agent-memory semantic recall.
	const latestUserQuery = [...messages].reverse().find((m) => m.role === "user")?.content;
	await sessionBootstrap(options.threadId, agentName, latestUserQuery);

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
			{ messages: langchainMessages, requestId, isFollowUp: options.isFollowUp ?? false },
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

// SIO-476: prune the persisted checkpoint after a turn. Reads thread state,
// drops messages beyond the window (RemoveMessage honored by MessagesAnnotation;
// a shorter array would merge, not truncate), and resets dataSourceResults via
// its reducer's empty-array reset branch. Best-effort: never breaks the response.
export async function pruneThreadState(threadId: string, agentName = "incident-analyzer"): Promise<void> {
	try {
		const graph = agentName === "elastic-iac" ? await getIacGraph() : await getGraph();
		const config = { configurable: { thread_id: threadId } };
		const snapshot = await graph.getState(config);
		const messages = (snapshot.values?.messages ?? []) as BaseMessage[];
		if (!needsPruning(messages)) return;
		const { removeIds } = pruneState(messages);
		// Only remove ids actually present (messagesStateReducer throws on an
		// unknown id, and updateState is atomic — a stale id would discard the
		// whole batch). Filtering makes this idempotent by construction.
		const present = new Set(messages.map((m) => m.id).filter((id): id is string => id !== undefined));
		const liveIds = removeIds.filter((id) => present.has(id));
		if (liveIds.length === 0) return;
		const { RemoveMessage } = await import("@langchain/core/messages");
		await graph.updateState(config, {
			messages: liveIds.map((id) => new RemoveMessage({ id })),
			dataSourceResults: [],
		});
		pruneLog.info({ threadId, removed: liveIds.length }, "pruned thread state");
	} catch (error) {
		pruneLog.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"state pruning failed; continuing",
		);
	}
}

// SIO-1015: read the just-completed orchestrator turn into the skill-learner's
// input. Scoped to incident-analyzer (elastic-iac has no confidence/datasource
// signal) -> returns null for any other agent. Best-effort: null on any failure.
// Builds a compact transcript (latest user ask + assistant report) for the judge;
// the learner core PII-redacts before any write.
async function readCompletedTurn(ctx: { agentName: string; threadId: string }): Promise<SkillLearnerTurn | null> {
	if (ctx.agentName !== "incident-analyzer") return null;
	try {
		const graph = await getGraph();
		const snapshot = await graph.getState({ configurable: { thread_id: ctx.threadId } });
		const values = snapshot.values ?? {};
		const messages = (values.messages ?? []) as BaseMessage[];
		const dataSourceResults = (values.dataSourceResults ?? []) as Array<{
			dataSourceId?: string;
			toolOutputs?: unknown[];
		}>;
		const datasourcesUsed = dataSourceResults
			.filter((r) => (r.toolOutputs?.length ?? 0) > 0)
			.map((r) => r.dataSourceId)
			.filter((id): id is string => Boolean(id));

		// Compact transcript: the last human turn + the last assistant report. Each
		// message's content can be a string or content-block array; coerce to text.
		const text = (m: BaseMessage): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
		const lastHuman = [...messages].reverse().find((m) => m.getType() === "human");
		const lastAi = [...messages].reverse().find((m) => m.getType() === "ai");
		const transcript = [lastHuman && `User: ${text(lastHuman)}`, lastAi && `Assistant: ${text(lastAi)}`]
			.filter(Boolean)
			.join("\n\n");

		return {
			agentName: ctx.agentName,
			threadId: ctx.threadId,
			queryComplexity: (values.queryComplexity ?? "complex") as "simple" | "complex",
			confidenceScore: typeof values.confidenceScore === "number" ? values.confidenceScore : 0,
			datasourcesUsed,
			transcript,
		};
	} catch (error) {
		getLogger("web:skill-learner").warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"readCompletedTurn failed; skipping skill learning for this turn",
		);
		return null;
	}
}

// SIO-942: re-export the post-turn live-memory flush so the completion routes
// import it from the same module as pruneThreadState (they run side by side after
// every turn). Best-effort; no-op unless the agent-memory backend is selected.
// SIO-952: re-export the session-outcome setter so completion routes can stamp
// the turn outcome onto the Agent Memory session (last-wins; applied at
// conversation-close via updateSession). No-op unless the agent-memory backend
// is selected.
export { runPostTurn, setSessionOutcome };

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

// SIO-930: the IaC graph streams its final message through the checkpointer (no output-node token
// stream), so the SSE handlers read terminal state here to label the completion chip. Mirrors
// getLastAssistantText's state access. Defaults to "completed" if state can't be read.
export async function getIacTurnOutcome(threadId: string): Promise<IacTurnOutcome> {
	try {
		const graph = await getIacGraph();
		const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
		return iacTurnOutcome(snapshot.values as IacStateType);
	} catch {
		return "completed";
	}
}
