// apps/web/src/lib/stores/agent.svelte.ts

import type {
	ActionResult,
	DataSourceContext,
	PendingAction,
	StreamEvent,
	TicketProviderInfo,
} from "@devops-agent/shared";
import type { AttachmentBlock } from "@devops-agent/shared/src/attachments.ts";
// Deep import, NOT the barrel: this file ships to the browser, and a value
// import of the @devops-agent/shared index drags server-only modules
// (request-context's AsyncLocalStorage, telemetry, MCP server code) into the
// client bundle, crashing the app at load (white screen).
import { TicketProviderInfoSchema } from "@devops-agent/shared/src/ticket-types.ts";
import { z } from "zod";
import {
	applyStreamEvent,
	type DataSourceFindings,
	type FleetUpgradeChoice,
	type FleetUpgradePreview,
	type FleetUpgradeResultRow,
	type HilLearningMatchPrompt,
	type HilLearningReviewPrompt,
	type IacClarifyPrompt,
	type IacDriftReport,
	type IacPlanReviewPrompt,
	type IacReconcileChoice,
	type IacReconcileResultRow,
	type ReconcileDirection,
	type ReducerState,
	type SyntheticsDriftReport,
	type SyntheticsPushChoice,
	type SyntheticsPushResultRow,
	type TopicShiftPrompt,
} from "./agent-reducer.ts";
import { parseSseChunks } from "./sse-buffer.ts";

export type AgentId = "incident-analyzer" | "elastic-iac";

export interface ChatMessage {
	// SIO-1042: stable identity for {#each} keying (was index-based, causing DOM node reuse
	// glitches across message list mutations). Assigned once at creation, never regenerated.
	id: string;
	role: "user" | "assistant";
	content: string;
	suggestions?: string[];
	responseTime?: number;
	toolsUsed?: string[];
	completedNodes?: Map<string, { duration: number }>;
	dataSourceResults?: Map<string, { status: string; message?: string }>;
	// SIO-775: typed findings per datasource (keyed by bare id e.g. "kafka").
	dataSourceFindings?: Map<string, DataSourceFindings>;
	feedback?: "up" | "down" | null;
	runId?: string;
	// SIO-1134: the turn's requestId (== KG incident id) for ticket-creation curation.
	requestId?: string;
	confidence?: number;
	// SIO-930: per-turn outcome for the IaC completion chip (rejected/declined/etc.).
	// SIO-1110: "error" marks a turn whose stream ended in an error event.
	outcome?: "completed" | "rejected" | "declined" | "no-op" | "blocked" | "unsupported" | "pipeline-failed" | "error";
	// SIO-991: the GitOps MR pipeline-log snapshot for THIS turn (the "Pipeline log (N steps)"
	// panel). Captured per-message like completedNodes so it survives subsequent turns -- the
	// global iacPipelineLog is cleared on the next sendMessage, which used to wipe the panel.
	iacPipelineLog?: string[];
}

export interface FollowUpContext {
	isFollowUp: boolean;
	dataSourceContext?: DataSourceContext;
}

// SIO-608: Frontend polling interval for health status
const HEALTH_POLL_INTERVAL_MS = 15_000;

// SIO-1124: response boundary for GET /api/tickets/providers.
const TicketProvidersResponseSchema = z.object({ providers: z.array(TicketProviderInfoSchema) });

// SIO-780: probe state literal-union (mirrors mcp-bridge ProbeState)
type ProbeState = "ready" | "unready" | "down" | "replaced" | "misidentified";

