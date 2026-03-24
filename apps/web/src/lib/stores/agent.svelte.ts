// apps/web/src/lib/stores/agent.svelte.ts
import type { AttachmentBlock } from "@devops-agent/shared/src/attachments.ts";
import type { DataSourceContext, StreamEvent } from "@devops-agent/shared";

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
	let activeNodes = $state<Set<string>>(new Set());
	let completedNodes = $state<Map<string, { duration: number }>>(new Map());
	let lastSuggestions = $state<string[]>([]);
	let lastResponseTime = $state<number | undefined>(undefined);
	let lastToolsUsed = $state<string[]>([]);
	let lastRunId = $state<string | undefined>(undefined);
	let lastConfidence = $state<number | undefined>(undefined);
	let lastDataSourceContext = $state<DataSourceContext | undefined>(undefined);
	let pendingAttachments = $state<AttachmentBlock[]>([]);
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
			const response = await fetch("/api/agent/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: messages.map((m) => ({ role: m.role, content: m.content })),
					threadId: threadId || undefined,
					dataSources: selectedDataSources,
					...(attachmentsToSend && { attachments: attachmentsToSend }),
					...(followUpContext?.isFollowUp && { isFollowUp: true }),
					...(followUpContext?.dataSourceContext && { dataSourceContext: followUpContext.dataSourceContext }),
				}),
				signal: abortController.signal,
			});

			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					try {
						const event = JSON.parse(line.slice(6)) as StreamEvent;
						handleEvent(event);
					} catch {
						// Skip malformed events
					}
				}
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
		switch (event.type) {
			case "message":
				currentContent += event.content;
				break;
			case "tool_call":
				break;
			case "datasource_progress":
				dataSourceProgress = new Map([
					...dataSourceProgress,
					[event.dataSourceId, { status: event.status, message: event.message }],
				]);
				break;
			case "node_start":
				activeNodes = new Set([...activeNodes, event.nodeId]);
				break;
			case "node_end":
				activeNodes = new Set([...activeNodes].filter((n) => n !== event.nodeId));
				completedNodes = new Map([...completedNodes, [event.nodeId, { duration: event.duration }]]);
				break;
			case "suggestions":
				lastSuggestions = event.suggestions;
				break;
			case "done":
				threadId = event.threadId;
				lastResponseTime = event.responseTime;
				lastToolsUsed = event.toolsUsed ?? [];
				lastRunId = event.runId;
				lastConfidence = event.confidence;
				lastDataSourceContext = event.dataSourceContext;
				break;
			case "error":
				currentContent += `\n\n[Error: ${event.message}]`;
				break;
		}
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
		sendMessage,
		setFeedback,
		cancelStream,
		loadDataSources,
		stopHealthPolling,
		clearChat,
	};
}

export const agentStore = createAgentStore();
