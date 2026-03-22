<script lang="ts">
// apps/web/src/routes/+page.svelte
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
	agentStore.messages;
	agentStore.currentContent;
	if (messagesContainer) {
		const nearBottom =
			messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 100;
		if (nearBottom) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}
});

function handleSend(content: string) {
	const hasHistory = agentStore.messages.length > 0;
	if (hasHistory) {
		agentStore.sendMessage(content, { isFollowUp: true });
	} else {
		agentStore.sendMessage(content);
	}
}

function handleSuggestionClick(suggestion: string) {
	agentStore.sendMessage(suggestion, { isFollowUp: true });
}
</script>

<div class="min-h-screen bg-tommy-cream flex flex-col">
  <header class="bg-tommy-navy text-white px-6 py-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-7 h-7 bg-tommy-navy rounded-full flex items-center justify-center">
        <Icon name="bot" class="w-4 h-4 text-white" />
      </div>
      <div>
        <h1 class="text-sm font-semibold leading-tight">Incident Analyzer</h1>
        <p class="text-xs text-white/60">DevOps Incident Analysis Assistant</p>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-1.5">
        <div class="w-2 h-2 rounded-full bg-green-500"></div>
        <span class="text-xs text-white/60">Connected</span>
      </div>
      <button
        onclick={() => agentStore.clearChat()}
        class="min-w-[44px] min-h-[44px] p-2 text-red-500 hover:text-white hover:bg-red-500 bg-transparent border-2 border-transparent hover:border-red-500 rounded-lg transition-all disabled:text-gray-300"
      >
        <Icon name="clear" class="w-5 h-5" />
      </button>
    </div>
  </header>

  <DataSourceSelector dataSources={availableDataSources} connected={agentStore.connectedDataSources} bind:selected={agentStore.selectedDataSources} />

  <div bind:this={messagesContainer} class="flex-1 overflow-y-auto bg-white">
    <div class="max-w-4xl mx-auto py-4">
      {#if agentStore.messages.length === 0 && !agentStore.isStreaming}
        <div class="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
          <div class="w-16 h-16 bg-tommy-offwhite rounded-2xl flex items-center justify-center mb-4">
            <Icon name="bot" class="w-8 h-8 text-tommy-navy" />
          </div>
          <h2 class="text-lg font-semibold text-tommy-navy mb-1">How can I help?</h2>
          <p class="text-sm text-gray-500 max-w-md">
            I can analyze incidents across Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect.
            Describe an incident or ask about service health.
          </p>
        </div>
      {/if}

      {#each agentStore.messages as msg, i}
        <ChatMessage
          message={msg}
          index={i}
          isLast={i === agentStore.messages.length - 1}
          isStreaming={false}
          onSuggestionClick={handleSuggestionClick}
          onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
        />
      {/each}

      {#if agentStore.isStreaming}
        {#if agentStore.activeNodes.size > 0 || agentStore.completedNodes.size > 0}
          <div class="px-4">
            <StreamingProgress activeNodes={agentStore.activeNodes} completedNodes={agentStore.completedNodes} />
          </div>
        {/if}

        {#if agentStore.currentContent}
          <ChatMessage
            message={{ role: "assistant", content: agentStore.currentContent }}
            index={agentStore.messages.length}
            isLast={true}
            isStreaming={true}
          />
        {:else}
          <div class="py-2 px-4">
            <div class="flex gap-3 items-start">
              <div class="w-7 h-7 bg-tommy-offwhite rounded-full flex items-center justify-center shrink-0">
                <Icon name="bot" class="w-3.5 h-3.5 text-tommy-navy" />
              </div>
              <div class="bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
                <div class="flex space-x-1">
                  <div class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-dot"></div>
                  <div class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-dot" style="animation-delay: 0.2s"></div>
                  <div class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-dot" style="animation-delay: 0.4s"></div>
                </div>
              </div>
            </div>
          </div>
        {/if}
      {/if}

    </div>
  </div>

  <ChatInput onSend={handleSend} onStop={() => agentStore.cancelStream()} isStreaming={agentStore.isStreaming} />
</div>
