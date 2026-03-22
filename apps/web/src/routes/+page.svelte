<script lang="ts">
import { onMount } from "svelte";
import ChatInput from "$lib/components/ChatInput.svelte";
import ChatMessage from "$lib/components/ChatMessage.svelte";
import DataSourceSelector from "$lib/components/DataSourceSelector.svelte";
import Icon from "$lib/components/Icon.svelte";
import StreamingProgress from "$lib/components/StreamingProgress.svelte";
import { agentStore } from "$lib/stores/agent.svelte";

let messagesContainer: HTMLDivElement;
let availableDataSources = $state<string[]>([]);

onMount(async () => {
	await agentStore.loadDataSources();
	try {
		const res = await fetch("/api/datasources");
		const data = await res.json();
		availableDataSources = data.dataSources ?? [];
	} catch {
		availableDataSources = [];
	}
});

$effect(() => {
	if (agentStore.messages.length > 0 || agentStore.currentContent) {
		messagesContainer?.scrollTo({ top: messagesContainer.scrollHeight, behavior: "smooth" });
	}
});

function handleSend(content: string) {
	agentStore.sendMessage(content);
}

function handleSuggestionClick(suggestion: string) {
	agentStore.sendMessage(suggestion);
}
</script>

<div class="flex flex-col h-screen bg-white">
  <!-- Header -->
  <header class="bg-tommy-navy text-white px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-full bg-tommy-accent-blue/20 flex items-center justify-center">
        <Icon name="bot" size={18} />
      </div>
      <div>
        <h1 class="text-sm font-semibold">Incident Analyzer</h1>
        <p class="text-xs text-gray-300">DevOps Incident Analysis Assistant</p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse-dot"></span>
        <span class="text-xs text-gray-300">Connected</span>
      </div>
      {#if agentStore.messages.length > 0}
        <button onclick={() => agentStore.clearChat()} class="text-xs text-gray-400 hover:text-tommy-red transition-colors">
          <Icon name="clear" size={16} />
        </button>
      {/if}
    </div>
  </header>

  <!-- DataSource Selector -->
  <DataSourceSelector dataSources={availableDataSources} bind:selected={agentStore.selectedDataSources} />

  <!-- Messages -->
  <div bind:this={messagesContainer} class="flex-1 overflow-y-auto px-4 py-6">
    {#if agentStore.messages.length === 0 && !agentStore.isStreaming}
      <div class="flex flex-col items-center justify-center h-full text-center text-gray-400 animate-fade-slide-up">
        <div class="w-16 h-16 rounded-full bg-tommy-cream flex items-center justify-center mb-4">
          <Icon name="bot" size={32} />
        </div>
        <h2 class="text-lg font-medium text-gray-600 mb-2">How can I help?</h2>
        <p class="text-sm max-w-md">
          I can analyze incidents across Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect.
          Describe an incident or ask about service health.
        </p>
      </div>
    {:else}
      <div class="max-w-4xl mx-auto">
        {#each agentStore.messages as message, i}
          <ChatMessage
            {message}
            index={i}
            isLast={i === agentStore.messages.length - 1}
            isStreaming={false}
            onSuggestionClick={handleSuggestionClick}
            onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
          />
        {/each}

        {#if agentStore.isStreaming && agentStore.currentContent}
          <ChatMessage
            message={{ role: "assistant", content: agentStore.currentContent }}
            index={agentStore.messages.length}
            isLast={true}
            isStreaming={true}
          />
        {/if}

        {#if agentStore.isStreaming && !agentStore.currentContent}
          <div class="flex gap-3 mb-4">
            <div class="flex-shrink-0 w-8 h-8 rounded-full bg-tommy-cream flex items-center justify-center">
              <Icon name="bot" size={16} />
            </div>
            <div class="flex items-center gap-1 py-3">
              <span class="w-2 h-2 rounded-full bg-tommy-accent-blue animate-pulse-dot"></span>
              <span class="w-2 h-2 rounded-full bg-tommy-accent-blue animate-pulse-dot animation-delay-150"></span>
              <span class="w-2 h-2 rounded-full bg-tommy-accent-blue animate-pulse-dot animation-delay-300"></span>
            </div>
          </div>
        {/if}

        <StreamingProgress activeNodes={agentStore.activeNodes} completedNodes={agentStore.completedNodes} />
      </div>
    {/if}
  </div>

  <!-- Input -->
  <ChatInput onSend={handleSend} isStreaming={agentStore.isStreaming} onStop={() => agentStore.cancelStream()} />
</div>
