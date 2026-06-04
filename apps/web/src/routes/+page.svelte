<script lang="ts">
// apps/web/src/routes/+page.svelte
import { onDestroy, onMount } from "svelte";
import AwsEstateSelector from "$lib/components/AwsEstateSelector.svelte";
import ChatInput from "$lib/components/ChatInput.svelte";
import ChatMessage from "$lib/components/ChatMessage.svelte";
import DataSourceSelector from "$lib/components/DataSourceSelector.svelte";
import DriftReportCard from "$lib/components/DriftReportCard.svelte";
import ElasticDeploymentSelector from "$lib/components/ElasticDeploymentSelector.svelte";
import Icon from "$lib/components/Icon.svelte";
import PlanReviewCard from "$lib/components/PlanReviewCard.svelte";
import ReconcileChoiceCard from "$lib/components/ReconcileChoiceCard.svelte";
import StreamingProgress from "$lib/components/StreamingProgress.svelte";
import SyntheticsDriftCard from "$lib/components/SyntheticsDriftCard.svelte";
import SyntheticsPushChoiceCard from "$lib/components/SyntheticsPushChoiceCard.svelte";
import { agentStore } from "$lib/stores/agent.svelte";

let messagesContainer: HTMLDivElement;
let clarifyAnswer = $state("");

const isIac = $derived(agentStore.currentAgent === "elastic-iac");
const agentTitle = $derived(isIac ? "Elastic IaC Agent" : "Incident Analyzer");
const agentSubtitle = $derived(isIac ? "Elastic Cloud IaC change assistant" : "DevOps Incident Analysis Assistant");

// SIO-901: when a drift report is showing and the run has finished, the trailing assistant message
// is the "Drift reconcile summary" (MR links). Render it BELOW the drift card (the consolidation
// block) instead of above it, so the conversation reads drift detail -> MR outcomes top-to-bottom.
// Match only the terminal drift-summary text from teardownIac/formatDriftSummary (agent nodes.ts)
// so an unrelated assistant reply in a later turn is never relocated. -1 = nothing to relocate.
const driftSummaryIndex = $derived.by(() => {
	if (!(isIac && agentStore.iacDriftReport && !agentStore.isStreaming && agentStore.messages.length > 0)) return -1;
	const idx = agentStore.messages.length - 1;
	const last = agentStore.messages[idx];
	if (last?.role !== "assistant") return -1;
	const text = last.content.trimStart();
	const isDriftSummary =
		text.startsWith("Drift reconcile summary for ") ||
		text.startsWith("No drift detected for ") ||
		text.startsWith("Drift-check could not run for ");
	return isDriftSummary ? idx : -1;
});

// SIO-902: same relocation for the synthetics flow -- render the terminal synthetics summary
// (from formatSyntheticsSummary) BELOW the synthetics card so the order reads detail -> outcome.
const syntheticsSummaryIndex = $derived.by(() => {
	if (!(isIac && agentStore.syntheticsDriftReport && !agentStore.isStreaming && agentStore.messages.length > 0))
		return -1;
	const idx = agentStore.messages.length - 1;
	const last = agentStore.messages[idx];
	if (last?.role !== "assistant") return -1;
	const text = last.content.trimStart();
	const isSyntheticsSummary =
		text.startsWith("No synthetics drift for ") ||
		text.startsWith("Pushed ") ||
		text.startsWith("Push declined.") ||
		text.startsWith("Synthetics push ") ||
		text.startsWith("Synthetics drift-check for ") ||
		text.startsWith("Nothing to push ") ||
		text.startsWith("Changed (") ||
		text.startsWith("Missing in Kibana (") ||
		text.startsWith("Extra in Kibana (");
	return isSyntheticsSummary ? idx : -1;
});

function toggleAgent() {
	agentStore.switchAgent(isIac ? "incident-analyzer" : "elastic-iac");
}

function submitClarify() {
	const answer = clarifyAnswer.trim();
	if (!answer) return;
	clarifyAnswer = "";
	agentStore.submitIacClarify(answer);
}

