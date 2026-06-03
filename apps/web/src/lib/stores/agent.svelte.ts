// apps/web/src/lib/stores/agent.svelte.ts

import type { ActionResult, DataSourceContext, PendingAction, StreamEvent } from "@devops-agent/shared";
import type { AttachmentBlock } from "@devops-agent/shared/src/attachments.ts";
import {
	applyStreamEvent,
	type DataSourceFindings,
	type IacClarifyPrompt,
	type IacDriftReport,
	type IacPlanReviewPrompt,
	type IacReconcileChoice,
	type IacReconcileResultRow,
	type ReconcileDirection,
	type ReducerState,
	type TopicShiftPrompt,
} from "./agent-reducer.ts";
import { parseSseChunks } from "./sse-buffer.ts";

export type AgentId = "incident-analyzer" | "elastic-iac";

export interface ChatMessage {
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
	confidence?: number;
}

export interface FollowUpContext {
	isFollowUp: boolean;
	dataSourceContext?: DataSourceContext;
}

// SIO-608: Frontend polling interval for health status
const HEALTH_POLL_INTERVAL_MS = 15_000;

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
	let activeNodes = $state<Set<string>>(new Set());
	let completedNodes = $state<Map<string, { duration: number }>>(new Map());
	let lastSuggestions = $state<string[]>([]);
	let lastResponseTime = $state<number | undefined>(undefined);
	let lastToolsUsed = $state<string[]>([]);
	let lastRunId = $state<string | undefined>(undefined);
	let lastConfidence = $state<number | undefined>(undefined);
	let lastDataSourceContext = $state<DataSourceContext | undefined>(undefined);
	let pendingAttachments = $state<AttachmentBlock[]>([]);
	let pendingActions = $state<PendingAction[]>([]);
	let actionResults = $state<ActionResult[]>([]);
	// SIO-751: HITL banner state for cross-turn topic-shift detection.
	let topicShiftPrompt = $state<TopicShiftPrompt | null>(null);
	// Which agent the UI is driving; toggled from the robot icon.
	let currentAgent = $state<AgentId>("incident-analyzer");
	// elastic-iac HITL banners.
	let iacClarify = $state<IacClarifyPrompt | null>(null);
	let iacPlanReview = $state<IacPlanReviewPrompt | null>(null);
	let iacPipelineProgress = $state<string[]>([]);
	// SIO-882: drift sub-flow UI state.
	let iacDriftReport = $state<IacDriftReport | null>(null);
	let iacReconcileChoice = $state<IacReconcileChoice | null>(null);
	let iacReconcileResults = $state<IacReconcileResultRow[]>([]);
	let abortController: AbortController | null = null;
	let healthPollTimer: ReturnType<typeof setInterval> | null = null;

	async function sendMessage(content: string, followUpContext?: FollowUpContext) {
		if (isStreaming || !content.trim()) return;

		// SIO-610: Capture attachments before clearing
		const attachmentsToSend = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
		pendingAttachments = [];

		messages = [...messages, { role: "user", content }];
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
		iacPipelineProgress = [];
		// SIO-882: a new message starts a fresh drift pass (the prompt/report persist
		// across interrupt pauses, so they're cleared here, not in the stream's finally).
		iacDriftReport = null;
		iacReconcileChoice = null;
		iacReconcileResults = [];

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
			}
		} finally {
			abortController = null;
			if (currentContent) {
				messages = [
					...messages,
					{
						role: "assistant",
						content: currentContent,
						suggestions: [...lastSuggestions],
						responseTime: lastResponseTime,
						toolsUsed: [...lastToolsUsed],
						completedNodes: new Map(completedNodes),
						dataSourceResults: new Map(dataSourceProgress),
						dataSourceFindings: new Map(dataSourceFindings),
						feedback: null,
						runId: lastRunId,
						confidence: lastConfidence,
					},
				];
				currentContent = "";
			}
			isStreaming = false;
			activeNodes = new Set();
			completedNodes = new Map();
			lastSuggestions = [];
			dataSourceProgress = new Map();
			dataSourceFindings = new Map();
			iacPipelineProgress = [];
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
			lastConfidence,
			lastDataSourceContext,
			pendingActions,
			actionResults,
			topicShiftPrompt,
			iacClarify,
			iacPlanReview,
			iacPipelineProgress,
			iacDriftReport,
			iacReconcileChoice,
			iacReconcileResults,
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
		lastConfidence = next.lastConfidence;
		lastDataSourceContext = next.lastDataSourceContext;
		pendingActions = next.pendingActions;
		actionResults = next.actionResults;
		topicShiftPrompt = next.topicShiftPrompt;
		iacClarify = next.iacClarify;
		iacPlanReview = next.iacPlanReview;
		iacPipelineProgress = next.iacPipelineProgress;
		iacDriftReport = next.iacDriftReport;
		iacReconcileChoice = next.iacReconcileChoice;
		iacReconcileResults = next.iacReconcileResults;
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

	function clearChat() {
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
		iacClarify = null;
		iacPlanReview = null;
		iacPipelineProgress = [];
		iacDriftReport = null;
		iacReconcileChoice = null;
		iacReconcileResults = [];
	}

	// Flip the UI between the incident-analyzer and the elastic-iac agent. Switching
	// starts a fresh conversation (each agent has its own graph + checkpointer).
	function switchAgent(agent: AgentId) {
		if (agent === currentAgent || isStreaming) return;
		currentAgent = agent;
		clearChat();
	}

	// Resume the elastic-iac graph after an interrupt (plan-review decision or a
	// clarification answer), piping the resulting SSE stream back through handleEvent.
	async function resumeIac(
		payload: { decision?: "approved" | "rejected"; answer?: string; direction?: ReconcileDirection },
		threadIdOverride: string,
	) {
		if (isStreaming) return;
		iacPlanReview = null;
		iacClarify = null;
		// SIO-882: dismiss the current per-stack choice; the next chained interrupt (the
		// next drifted stack) repopulates it. The drift report + results persist.
		iacReconcileChoice = null;
		iacPipelineProgress = [];
		isStreaming = true;
		currentContent = "";
		activeNodes = new Set();
		completedNodes = new Map();
		try {
			const response = await fetch("/api/agent/iac/resume", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ threadId: threadIdOverride, ...payload }),
			});
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			for await (const event of parseSseChunks(response.body)) {
				handleEvent(event);
			}
		} catch (error) {
			currentContent += `\n\n[Error resuming IaC agent: ${error instanceof Error ? error.message : String(error)}]`;
		} finally {
			if (currentContent) {
				messages = [
					...messages,
					{ role: "assistant", content: currentContent, completedNodes: new Map(completedNodes), feedback: null },
				];
				currentContent = "";
			}
			isStreaming = false;
			activeNodes = new Set();
			completedNodes = new Map();
			// SIO-876: the final status+plan+approval now lives in the message; clear the
			// live ticker so it doesn't linger.
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
		} finally {
			if (currentContent) {
				messages = [
					...messages,
					{
						role: "assistant",
						content: currentContent,
						suggestions: [...lastSuggestions],
						responseTime: lastResponseTime,
						toolsUsed: [...lastToolsUsed],
						completedNodes: new Map(completedNodes),
						dataSourceResults: new Map(dataSourceProgress),
						dataSourceFindings: new Map(dataSourceFindings),
						feedback: null,
						runId: lastRunId,
						confidence: lastConfidence,
					},
				];
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
		get iacDriftReport() {
			return iacDriftReport;
		},
		get iacReconcileChoice() {
			return iacReconcileChoice;
		},
		get iacReconcileResults() {
			return iacReconcileResults;
		},
		sendMessage,
		setFeedback,
		cancelStream,
		executeAction,
		dismissAction,
		loadDataSources,
		stopHealthPolling,
		clearChat,
		resolveTopicShift,
		switchAgent,
		resolveIacPlanReview,
		submitIacClarify,
		resolveReconcileChoice,
	};
}

export const agentStore = createAgentStore();
