<script lang="ts">
// apps/web/src/routes/+page.svelte
import { onDestroy, onMount } from "svelte";
import ChatInput from "$lib/components/ChatInput.svelte";
import ChatMessage from "$lib/components/ChatMessage.svelte";
import DataSourceSelector from "$lib/components/DataSourceSelector.svelte";
import ElasticDeploymentSelector from "$lib/components/ElasticDeploymentSelector.svelte";
import Icon from "$lib/components/Icon.svelte";
import StreamingProgress from "$lib/components/StreamingProgress.svelte";
import { agentStore } from "$lib/stores/agent.svelte";

let messagesContainer: HTMLDivElement;

onMount(async () => {
	await agentStore.loadDataSources();
});

onDestroy(() => {
	agentStore.stopHealthPolling();
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
	agentStore.sendMessage(suggestion, {
		isFollowUp: true,
		dataSourceContext: agentStore.lastDataSourceContext,
	});
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

  <DataSourceSelector dataSources={agentStore.availableDataSources} connected={agentStore.connectedDataSources} bind:selected={agentStore.selectedDataSources} />

  {#if agentStore.selectedDataSources.includes("elastic")}
    <ElasticDeploymentSelector deployments={agentStore.availableElasticDeployments} bind:selected={agentStore.selectedElasticDeployments} />
  {/if}

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
          pendingActions={i === agentStore.messages.length - 1 ? agentStore.pendingActions : []}
          actionResults={i === agentStore.messages.length - 1 ? agentStore.actionResults : []}
          onActionApprove={(action) => agentStore.executeAction(action, msg.content)}
          onActionDismiss={(id) => agentStore.dismissAction(id)}
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

  {#if agentStore.topicShiftPrompt}
    <!-- SIO-751: topic-shift HITL banner. The graph is paused on detectTopicShift
         until the user picks continue or fresh. -->
    <div class="border-t border-amber-300 bg-amber-50 px-4 py-3" role="dialog" aria-labelledby="topic-shift-heading">
      <div class="max-w-4xl mx-auto">
        <h3 id="topic-shift-heading" class="text-sm font-semibold text-amber-900">
          New topic detected
        </h3>
        <p class="text-sm text-amber-800 mt-1">
          {agentStore.topicShiftPrompt.message}
        </p>
        <div class="mt-2 flex flex-wrap gap-2 text-xs text-amber-900">
          <span class="font-semibold">Prior services:</span>
          <span>{agentStore.topicShiftPrompt.oldServices.join(", ") || "(none)"}</span>
          <span class="font-semibold ml-3">New services:</span>
          <span>{agentStore.topicShiftPrompt.newServices.join(", ") || "(none)"}</span>
        </div>
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            onclick={() => agentStore.resolveTopicShift("continue")}
            disabled={agentStore.isStreaming}
            class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Continue prior investigation
          </button>
          <button
            type="button"
            onclick={() => agentStore.resolveTopicShift("fresh")}
            disabled={agentStore.isStreaming}
            class="px-3 py-1.5 text-sm font-medium bg-white text-tommy-navy border border-tommy-navy rounded-md hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="border-t border-gray-200 bg-white">
    <ChatInput
      onSend={handleSend}
      onStop={() => agentStore.cancelStream()}
      isStreaming={agentStore.isStreaming}
      bind:attachments={agentStore.pendingAttachments}
    />
  </div>
</div>
