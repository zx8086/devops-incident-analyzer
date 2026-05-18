<script lang="ts">
// apps/web/src/lib/components/GitLabFindingsCard.svelte
// SIO-777: render typed gitlab findings inline in chat. A deploy timeline of
// recently-merged MRs sorted by merged_at desc, with project name parsed from
// the web_url path so the rows are scannable per-service.
import type { GitLabFindings, GitLabMergedRequest } from "@devops-agent/shared";

let { findings }: { findings: GitLabFindings } = $props();

// SIO-777: web_url shape like
//   https://gitlab.com/pvhcorp/b2b/<subgroup>/<service>/-/merge_requests/123
// Pull the segment between the host and "/-/merge_requests/". When the URL
// doesn't match, fall back to the project_id (or an em-dash).
function projectFromWebUrl(mr: GitLabMergedRequest): string {
	if (mr.web_url) {
		const m = mr.web_url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//);
		if (m?.[1]) {
			// Trim long path prefixes — keep last two segments for readability.
			const parts = m[1].split("/");
			if (parts.length >= 2) return parts.slice(-2).join("/");
			return m[1];
		}
	}
	if (mr.project_id !== undefined) return `project #${mr.project_id}`;
	return "—";
}

function shortDate(iso: string | undefined): string {
	if (!iso) return "—";
	// "2026-05-05T14:23:18.000Z" → "2026-05-05"
	return iso.slice(0, 10);
}

function shortTitle(title: string | undefined): string {
	if (!title) return "(untitled)";
	if (title.length > 80) return `${title.slice(0, 77)}…`;
	return title;
}

const mergedRequests = $derived.by(() => {
	const rows = findings.mergedRequests ?? [];
	return [...rows].sort((a, b) => {
		const ta = a.merged_at ?? "";
		const tb = b.merged_at ?? "";
		return tb.localeCompare(ta);
	});
});

const hasContent = $derived(mergedRequests.length > 0);
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-orange-100 bg-orange-50/40 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-orange-700 uppercase tracking-wider">GitLab findings</span>
    </div>

    <div>
      <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Recent deploys</span>
      <div class="mt-1 flex flex-col gap-1">
        {#each mergedRequests as mr}
          <div class="flex items-baseline gap-2 text-[0.6875rem]">
            <span class="text-gray-500 tabular-nums shrink-0 w-20">{shortDate(mr.merged_at)}</span>
            <span class="font-medium text-gray-700 truncate max-w-[180px] shrink-0" title={projectFromWebUrl(mr)}>{projectFromWebUrl(mr)}</span>
            {#if mr.web_url}
              <a href={mr.web_url} target="_blank" rel="noopener noreferrer" class="text-gray-800 hover:text-orange-700 truncate" title={mr.title ?? mr.web_url}>
                {shortTitle(mr.title)}
              </a>
            {:else}
              <span class="text-gray-800 truncate" title={mr.title ?? ""}>{shortTitle(mr.title)}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
