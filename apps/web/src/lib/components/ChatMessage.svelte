<script lang="ts">
// apps/web/src/lib/components/ChatMessage.svelte
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import type { ChatMessage } from "$lib/stores/agent.svelte";
import ActionConfirmationCard from "./ActionConfirmationCard.svelte";
import CompletedProgress from "./CompletedProgress.svelte";
import FeedbackBar from "./FeedbackBar.svelte";
import FollowUpSuggestions from "./FollowUpSuggestions.svelte";
import Icon from "./Icon.svelte";
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
} = $props();
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

        {#if !isStreaming && (message.responseTime !== undefined || (message.toolsUsed && message.toolsUsed.length > 0) || (message.dataSourceResults && message.dataSourceResults.size > 0))}
          <CompletedProgress
            responseTime={message.responseTime}
            toolsUsed={message.toolsUsed}
            completedNodes={message.completedNodes}
            dataSourceResults={message.dataSourceResults}
          />
        {/if}

        {#if !isStreaming && onFeedback}
          <FeedbackBar content={message.content} feedback={message.feedback} onFeedback={(score) => onFeedback?.(index, score)} />
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
