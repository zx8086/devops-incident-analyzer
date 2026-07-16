<script lang="ts">
// apps/web/src/lib/components/ChatMessage.svelte
import type { ActionResult, PendingAction, TicketProviderInfo } from "@devops-agent/shared";
import type { ChatMessage } from "$lib/stores/agent.svelte";
import ActionConfirmationCard from "./ActionConfirmationCard.svelte";
import AtlassianFindingsCard from "./AtlassianFindingsCard.svelte";
import AWSFindingsCard from "./AWSFindingsCard.svelte";
import CompletedProgress from "./CompletedProgress.svelte";
import CouchbaseFindingsCard from "./CouchbaseFindingsCard.svelte";
import CreateTicketCard from "./CreateTicketCard.svelte";
import ElasticFindingsCard from "./ElasticFindingsCard.svelte";
import FeedbackBar from "./FeedbackBar.svelte";
import FollowUpSuggestions from "./FollowUpSuggestions.svelte";
import GitLabFindingsCard from "./GitLabFindingsCard.svelte";
import Icon from "./Icon.svelte";
import KafkaFindingsCard from "./KafkaFindingsCard.svelte";
import MarkdownRenderer from "./MarkdownRenderer.svelte";

let {
	message,
	index,
	isLast = false,
	isStreaming = false,
	onSuggestionClick,
	onFeedback,
	pendingActions = [],
	actionResults = [],
	onActionApprove,
	onActionDismiss,
	ticketProviders = [],
}: {
	message: ChatMessage;
	index: number;
	isLast?: boolean;
	isStreaming?: boolean;
	onSuggestionClick?: (s: string) => void;
	onFeedback?: (index: number, score: "up" | "down") => void;
	pendingActions?: PendingAction[];
	actionResults?: ActionResult[];
	onActionApprove?: (action: PendingAction) => void;
	onActionDismiss?: (actionId: string) => void;
	ticketProviders?: TicketProviderInfo[];
} = $props();

let showTicketCard = $state(false);
</script>

{#if message.role === "user"}
  <div class="animate-slide-up-fade py-2 px-4">
    <div class="flex justify-end">
      <div class="max-w-[85%] bg-tommy-navy text-white rounded-lg px-3 py-2">
        <p class="text-sm whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    </div>
  </div>
{:else}
  <div class="animate-slide-up-fade py-2 px-4">
    <div class="flex gap-3 items-start">
      <div class="w-7 h-7 bg-tommy-offwhite rounded-full flex items-center justify-center shrink-0 mt-0.5">
        <Icon name="bot" class="w-3.5 h-3.5 text-tommy-navy" />
      </div>
      <div class="max-w-[85%]">
        <div class="bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
          {#if message.content}
            <MarkdownRenderer content={message.content} />
            {#if isStreaming && isLast}
              <span class="inline-block w-2 h-4 bg-[#02154E] animate-pulse ml-0.5 align-middle"></span>
            {/if}
          {/if}
        </div>

        {#if !isStreaming && message.dataSourceFindings}
          {@const kafkaFindings = message.dataSourceFindings.get("kafka")?.kafkaFindings}
          {@const couchbaseFindings = message.dataSourceFindings.get("couchbase")?.couchbaseFindings}
          {@const gitlabFindings = message.dataSourceFindings.get("gitlab")?.gitlabFindings}
          {@const elasticFindings = message.dataSourceFindings.get("elastic")?.elasticFindings}
          {@const awsFindings = message.dataSourceFindings.get("aws")?.awsFindings}
          {@const atlassianFindings = message.dataSourceFindings.get("atlassian")?.atlassianFindings}
          {#if kafkaFindings}
            <div class="mt-2">
              <KafkaFindingsCard findings={kafkaFindings} />
            </div>
          {/if}
          {#if couchbaseFindings}
            <div class="mt-2">
              <CouchbaseFindingsCard findings={couchbaseFindings} />
            </div>
          {/if}
          {#if gitlabFindings}
            <div class="mt-2">
              <GitLabFindingsCard findings={gitlabFindings} />
            </div>
          {/if}
          {#if elasticFindings}
            <div class="mt-2">
              <ElasticFindingsCard findings={elasticFindings} />
            </div>
          {/if}
          {#if awsFindings}
            <div class="mt-2">
              <AWSFindingsCard findings={awsFindings} />
            </div>
          {/if}
          {#if atlassianFindings}
            <div class="mt-2">
              <AtlassianFindingsCard findings={atlassianFindings} />
            </div>
          {/if}
        {/if}

        {#if !isStreaming}
          <CompletedProgress
            responseTime={message.responseTime}
            toolsUsed={message.toolsUsed}
            completedNodes={message.completedNodes}
            dataSourceResults={message.dataSourceResults}
            dataSourceFindings={message.dataSourceFindings}
            outcome={message.outcome}
          />
        {/if}

        {#if !isStreaming && onFeedback}
          <FeedbackBar
            content={message.content}
            feedback={message.feedback}
            onFeedback={(score) => onFeedback?.(index, score)}
            onCreateTicket={ticketProviders.length > 0 ? () => (showTicketCard = !showTicketCard) : undefined}
          />
        {/if}

        {#if !isStreaming && showTicketCard && ticketProviders.length > 0}
          <CreateTicketCard content={message.content} providers={ticketProviders} onClose={() => (showTicketCard = false)} />
        {/if}

        {#if !isStreaming && isLast && pendingActions.length > 0 && onActionApprove && onActionDismiss}
          {#each pendingActions as action (action.id)}
            <ActionConfirmationCard
              {action}
              onApprove={onActionApprove}
              onDismiss={onActionDismiss}
              result={actionResults.find((r) => r.actionId === action.id)}
            />
          {/each}
        {/if}

        {#if !isStreaming && message.suggestions && message.suggestions.length > 0 && onSuggestionClick}
          <FollowUpSuggestions suggestions={message.suggestions} onSelect={(s) => onSuggestionClick?.(s)} />
        {/if}
      </div>
    </div>
  </div>
{/if}
