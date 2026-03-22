<script lang="ts">
import type { ChatMessage } from "$lib/stores/agent.svelte";
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
}: {
	message: ChatMessage;
	index: number;
	isLast?: boolean;
	isStreaming?: boolean;
	onSuggestionClick?: (s: string) => void;
	onFeedback?: (index: number, score: "up" | "down") => void;
} = $props();
</script>

{#if message.role === "user"}
  <div class="flex justify-end mb-4 animate-fade-in">
    <div class="max-w-2xl rounded-2xl rounded-br-md bg-tommy-navy px-4 py-3 text-white text-sm">
      {message.content}
    </div>
  </div>
{:else}
  <div class="flex gap-3 mb-4 animate-fade-in">
    <div class="flex-shrink-0 w-8 h-8 rounded-full bg-tommy-cream flex items-center justify-center">
      <Icon name="bot" size={16} />
    </div>
    <div class="flex-1 min-w-0">
      <div class="text-sm">
        <MarkdownRenderer content={message.content} />
        {#if isStreaming && isLast}
          <span class="inline-block w-2 h-4 bg-tommy-accent-blue animate-pulse-dot ml-0.5"></span>
        {/if}
      </div>

      {#if !isStreaming && message.completedNodes && message.completedNodes.size > 0}
        <CompletedProgress
          nodes={message.completedNodes}
          dataSourceResults={message.dataSourceResults}
          responseTime={message.responseTime}
          toolsUsed={message.toolsUsed}
        />
      {/if}

      {#if !isStreaming && isLast}
        <FeedbackBar
          feedback={message.feedback}
          content={message.content}
          onFeedback={(score) => onFeedback?.(index, score)}
        />
      {/if}

      {#if !isStreaming && message.suggestions && message.suggestions.length > 0}
        <FollowUpSuggestions
          suggestions={message.suggestions}
          onSelect={(s) => onSuggestionClick?.(s)}
        />
      {/if}
    </div>
  </div>
{/if}
