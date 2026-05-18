<script lang="ts">
// apps/web/src/lib/components/AtlassianFindingsCard.svelte
// SIO-785 Phase 2: typed Atlassian linked-incidents card. Mirrors the
// GitLabFindingsCard link-row pattern: status dot + linked key + summary +
// status pill + severity badge. Status colour is heuristic (Resolved/Done/
// Closed = green, In Progress/Review = amber, Open/To Do/New = red) so this
// stays robust against per-project Jira workflow variations.
import type { AtlassianFindings } from "@devops-agent/shared";

let { findings }: { findings: AtlassianFindings } = $props();

function statusDotClass(status: string): string {
	const s = status.toLowerCase();
	if (s.includes("resolved") || s.includes("done") || s.includes("closed")) return "bg-green-500";
	if (s.includes("progress") || s.includes("review")) return "bg-amber-500";
	if (s.includes("open") || s.includes("to do") || s.includes("todo") || s.includes("new")) return "bg-red-500";
	return "bg-slate-400";
}

function shortSummary(s: string | undefined): string {
	if (!s) return "(no summary)";
	return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

const linkedIssues = $derived(findings.linkedIssues ?? []);
const hasContent = $derived(linkedIssues.length > 0);
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-blue-100 bg-blue-50/40 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-blue-700 uppercase tracking-wider">Atlassian findings</span>
    </div>

    <div>
      <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Linked incidents</span>
      <div class="mt-1 flex flex-col gap-1">
        {#each linkedIssues as issue}
          <div class="flex items-center gap-2 text-[0.6875rem]">
            <div class="w-1.5 h-1.5 rounded-full shrink-0 {statusDotClass(issue.status)}" title={issue.status}></div>
            {#if issue.url}
              <a href={issue.url} target="_blank" rel="noopener noreferrer" class="font-mono font-medium text-blue-800 hover:text-blue-900 shrink-0">{issue.key}</a>
            {:else}
              <span class="font-mono font-medium text-gray-800 shrink-0">{issue.key}</span>
            {/if}
            <span class="text-gray-800 truncate" title={issue.summary}>{shortSummary(issue.summary)}</span>
            <span class="text-[0.5625rem] uppercase tracking-wider text-gray-500 shrink-0 ml-auto">{issue.status}</span>
            {#if issue.severity}
              <span class="text-[0.5625rem] uppercase tracking-wider text-gray-500 shrink-0">{issue.severity}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