onMount(() => {
	let es: EventSource | undefined;
	(async () => {
		await agentStore.loadDataSources();
		es = new EventSource("/api/events");
		es.addEventListener("mcp_replaced", (e) => {
			console.log("[mcp_replaced]", JSON.parse((e as MessageEvent).data));
		});
	})();
	return () => es?.close();
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
      <button
        type="button"
        onclick={toggleAgent}
        disabled={agentStore.isStreaming}
        title="Switch agent"
        aria-label="Switch agent"
        class="w-7 h-7 rounded-full flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed {isIac ? 'bg-tommy-accent-blue ring-2 ring-white/70' : 'bg-tommy-navy hover:bg-tommy-accent-blue'}"
      >
        <Icon name="bot" class="w-4 h-4 text-white" />
      </button>
      <div>
        <h1 class="text-sm font-semibold leading-tight">{agentTitle}</h1>
        <p class="text-xs text-white/60">{agentSubtitle}</p>
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

  {#if isIac}
    <div class="bg-blue-50 border-b border-tommy-accent-blue/30 px-6 py-2 text-xs text-tommy-navy/80">
      Elastic Cloud IaC maker. I read live state, propose a config change, and open a GitLab MR for your review. CI computes the plan on the MR; I never merge or apply.
    </div>
  {:else}
    <DataSourceSelector dataSources={agentStore.availableDataSources} connected={agentStore.connectedDataSources} states={agentStore.stateDataSources} bind:selected={agentStore.selectedDataSources} />

    {#if agentStore.selectedDataSources.includes("elastic")}
      <ElasticDeploymentSelector deployments={agentStore.availableElasticDeployments} bind:selected={agentStore.selectedElasticDeployments} />
    {/if}

    {#if agentStore.selectedDataSources.includes("aws")}
      <AwsEstateSelector estates={agentStore.availableAwsEstates} bind:selected={agentStore.selectedAwsEstates} />
    {/if}
  {/if}

  <div bind:this={messagesContainer} class="flex-1 overflow-y-auto bg-white">
    <div class="max-w-4xl mx-auto py-4">
      {#if agentStore.messages.length === 0 && !agentStore.isStreaming}
        <div class="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
          <div class="w-16 h-16 bg-tommy-offwhite rounded-2xl flex items-center justify-center mb-4">
            <Icon name="bot" class="w-8 h-8 text-tommy-navy" />
          </div>
          <h2 class="text-lg font-semibold text-tommy-navy mb-1">How can I help?</h2>
          {#if isIac}
            <p class="text-sm text-gray-500 max-w-md">
              Describe an Elastic Cloud change in plain English (e.g. "upgrade ap-cld to 9.4.2").
              I edit the config, open a GitLab MR for your review, and CI computes the plan on the MR.
            </p>
          {:else}
            <p class="text-sm text-gray-500 max-w-md">
              I can analyze incidents across Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect.
              Describe an incident or ask about service health.
            </p>
          {/if}
        </div>
      {/if}

      {#each agentStore.messages as msg, i}
        <!-- SIO-901: skip the trailing drift summary here; it is re-rendered below the drift card. -->
        {#if i !== driftSummaryIndex}
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
        {/if}
      {/each}

      {#if agentStore.isStreaming}
        {#if agentStore.activeNodes.size > 0 || agentStore.completedNodes.size > 0}
          <div class="px-4">
            <StreamingProgress variant={isIac ? "iac" : "incident"} activeNodes={agentStore.activeNodes} completedNodes={agentStore.completedNodes} />
          </div>
        {/if}

        {#if agentStore.iacPipelineProgress.length > 0}
          <div class="px-4 py-1 max-w-4xl mx-auto">
            <ul class="text-xs text-tommy-navy/80 font-mono space-y-0.5">
              {#each agentStore.iacPipelineProgress as line}
                <li class="flex items-center gap-1.5">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-tommy-accent-blue animate-pulse"></span>
                  {line}
                </li>
              {/each}
            </ul>
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

      <!-- SIO-882: drift overview. Persists across the interrupt pauses (outside the isStreaming
           gate) so it stays visible while the user works through the per-stack choices.
           SIO-901: the reconcile summary (MR links) now renders as a block BELOW this card. -->
      {#if agentStore.iacDriftReport}
        <DriftReportCard
          report={agentStore.iacDriftReport}
          recheckDisabled={agentStore.isStreaming}
          onRecheck={() => agentStore.sendMessage(`check ${agentStore.iacDriftReport?.deployment} for drift`)}
        />
        <!-- SIO-901: the trailing "Drift reconcile summary" message, relocated under the card. -->
        {#if driftSummaryIndex >= 0}
          {@const summaryMsg = agentStore.messages[driftSummaryIndex]}
          {#if summaryMsg}
            <ChatMessage
              message={summaryMsg}
              index={driftSummaryIndex}
              isLast={true}
              isStreaming={false}
              onSuggestionClick={handleSuggestionClick}
              onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
              pendingActions={agentStore.pendingActions}
              actionResults={agentStore.actionResults}
              onActionApprove={(action) => agentStore.executeAction(action, summaryMsg.content)}
              onActionDismiss={(id) => agentStore.dismissAction(id)}
            />
          {/if}
        {/if}
      {/if}

      <!-- SIO-902: synthetics drift card (whole-deployment monitor diff). The push outcome,
           once available, renders inline; the terminal summary relocates below the card. -->
      {#if agentStore.syntheticsDriftReport}
        <SyntheticsDriftCard
          report={agentStore.syntheticsDriftReport}
          result={agentStore.syntheticsPushResult}
          recheckDisabled={agentStore.isStreaming}
          onRecheck={() =>
            agentStore.sendMessage(`check synthetics drift for ${agentStore.syntheticsDriftReport?.deployment}`)}
        />
        {#if syntheticsSummaryIndex >= 0}
          {@const synthSummaryMsg = agentStore.messages[syntheticsSummaryIndex]}
          {#if synthSummaryMsg}
            <ChatMessage
              message={synthSummaryMsg}
              index={syntheticsSummaryIndex}
              isLast={true}
              isStreaming={false}
              onSuggestionClick={handleSuggestionClick}
              onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
              pendingActions={agentStore.pendingActions}
              actionResults={agentStore.actionResults}
              onActionApprove={(action) => agentStore.executeAction(action, synthSummaryMsg.content)}
              onActionDismiss={(id) => agentStore.dismissAction(id)}
            />
          {/if}
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

  {#if agentStore.iacClarify}
    <!-- elastic-iac clarify gate: the planner needs one direct answer to proceed. -->
    <div class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3" role="dialog" aria-labelledby="iac-clarify-heading">
      <div class="max-w-4xl mx-auto">
        <h3 id="iac-clarify-heading" class="text-sm font-semibold text-tommy-navy">One quick question</h3>
        <p class="text-sm text-tommy-navy/80 mt-1">{agentStore.iacClarify.question}</p>
        <form class="mt-2 flex gap-2" onsubmit={(e) => { e.preventDefault(); submitClarify(); }}>
          <input
            type="text"
            bind:value={clarifyAnswer}
            disabled={agentStore.isStreaming}
            placeholder="Your answer"
            class="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-tommy-accent-blue disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={agentStore.isStreaming || !clarifyAnswer.trim()}
            class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  {/if}

  {#if agentStore.iacPlanReview}
    <PlanReviewCard
      prompt={agentStore.iacPlanReview}
      disabled={agentStore.isStreaming}
      onApprove={() => agentStore.resolveIacPlanReview("approved")}
      onReject={() => agentStore.resolveIacPlanReview("rejected")}
    />
  {/if}

  {#if agentStore.iacReconcileChoice}
    <!-- SIO-882: per-stack reconcile gate (sequential; one stack at a time). -->
    <ReconcileChoiceCard
      prompt={agentStore.iacReconcileChoice}
      disabled={agentStore.isStreaming}
      onChoose={(d) => agentStore.resolveReconcileChoice(d)}
    />
  {/if}

  {#if agentStore.syntheticsPushChoice}
    <!-- SIO-902: single synthetics push approve/decline gate. -->
    <SyntheticsPushChoiceCard
      prompt={agentStore.syntheticsPushChoice}
      disabled={agentStore.isStreaming}
      onApprove={() => agentStore.approveSyntheticsPush(true)}
      onDecline={() => agentStore.approveSyntheticsPush(false)}
    />
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