function createAgentStore() {
	let messages = $state<ChatMessage[]>([]);
	let dataSourceProgress = $state<Map<string, { status: string; message?: string }>>(new Map());
	let dataSourceFindings = $state<Map<string, DataSourceFindings>>(new Map());
	let isStreaming = $state(false);
	let threadId = $state<string>("");
	let currentContent = $state("");
	let selectedDataSources = $state<string[]>([]);
	let connectedDataSources = $state<string[]>([]);
	let availableDataSources = $state<string[]>([]);
	// SIO-780: per-datasource probe state ("ready" | "unready" | "down" | "replaced" | "misidentified")
	let stateDataSources = $state<Record<string, ProbeState>>({});
	// SIO-649: Available is populated from GET /api/deployments on mount; selected defaults to all.
	let availableElasticDeployments = $state<string[]>([]);
	let selectedElasticDeployments = $state<string[]>([]);
	// SIO-836: Available is populated from GET /api/aws/estates on mount; selected defaults to all.
	let availableAwsEstates = $state<{ id: string; region: string }[]>([]);
	let selectedAwsEstates = $state<string[]>([]);
	// SIO-1124: populated from GET /api/tickets/providers on mount; empty hides the Create-ticket button.
	let availableTicketProviders = $state<TicketProviderInfo[]>([]);
	let activeNodes = $state<Set<string>>(new Set());
	let completedNodes = $state<Map<string, { duration: number }>>(new Map());
	let lastSuggestions = $state<string[]>([]);
	let lastResponseTime = $state<number | undefined>(undefined);
	let lastToolsUsed = $state<string[]>([]);
	let lastRunId = $state<string | undefined>(undefined);
	let lastRequestId = $state<string | undefined>(undefined);
	let lastConfidence = $state<number | undefined>(undefined);
	let lastOutcome = $state<
		"completed" | "rejected" | "declined" | "no-op" | "blocked" | "unsupported" | "pipeline-failed" | "error"
	>("completed");
	let lastDataSourceContext = $state<DataSourceContext | undefined>(undefined);
	let pendingAttachments = $state<AttachmentBlock[]>([]);
	let pendingActions = $state<PendingAction[]>([]);
	let actionResults = $state<ActionResult[]>([]);
	// SIO-751: HITL banner state for cross-turn topic-shift detection.
	let topicShiftPrompt = $state<TopicShiftPrompt | null>(null);
	// SIO-1126: HIL learning lane gate cards.
	let hilLearningMatch = $state<HilLearningMatchPrompt | null>(null);
	let hilLearningReview = $state<HilLearningReviewPrompt | null>(null);
	// Which agent the UI is driving; toggled from the robot icon.
	let currentAgent = $state<AgentId>("incident-analyzer");
	// elastic-iac HITL banners.
	let iacClarify = $state<IacClarifyPrompt | null>(null);
	let iacPlanReview = $state<IacPlanReviewPrompt | null>(null);
	let iacPipelineProgress = $state<string[]>([]);
	// SIO-982: snapshot of the pipeline ticker captured on `done`, so a GitOps MR turn keeps a
	// persistent collapsed pipeline log after streaming (the GitOps analogue of fleet's progressLog).
	let iacPipelineLog = $state<string[] | undefined>(undefined);
	// SIO-882: drift sub-flow UI state.
	let iacDriftReport = $state<IacDriftReport | null>(null);
	let iacReconcileChoice = $state<IacReconcileChoice | null>(null);
	let iacReconcileResults = $state<IacReconcileResultRow[]>([]);
	let syntheticsDriftReport = $state<SyntheticsDriftReport | null>(null);
	let syntheticsPushChoice = $state<SyntheticsPushChoice | null>(null);
	let syntheticsPushResult = $state<SyntheticsPushResultRow | null>(null);
	// SIO-913 / SIO-922: fleet upgrade sub-flow UI state.
	let fleetUpgradePreview = $state<FleetUpgradePreview | null>(null);
	let fleetUpgradeChoice = $state<FleetUpgradeChoice | null>(null);
	let fleetUpgradeResult = $state<FleetUpgradeResultRow | null>(null);
	let abortController: AbortController | null = null;
	let healthPollTimer: ReturnType<typeof setInterval> | null = null;

	// SIO-934: build the finalized assistant message from the current live turn state.
	// Shared by sendMessage / resumeIac / resolveTopicShift so every code path persists the
	// same trace + outcome + feedback metadata (previously resumeIac dropped responseTime/
	// outcome/toolsUsed, so resumed turns failed the trace gate and always showed "Completed").
	function buildAssistantMessage(content: string): ChatMessage {
		return {
			id: crypto.randomUUID(),
			role: "assistant",
			content,
			suggestions: [...lastSuggestions],
			responseTime: lastResponseTime,
			toolsUsed: [...lastToolsUsed],
			completedNodes: new Map(completedNodes),
			dataSourceResults: new Map(dataSourceProgress),
			dataSourceFindings: new Map(dataSourceFindings),
			feedback: null,
			runId: lastRunId,
			requestId: lastRequestId,
			confidence: lastConfidence,
			outcome: lastOutcome,
			// SIO-991: pin the GitOps pipeline-log snapshot to THIS message so it persists across
			// later turns (the global iacPipelineLog is cleared on the next sendMessage). Only the
			// snapshot taken at `done` (iacPipelineLog) is per-message; the live ticker is global.
			...(iacPipelineLog?.length ? { iacPipelineLog: [...iacPipelineLog] } : {}),
		};
	}

	// SIO-934: an elastic-iac turn that paused on an interrupt (plan-review / clarify /
	// reconcile / synthetics-push / fleet-upgrade gate) is the SAME logical turn continuing;
	// the resume leg must keep accumulating onto the pipeline rather than starting blank. Used
	// to decide whether the stream's finally preserves the live completedNodes ticker.
	function isPausedOnIacInterrupt(): boolean {
		return (
			iacPlanReview !== null ||
			iacClarify !== null ||
			iacReconcileChoice !== null ||
			syntheticsPushChoice !== null ||
			fleetUpgradeChoice !== null
		);
	}

	async function sendMessage(content: string, followUpContext?: FollowUpContext) {
		if (isStreaming || !content.trim()) return;

		// SIO-610: Capture attachments before clearing
		const attachmentsToSend = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
		pendingAttachments = [];

		messages = [...messages, { id: crypto.randomUUID(), role: "user", content }];
		isStreaming = true;
		currentContent = "";
		dataSourceProgress = new Map();
		dataSourceFindings = new Map();
		activeNodes = new Set();
		completedNodes = new Map();
		lastSuggestions = [];
		lastResponseTime = undefined;
		lastToolsUsed = [];
		lastRunId = undefined;
		lastConfidence = undefined;
		lastOutcome = "completed";
		iacPipelineProgress = [];
		// SIO-882: a new message starts a fresh drift pass (the prompt/report persist
		// across interrupt pauses, so they're cleared here, not in the stream's finally).
		iacDriftReport = null;
		iacReconcileChoice = null;
		iacReconcileResults = [];
		// SIO-902: same for the synthetics drift sub-flow.
		syntheticsDriftReport = null;
		syntheticsPushChoice = null;
		syntheticsPushResult = null;
		// SIO-913 / SIO-922: same for the fleet upgrade sub-flow.
		fleetUpgradePreview = null;
		fleetUpgradeChoice = null;
		fleetUpgradeResult = null;
		iacPipelineLog = undefined; // SIO-982: clear the prior GitOps pipeline log on a new turn

		abortController = new AbortController();

		try {
			// SIO-649: Only send targetDeployments when Elastic is actually in scope. Empty array is
			// valid (means "use default deployment") and distinct from undefined (multi-deployment off).
			const includeDeployments = selectedDataSources.includes("elastic") && availableElasticDeployments.length > 0;
			// SIO-836: Only send uiAwsEstates when AWS is in scope. Filter to known estate ids so a
			// stale selection (estate removed from AWS_ESTATES) is dropped. Empty selection routes to
			// the LLM router, matching Elastic's "empty = let backend decide" semantics.
			const knownEstateIds = new Set(availableAwsEstates.map((e) => e.id));
			const includeAwsEstates = selectedDataSources.includes("aws") && availableAwsEstates.length > 0;
			const response = await fetch("/api/agent/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: messages.map((m) => ({ role: m.role, content: m.content })),
					threadId: threadId || undefined,
					agentName: currentAgent,
					dataSources: selectedDataSources,
					...(includeDeployments && { targetDeployments: selectedElasticDeployments }),
					...(includeAwsEstates && { uiAwsEstates: selectedAwsEstates.filter((id) => knownEstateIds.has(id)) }),
					...(attachmentsToSend && { attachments: attachmentsToSend }),
					...(followUpContext?.isFollowUp && { isFollowUp: true }),
					...(followUpContext?.dataSourceContext && { dataSourceContext: followUpContext.dataSourceContext }),
				}),
				signal: abortController.signal,
			});

			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}

			for await (const event of parseSseChunks(response.body)) {
				handleEvent(event);
			}
		} catch (error) {
			const isAbort = error instanceof DOMException && error.name === "AbortError";
			if (!isAbort) {
				currentContent += `\n\n[Error: ${error instanceof Error ? error.message : String(error)}]`;
				// SIO-1110: fetch/parse failures never reach the reducer's error case.
				lastOutcome = "error";
			}
		} finally {
			abortController = null;
			if (currentContent) {
				messages = [...messages, buildAssistantMessage(currentContent)];
				currentContent = "";
			}
			isStreaming = false;
			activeNodes = new Set();
			lastSuggestions = [];
			dataSourceProgress = new Map();
			dataSourceFindings = new Map();
			// SIO-934: when this turn paused on an IaC interrupt, the resume leg continues the
			// SAME turn -- keep the live pipeline ticker (completedNodes) + iacPipelineProgress so
			// resumeIac accumulates onto it instead of resetting to just the post-resume nodes.
			// (A brand-new turn resets these at the top of sendMessage, so nothing bleeds over.)
			// SIO-1126: the HIL learning gates pause the same way; keep the first leg's pills.
			if (!isPausedOnIacInterrupt() && hilLearningMatch === null && hilLearningReview === null) {
				completedNodes = new Map();
				iacPipelineProgress = [];
			}
		}
	}

	function handleEvent(event: StreamEvent) {
		const snapshot: ReducerState = {
			currentContent,
			threadId,
			activeNodes,
			completedNodes,
			dataSourceProgress,
			dataSourceFindings,
			lastSuggestions,
			lastResponseTime,
			lastToolsUsed,
			lastRunId,
			lastRequestId,
			lastConfidence,
			lastOutcome,
			lastDataSourceContext,
			pendingActions,
			actionResults,
			topicShiftPrompt,
			hilLearningMatch,
			hilLearningReview,
			iacClarify,
			iacPlanReview,
			iacPipelineProgress,
			iacPipelineLog,
			iacDriftReport,
			iacReconcileChoice,
			iacReconcileResults,
			syntheticsDriftReport,
			syntheticsPushChoice,
			syntheticsPushResult,
			fleetUpgradePreview,
			fleetUpgradeChoice,
			fleetUpgradeResult,
		};
		const next = applyStreamEvent(snapshot, event);
		currentContent = next.currentContent;
		threadId = next.threadId;
		activeNodes = next.activeNodes;
		completedNodes = next.completedNodes;
		dataSourceProgress = next.dataSourceProgress;
		dataSourceFindings = next.dataSourceFindings;
		lastSuggestions = next.lastSuggestions;
		lastResponseTime = next.lastResponseTime;
		lastToolsUsed = next.lastToolsUsed;
		lastRunId = next.lastRunId;
		lastRequestId = next.lastRequestId;
		lastConfidence = next.lastConfidence;
		lastOutcome = next.lastOutcome;
		lastDataSourceContext = next.lastDataSourceContext;
		pendingActions = next.pendingActions;
		actionResults = next.actionResults;
		topicShiftPrompt = next.topicShiftPrompt;
		hilLearningMatch = next.hilLearningMatch;
		hilLearningReview = next.hilLearningReview;
		iacClarify = next.iacClarify;
		iacPlanReview = next.iacPlanReview;
		iacPipelineProgress = next.iacPipelineProgress;
		iacPipelineLog = next.iacPipelineLog;
		iacDriftReport = next.iacDriftReport;
		iacReconcileChoice = next.iacReconcileChoice;
		iacReconcileResults = next.iacReconcileResults;
		syntheticsDriftReport = next.syntheticsDriftReport;
		syntheticsPushChoice = next.syntheticsPushChoice;
		syntheticsPushResult = next.syntheticsPushResult;
		fleetUpgradePreview = next.fleetUpgradePreview;
		fleetUpgradeChoice = next.fleetUpgradeChoice;
		fleetUpgradeResult = next.fleetUpgradeResult;
	}

	async function setFeedback(messageIndex: number, score: "up" | "down") {
		const msg = messages[messageIndex];
		if (!msg || msg.role !== "assistant") return;
		const current = msg.feedback === score ? null : score;
		messages = messages.map((m, i) => (i === messageIndex ? { ...m, feedback: current } : m));

		if (msg.runId && current) {
			try {
				await fetch("/api/agent/feedback", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						runId: msg.runId,
						score: current === "up" ? 1 : 0,
					}),
				});
			} catch {
				// Feedback submission is best-effort
			}
		}
	}

	function cancelStream() {
		abortController?.abort();
	}

	async function executeAction(action: PendingAction, reportContent: string) {
		try {
			const res = await fetch("/api/agent/actions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action,
					reportContent,
					threadId,
				}),
			});
			const result: ActionResult = await res.json();
			actionResults = [...actionResults, result];
			pendingActions = pendingActions.filter((a) => a.id !== action.id);
			return result;
		} catch {
			return null;
		}
	}

	function dismissAction(actionId: string) {
		pendingActions = pendingActions.filter((a) => a.id !== actionId);
	}

	async function loadDataSources() {
		try {
			const res = await fetch("/api/datasources");
			const data = await res.json();
			availableDataSources = data.dataSources ?? [];
			connectedDataSources = data.connected ?? [];
			stateDataSources = data.states ?? {};
			selectedDataSources = connectedDataSources.length > 0 ? [...connectedDataSources] : [...availableDataSources];
		} catch {
			availableDataSources = [];
			selectedDataSources = [];
			connectedDataSources = [];
			stateDataSources = {};
		}
		// SIO-649: Best-effort deployment list fetch. A failure here just hides the sub-selector.
		try {
			const res = await fetch("/api/deployments");
			const data: { deployments?: string[] } = await res.json();
			availableElasticDeployments = data.deployments ?? [];
			selectedElasticDeployments = [...availableElasticDeployments];
		} catch {
			availableElasticDeployments = [];
			selectedElasticDeployments = [];
		}
		// SIO-836: Best-effort AWS estate list fetch. A failure here just hides the sub-selector.
		try {
			const res = await fetch("/api/aws/estates");
			const data: { estates?: { id: string; region: string }[] } = await res.json();
			availableAwsEstates = data.estates ?? [];
			selectedAwsEstates = availableAwsEstates.map((e) => e.id);
		} catch {
			availableAwsEstates = [];
			selectedAwsEstates = [];
		}
		// SIO-1124: Best-effort ticket-provider fetch. A failure or malformed
		// payload just hides the Create-ticket button.
		try {
			const res = await fetch("/api/tickets/providers");
			if (!res.ok) throw new Error(`providers fetch failed (${res.status})`);
			const parsed = TicketProvidersResponseSchema.safeParse(await res.json());
			availableTicketProviders = parsed.success ? parsed.data.providers : [];
		} catch {
			availableTicketProviders = [];
		}
		startHealthPolling();
	}

	// SIO-608: Periodic health polling to keep pill status in sync
	function startHealthPolling(): void {
		if (healthPollTimer) return;
		healthPollTimer = setInterval(async () => {
			try {
				const res = await fetch("/api/datasources");
				const data: { dataSources: string[]; connected: string[]; states?: Record<string, ProbeState> } =
					await res.json();
				const newConnected = data.connected ?? [];
				const prevConnected = connectedDataSources;

				connectedDataSources = newConnected;
				stateDataSources = data.states ?? {};

				if (!isStreaming) {
					// Auto-deselect datasources that went offline
					const wentOffline = prevConnected.filter((ds) => !newConnected.includes(ds));
					if (wentOffline.length > 0) {
						selectedDataSources = selectedDataSources.filter((ds) => !wentOffline.includes(ds));
					}

					// Auto-select datasources that came online
					const cameOnline = newConnected.filter((ds) => !prevConnected.includes(ds));
					if (cameOnline.length > 0) {
						selectedDataSources = [...new Set([...selectedDataSources, ...cameOnline])];
					}
				}
			} catch {
				// Best-effort polling
			}
		}, HEALTH_POLL_INTERVAL_MS);
	}

	function stopHealthPolling(): void {
		if (healthPollTimer) {
			clearInterval(healthPollTimer);
			healthPollTimer = null;
		}
	}

	// SIO-952/SIO-956: a session = one conversation. End the prior conversation's
	// Agent Memory session deterministically (so end_time gets set) when the user
	// starts a new conversation (Clear / switch agent) or leaves the page
	// (pagehide). Uses sendBeacon so it survives page unload; no-ops when there is
	// no live thread. Best-effort: the server end is idempotent (SIO-956), so a
	// dropped/duplicate beacon is harmless.
	// SIO-958: `reason` records WHICH action ended the session, logged on both the
	// client (here) and the server, so an unexpected end is diagnosable.
	function teardownSession(tid: string, agentName: AgentId, reason: string): void {
		if (!tid) return;
		console.log("[session] ending", { threadId: tid, agentName, reason });
		const body = JSON.stringify({ threadId: tid, agentName, reason });
		try {
			if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
				navigator.sendBeacon("/api/agent/session/teardown", new Blob([body], { type: "application/json" }));
				return;
			}
		} catch {
			// fall through to fetch
		}
		// keepalive lets the request outlive the page in browsers without sendBeacon.
		void fetch("/api/agent/session/teardown", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => {});
	}

	// SIO-952: public seam for the page's pagehide (real unload) listener.
	function endCurrentSession(): void {
		teardownSession(threadId, currentAgent, "pagehide");
	}

	function clearChat() {
		// End the conversation we are leaving before its thread id is cleared.
		teardownSession(threadId, currentAgent, "clear");
		messages = [];
		threadId = "";
		currentContent = "";
		dataSourceProgress = new Map();
		dataSourceFindings = new Map();
		activeNodes = new Set();
		completedNodes = new Map();
		lastSuggestions = [];
		lastDataSourceContext = undefined;
		pendingAttachments = [];
		pendingActions = [];
		actionResults = [];
		topicShiftPrompt = null;
		hilLearningMatch = null;
		hilLearningReview = null;
		iacClarify = null;
		iacPlanReview = null;
		iacPipelineProgress = [];
		iacDriftReport = null;
		iacReconcileChoice = null;
		iacReconcileResults = [];
		syntheticsDriftReport = null;
		syntheticsPushChoice = null;
		syntheticsPushResult = null;
		fleetUpgradePreview = null;
		fleetUpgradeChoice = null;
		fleetUpgradeResult = null;
		iacPipelineLog = undefined; // SIO-982: clear the prior GitOps pipeline log on a new turn
	}

	// Flip the UI between the incident-analyzer and the elastic-iac agent. Switching
	// starts a fresh conversation (each agent has its own graph + checkpointer).
	function switchAgent(agent: AgentId) {
		if (agent === currentAgent || isStreaming) return;
		// SIO-952: end the outgoing agent's conversation with ITS name before we
		// flip currentAgent (clearChat tears down with currentAgent; flipping first
		// would attribute the teardown to the wrong agent/user).
		teardownSession(threadId, currentAgent, "switch-agent");
		threadId = "";
		currentAgent = agent;
		clearChat();
	}

	// Resume the elastic-iac graph after an interrupt (plan-review decision or a
	// clarification answer), piping the resulting SSE stream back through handleEvent.
	async function resumeIac(
		payload: { decision?: "approved" | "rejected"; answer?: string; direction?: ReconcileDirection; approve?: boolean },
		threadIdOverride: string,
	) {
		if (isStreaming) return;
		iacPlanReview = null;
		iacClarify = null;
		// SIO-882 / SIO-928: keep the current interrupt choice cards until the resume actually
		// succeeds, so a transient network/500 failure doesn't drop the only UI to retry. Snapshot
		// them, null them optimistically (the card vanishes the instant the user approves, instead
		// of lingering disabled until the terminal result ~2 min later), clear for real once the
		// stream opens, and restore on failure. A chained interrupt repopulates them on success.
		const pendingReconcileChoice = iacReconcileChoice;
		const pendingFleetUpgradeChoice = fleetUpgradeChoice;
		const pendingSyntheticsPushChoice = syntheticsPushChoice;
		fleetUpgradeChoice = null;
		syntheticsPushChoice = null;
		iacPipelineProgress = [];
		isStreaming = true;
		currentContent = "";
		activeNodes = new Set();
		// SIO-934: do NOT reset completedNodes here -- this resume continues the SAME turn that
		// paused at the interrupt, so leg 2 (e.g. openMr -> watchPipeline) must accumulate onto the
		// pipeline already built in leg 1 (parseIntent ... reviewPlan). Resetting here is what made
		// the live panel show only "MR opened" with all earlier nodes greyed. (iacPipelineProgress
		// is the separate watch-ticker; it stays per-leg and is reset above, as before.)
		try {
			const response = await fetch("/api/agent/iac/resume", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ threadId: threadIdOverride, ...payload }),
			});
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			iacReconcileChoice = null;
			for await (const event of parseSseChunks(response.body)) {
				handleEvent(event);
			}
		} catch (error) {
			// Restore the choices so the user can retry (keep a newer chained prompt if one arrived).
			iacReconcileChoice = iacReconcileChoice ?? pendingReconcileChoice;
			fleetUpgradeChoice = fleetUpgradeChoice ?? pendingFleetUpgradeChoice;
			syntheticsPushChoice = syntheticsPushChoice ?? pendingSyntheticsPushChoice;
			currentContent += `\n\n[Error resuming IaC agent: ${error instanceof Error ? error.message : String(error)}]`;
			// SIO-1110: resume-leg failures never reach the reducer's error case.
			lastOutcome = "error";
		} finally {
			if (currentContent) {
				// SIO-934: persist the full trace + outcome metadata (was: content + completedNodes
				// only, which dropped responseTime/outcome/toolsUsed so resumed turns failed the
				// trace gate and always rendered a green "Completed" chip).
				messages = [...messages, buildAssistantMessage(currentContent)];
				currentContent = "";
			}
			isStreaming = false;
			activeNodes = new Set();
			// SIO-934: a chained interrupt (e.g. clarify -> plan-review, or the per-stack reconcile
			// loop) means the turn pauses again -- keep completedNodes so the next resume leg keeps
			// building the same pipeline. Only clear once the turn truly ends.
			if (!isPausedOnIacInterrupt()) {
				completedNodes = new Map();
			}
			// SIO-876: the final status+plan+approval now lives in the message; clear the live
			// watch-ticker so it doesn't linger (per-leg; unchanged from before SIO-934).
			iacPipelineProgress = [];
		}
	}

	function resolveIacPlanReview(decision: "approved" | "rejected") {
		if (!iacPlanReview) return;
		return resumeIac({ decision }, iacPlanReview.threadId);
	}

	function submitIacClarify(answer: string) {
		if (!iacClarify || !answer.trim()) return;
		return resumeIac({ answer }, iacClarify.threadId);
	}

	// SIO-882: answer the per-stack reconcile gate (live / json / skip). Resumes the loop,
	// which opens the MR (or skips) and re-pauses for the next drifted stack.
	function resolveReconcileChoice(direction: ReconcileDirection) {
		if (!iacReconcileChoice) return;
		return resumeIac({ direction }, iacReconcileChoice.threadId);
	}

	// SIO-902: answer the single synthetics push gate (approve / decline). On approve the
	// agent triggers the remote push; on decline it stops with "Push declined".
	function approveSyntheticsPush(approve: boolean) {
		if (!syntheticsPushChoice) return;
		return resumeIac({ approve }, syntheticsPushChoice.threadId);
	}

	// SIO-913 / SIO-922: answer the single fleet-upgrade apply gate (approve / decline). On approve
	// the agent runs the imperative bulk_upgrade via CI; on decline it stops without applying.
	function approveFleetUpgrade(approve: boolean) {
		if (!fleetUpgradeChoice) return;
		return resumeIac({ approve }, fleetUpgradeChoice.threadId);
	}

	// SIO-1126: POST a HIL learning gate answer to the resume endpoint and pipe
	// the resulting SSE stream back through handleEvent. The server emits
	// `hil_learning_resolved` first (clearing the card via the reducer); the
	// match gate chains into the review gate, so a resume may repopulate a card.
	async function resumeHilLearning(
		payload: { match?: { incidentId: string | null }; review?: { decisions: Record<string, "approve" | "reject"> } },
		threadIdOverride: string,
	) {
		if (isStreaming) return;
		// Keep the gate cards until the resume succeeds (the resolveIac retry idiom):
		// snapshot, clear optimistically, restore on failure.
		const pendingMatch = hilLearningMatch;
		const pendingReview = hilLearningReview;
		hilLearningMatch = null;
		hilLearningReview = null;
		isStreaming = true;
		try {
			const response = await fetch("/api/agent/learning/resume", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ threadId: threadIdOverride, ...payload }),
			});
			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}
			for await (const event of parseSseChunks(response.body)) {
				handleEvent(event);
			}
		} catch (error) {
			hilLearningMatch = hilLearningMatch ?? pendingMatch;
			hilLearningReview = hilLearningReview ?? pendingReview;
			currentContent += `\n\n[Error resuming learning flow: ${error instanceof Error ? error.message : String(error)}]`;
			lastOutcome = "error";
		} finally {
			if (currentContent) {
				messages = [...messages, buildAssistantMessage(currentContent)];
				currentContent = "";
			}
			isStreaming = false;
			activeNodes = new Set();
			// A chained gate (match -> review) means the turn pauses again -- keep the
			// pipeline building across legs (the SIO-934 idiom).
			if (hilLearningMatch === null && hilLearningReview === null) {
				completedNodes = new Map();
			}
		}
	}

	function resolveHilMatch(incidentId: string | null) {
		if (!hilLearningMatch) return;
		return resumeHilLearning({ match: { incidentId } }, hilLearningMatch.threadId);
	}

	function resolveHilReview(decisions: Record<string, "approve" | "reject">) {
		if (!hilLearningReview) return;
		return resumeHilLearning({ review: { decisions } }, hilLearningReview.threadId);
	}

	// SIO-751: POST the user's topic-shift decision to the resume endpoint and
	// pipe the resulting SSE stream back through handleEvent. The server emits
	// `topic_shift_resolved` first (clearing the banner via the reducer) and
	// then resumes the graph normally.
	async function resolveTopicShift(decision: "continue" | "fresh") {
		if (!topicShiftPrompt || isStreaming) return;
		const tid = topicShiftPrompt.threadId;
		isStreaming = true;
		try {
			const response = await fetch("/api/agent/topic-shift", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ threadId: tid, decision }),
			});
			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}
			for await (const event of parseSseChunks(response.body)) {
				handleEvent(event);
			}
		} catch (error) {
			currentContent += `\n\n[Error resuming after topic-shift decision: ${error instanceof Error ? error.message : String(error)}]`;
			// SIO-1110: resume-leg failures never reach the reducer's error case.
			lastOutcome = "error";
		} finally {
			if (currentContent) {
				// SIO-934: shared finalizer (was an inline literal duplicating sendMessage's).
				messages = [...messages, buildAssistantMessage(currentContent)];
				currentContent = "";
			}
			isStreaming = false;
			activeNodes = new Set();
			completedNodes = new Map();
			lastSuggestions = [];
			dataSourceProgress = new Map();
			dataSourceFindings = new Map();
		}
	}

	return {
		get messages() {
			return messages;
		},
		get dataSourceProgress() {
			return dataSourceProgress;
		},
		get isStreaming() {
			return isStreaming;
		},
		get threadId() {
			return threadId;
		},
		get currentContent() {
			return currentContent;
		},
		get selectedDataSources() {
			return selectedDataSources;
		},
		set selectedDataSources(v: string[]) {
			selectedDataSources = v;
		},
		get connectedDataSources() {
			return connectedDataSources;
		},
		get availableDataSources() {
			return availableDataSources;
		},
		get stateDataSources() {
			return stateDataSources;
		},
		get availableElasticDeployments() {
			return availableElasticDeployments;
		},
		get selectedElasticDeployments() {
			return selectedElasticDeployments;
		},
		set selectedElasticDeployments(v: string[]) {
			selectedElasticDeployments = v;
		},
		get availableAwsEstates() {
			return availableAwsEstates;
		},
		get availableTicketProviders() {
			return availableTicketProviders;
		},
		get selectedAwsEstates() {
			return selectedAwsEstates;
		},
		set selectedAwsEstates(v: string[]) {
			selectedAwsEstates = v;
		},
		get activeNodes() {
			return activeNodes;
		},
		get completedNodes() {
			return completedNodes;
		},
		get lastDataSourceContext() {
			return lastDataSourceContext;
		},
		get pendingAttachments() {
			return pendingAttachments;
		},
		set pendingAttachments(v: AttachmentBlock[]) {
			pendingAttachments = v;
		},
		get pendingActions() {
			return pendingActions;
		},
		get actionResults() {
			return actionResults;
		},
		get topicShiftPrompt() {
			return topicShiftPrompt;
		},
		get hilLearningMatch() {
			return hilLearningMatch;
		},
		get hilLearningReview() {
			return hilLearningReview;
		},
		get currentAgent() {
			return currentAgent;
		},
		get iacClarify() {
			return iacClarify;
		},
		get iacPlanReview() {
			return iacPlanReview;
		},
		get iacPipelineProgress() {
			return iacPipelineProgress;
		},
		get iacPipelineLog() {
			return iacPipelineLog;
		},
		get iacDriftReport() {
			return iacDriftReport;
		},
		get iacReconcileChoice() {
			return iacReconcileChoice;
		},
		get iacReconcileResults() {
			return iacReconcileResults;
		},
		get syntheticsDriftReport() {
			return syntheticsDriftReport;
		},
		get syntheticsPushChoice() {
			return syntheticsPushChoice;
		},
		get syntheticsPushResult() {
			return syntheticsPushResult;
		},
		get fleetUpgradePreview() {
			return fleetUpgradePreview;
		},
		get fleetUpgradeChoice() {
			return fleetUpgradeChoice;
		},
		get fleetUpgradeResult() {
			return fleetUpgradeResult;
		},
		sendMessage,
		setFeedback,
		cancelStream,
		executeAction,
		dismissAction,
		loadDataSources,
		stopHealthPolling,
		clearChat,
		endCurrentSession,
		resolveTopicShift,
		resolveHilMatch,
		resolveHilReview,
		switchAgent,
		resolveIacPlanReview,
		submitIacClarify,
		resolveReconcileChoice,
		approveSyntheticsPush,
		approveFleetUpgrade,
	};
}

export const agentStore = createAgentStore();
