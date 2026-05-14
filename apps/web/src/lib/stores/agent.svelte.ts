// apps/web/src/lib/stores/agent.svelte.ts

import type { ActionResult, DataSourceContext, PendingAction, StreamEvent } from "@devops-agent/shared";
import type { AttachmentBlock } from "@devops-agent/shared/src/attachments.ts";
import { applyStreamEvent, type ReducerState, type TopicShiftPrompt } from "./agent-reducer.ts";
import { parseSseChunks } from "./sse-buffer.ts";

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	suggestions?: string[];
	responseTime?: number;
	toolsUsed?: string[];
	completedNodes?: Map<string, { duration: number }>;
	dataSourceResults?: Map<string, { status: string; message?: string }>;
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

function createAgentStore() {
	let messages = $state<ChatMessage[]>([]);
	let dataSourceProgress = $state<Map<string, { status: string; message?: string }>>(new Map());
	let isStreaming = $state(false);
	let threadId = $state<string>("");
	let currentContent = $state("");
	let selectedDataSources = $state<string[]>([]);
	let connectedDataSources = $state<string[]>([]);
	let availableDataSources = $state<string[]>([]);
	// SIO-649: Available is populated from GET /api/deployments on mount; selected defaults to all.
	let availableElasticDeployments = $state<string[]>([]);
	let selectedElasticDeployments = $state<string[]>([]);
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
		activeNodes = new Set();
		completedNodes = new Map();
		lastSuggestions = [];
		lastResponseTime = undefined;
		lastToolsUsed = [];
		lastRunId = undefined;
		lastConfidence = undefined;

		abortController = new AbortController();

		try {
			// SIO-649: Only send targetDeployments when Elastic is actually in scope. Empty array is
			// valid (means "use default deployment") and distinct from undefined (multi-deployment off).
			const includeDeployments = selectedDataSources.includes("elastic") && availableElasticDeployments.length > 0;
			const response = await fetch("/api/agent/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: messages.map((m) => ({ role: m.role, content: m.content })),
					threadId: threadId || undefined,
					dataSources: selectedDataSources,
					...(includeDeployments && { targetDeployments: selectedElasticDeployments }),
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
		}
	}

	function handleEvent(event: StreamEvent) {
		const snapshot: ReducerState = {
			currentContent,
			threadId,
			activeNodes,
			completedNodes,
			dataSourceProgress,
			lastSuggestions,
			lastResponseTime,
			lastToolsUsed,
			lastRunId,
			lastConfidence,
			lastDataSourceContext,
			pendingActions,
			actionResults,
			topicShiftPrompt,
		};
		const next = applyStreamEvent(snapshot, event);
		currentContent = next.currentContent;
		threadId = next.threadId;
		activeNodes = next.activeNodes;
		completedNodes = next.completedNodes;
		dataSourceProgress = next.dataSourceProgress;
		lastSuggestions = next.lastSuggestions;
		lastResponseTime = next.lastResponseTime;
		lastToolsUsed = next.lastToolsUsed;
		lastRunId = next.lastRunId;
		lastConfidence = next.lastConfidence;
		lastDataSourceContext = next.lastDataSourceContext;
		pendingActions = next.pendingActions;
		actionResults = next.actionResults;
		topicShiftPrompt = next.topicShiftPrompt;
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
			selectedDataSources = connectedDataSources.length > 0 ? [...connectedDataSources] : [...availableDataSources];
		} catch {
			availableDataSources = [];
			selectedDataSources = [];
			connectedDataSources = [];
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
		startHealthPolling();
	}

	// SIO-608: Periodic health polling to keep pill status in sync
	function startHealthPolling(): void {
		if (healthPollTimer) return;
		healthPollTimer = setInterval(async () => {
			try {
				const res = await fetch("/api/datasources");
				const data: { dataSources: string[]; connected: string[] } = await res.json();
				const newConnected = data.connected ?? [];
				const prevConnected = connectedDataSources;

				connectedDataSources = newConnected;

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
		activeNodes = new Set();
		completedNodes = new Map();
		lastSuggestions = [];
		lastDataSourceContext = undefined;
		pendingAttachments = [];
		pendingActions = [];
		actionResults = [];
		topicShiftPrompt = null;
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
		get availableElasticDeployments() {
			return availableElasticDeployments;
		},
		get selectedElasticDeployments() {
			return selectedElasticDeployments;
		},
		set selectedElasticDeployments(v: string[]) {
			selectedElasticDeployments = v;
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
		sendMessage,
		setFeedback,
		cancelStream,
		executeAction,
		dismissAction,
		loadDataSources,
		stopHealthPolling,
		clearChat,
		resolveTopicShift,
	};
}

export const agentStore = createAgentStore();
