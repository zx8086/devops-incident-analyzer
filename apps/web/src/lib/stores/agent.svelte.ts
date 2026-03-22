// apps/web/src/lib/stores/agent.svelte.ts
import type { StreamEvent } from "@devops-agent/shared";

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

function createAgentStore() {
  let messages = $state<ChatMessage[]>([]);
  let dataSourceProgress = $state<Map<string, { status: string; message?: string }>>(new Map());
  let isStreaming = $state(false);
  let threadId = $state<string>("");
  let currentContent = $state("");
  let selectedDataSources = $state<string[]>([]);
  let activeNodes = $state<Set<string>>(new Set());
  let completedNodes = $state<Map<string, { duration: number }>>(new Map());
  let abortController: AbortController | null = null;

  async function sendMessage(content: string) {
    messages.push({ role: "user", content });
    isStreaming = true;
    currentContent = "";
    activeNodes = new Set();
    completedNodes = new Map();
    dataSourceProgress = new Map();

    abortController = new AbortController();

    try {
      const response = await fetch("/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          threadId: threadId || undefined,
          dataSources: selectedDataSources.length > 0 ? selectedDataSources : undefined,
          isFollowUp: messages.length > 2,
        }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream failed: ${response.status}`);
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
      if (error instanceof DOMException && error.name === "AbortError") return;
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      currentContent += `\n\nError: ${errMsg}`;
    } finally {
      if (currentContent) {
        messages.push({
          role: "assistant",
          content: currentContent,
          completedNodes: new Map(completedNodes),
          dataSourceResults: new Map(dataSourceProgress),
        });
      }
      isStreaming = false;
      currentContent = "";
      abortController = null;
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
        dataSourceProgress.set(event.dataSourceId, { status: event.status, message: event.message });
        dataSourceProgress = new Map(dataSourceProgress);
        break;
      case "node_start":
        activeNodes.add(event.nodeId);
        activeNodes = new Set(activeNodes);
        break;
      case "node_end":
        activeNodes.delete(event.nodeId);
        activeNodes = new Set(activeNodes);
        completedNodes.set(event.nodeId, { duration: event.duration });
        completedNodes = new Map(completedNodes);
        break;
      case "suggestions":
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last) last.suggestions = event.suggestions;
        }
        break;
      case "done":
        threadId = event.threadId;
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last) {
            last.runId = event.runId;
            last.confidence = event.confidence;
            last.responseTime = event.responseTime;
            last.toolsUsed = event.toolsUsed;
          }
        }
        break;
      case "error":
        currentContent += `\n\nError: ${event.message}`;
        break;
    }
  }

  async function setFeedback(messageIndex: number, score: "up" | "down") {
    const msg = messages[messageIndex];
    if (!msg?.runId) return;
    msg.feedback = score;
    await fetch("/api/agent/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: msg.runId, score: score === "up" ? 1 : 0 }),
    });
  }

  function cancelStream() {
    abortController?.abort();
  }

  async function loadDataSources() {
    try {
      const res = await fetch("/api/datasources");
      const data = await res.json();
      selectedDataSources = data.dataSources ?? [];
    } catch {
      selectedDataSources = [];
    }
  }

  function clearChat() {
    messages = [];
    threadId = "";
    currentContent = "";
    dataSourceProgress = new Map();
    activeNodes = new Set();
    completedNodes = new Map();
  }

  return {
    get messages() { return messages; },
    get dataSourceProgress() { return dataSourceProgress; },
    get isStreaming() { return isStreaming; },
    get threadId() { return threadId; },
    get currentContent() { return currentContent; },
    get selectedDataSources() { return selectedDataSources; },
    set selectedDataSources(v: string[]) { selectedDataSources = v; },
    get activeNodes() { return activeNodes; },
    get completedNodes() { return completedNodes; },
    sendMessage,
    setFeedback,
    cancelStream,
    loadDataSources,
    clearChat,
  };
}

export const agentStore = createAgentStore();
