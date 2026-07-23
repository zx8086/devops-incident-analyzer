<script lang="ts">
// apps/web/src/lib/components/ChatMessage.svelte
import type { ActionResult, PendingAction, TicketProviderInfo } from "@devops-agent/shared";
// Deep import, NOT the barrel: a value/type import of the shared index drags
// server-only modules into the client bundle. Type-only, but kept on the deep
// path to match CreateTicketCard's convention.
import type { CreatedTicket } from "@devops-agent/shared/src/ticket-types.ts";
import type { ChatMessage } from "$lib/stores/agent.svelte";
import ActionConfirmationCard from "./ActionConfirmationCard.svelte";
import AddCommentCard from "./AddCommentCard.svelte";
import AtlassianFindingsCard from "./AtlassianFindingsCard.svelte";
import AWSFindingsCard from "./AWSFindingsCard.svelte";
import CompletedProgress from "./CompletedProgress.svelte";
import ConfidenceBadge from "./ConfidenceBadge.svelte";
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
	threadTicket = null,
	canCommentOnThreadTicket = false,
	onTicketCreated,
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
	// SIO-1145: the thread's ticket (if one was created on an earlier answer) and
	// whether THIS answer came after it -- both true => show "Add as comment"
	// instead of "Create ticket". onTicketCreated reports this answer's created
	// ticket up to the store so later answers enter comment-mode.
	threadTicket?: CreatedTicket | null;
	canCommentOnThreadTicket?: boolean;
	onTicketCreated?: (ticket: CreatedTicket) => void;
} = $props();

let showTicketCard = $state(false);
// SIO-1139: created-ticket state lives here (one ChatMessage per answer) so it
// survives the card unmounting. Once set, the answer already has a ticket:
// reopening the card shows the confirmation and the button is disabled.
let createdTicket = $state<CreatedTicket | null>(null);

// SIO-1145: this answer comments on the thread's ticket instead of creating one
// (the thread already has a ticket and this answer came after it). Per-answer
// commentPosted mirrors createdTicket's local, reload-transient pattern so the
// same follow-up can't be posted twice.
let showCommentCard = $state(false);
let commentPosted = $state(false);
const commentMode = $derived(canCommentOnThreadTicket && threadTicket !== null);
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
          <ConfidenceBadge
            confidence={message.confidence}
            confidencePreCap={message.confidencePreCap}
            capReasons={message.capReasons}
            lowConfidence={message.lowConfidence}
          />
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
            onCreateTicket={ticketProviders.length > 0 && !commentMode ? () => (showTicketCard = !showTicketCard) : undefined}
            ticketCreated={!!createdTicket}
            onAddComment={commentMode ? () => (showCommentCard = !showCommentCard) : undefined}
            {commentPosted}
            commentTargetKey={threadTicket?.key}
          />
        {/if}

        {#if !isStreaming && showTicketCard && ticketProviders.length > 0 && !commentMode}
          <CreateTicketCard
            content={message.content}
            requestId={message.requestId}
            providers={ticketProviders}
            {createdTicket}
            onCreated={(ticket) => {
              createdTicket = ticket;
              onTicketCreated?.(ticket);
            }}
            onClose={() => (showTicketCard = false)}
          />
        {/if}

        {#if !isStreaming && showCommentCard && commentMode && threadTicket}
          <AddCommentCard
            ticketKey={threadTicket.key}
            ticketUrl={threadTicket.url}
            content={message.content}
            providerId={ticketProviders[0]?.id ?? "jira"}
            posted={commentPosted}
            onPosted={() => (commentPosted = true)}
            onClose={() => (showCommentCard = false)}
          />
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
