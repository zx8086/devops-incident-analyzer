<script lang="ts">
// apps/web/src/lib/components/CouchbaseFindingsCard.svelte
// SIO-776: render typed couchbase findings inline in chat. Mirrors
// KafkaFindingsCard structure. Today surfaces top-N slow N1QL queries from
// capella_get_longest_running_queries; extend with new fields as the schema
// grows (e.g. index utilisation, slow-query advisor output).
import type { CouchbaseFindings } from "@devops-agent/shared";

let { findings }: { findings: CouchbaseFindings } = $props();

// SIO-776: avgServiceTime is a string like "9.93s" / "120ms" from
// capella_get_longest_running_queries. Parse to seconds for sort + scale.
function parseDurationSec(s: string | undefined): number {
	if (!s) return 0;
	const trimmed = s.trim();
	const m = trimmed.match(/^([\d.]+)\s*(s|ms|us|µs|m|min|h)$/i);
	if (!m) return Number.parseFloat(trimmed) || 0;
	const n = Number.parseFloat(m[1] ?? "0");
	switch (m[2]?.toLowerCase()) {
		case "h":
			return n * 3600;
		case "m":
		case "min":
			return n * 60;
		case "s":
			return n;
		case "ms":
			return n / 1000;
		case "us":
		case "µs":
			return n / 1_000_000;
		default:
			return n;
	}
}

const slowQueries = $derived.by(() => {
	const rows = findings.slowQueries ?? [];
	return [...rows].sort((a, b) => parseDurationSec(b.avgServiceTime) - parseDurationSec(a.avgServiceTime));
});

const hasContent = $derived(slowQueries.length > 0);

const maxSec = $derived(Math.max(...slowQueries.map((q) => parseDurationSec(q.avgServiceTime)), 0.001));

function barWidthPct(s: string | undefined): number {
	const sec = parseDurationSec(s);
	if (sec <= 0) return 0;
	return Math.min(100, (sec / maxSec) * 100);
}

// SIO-776: SQL++ statements span multiple lines; collapse to single line for
// the truncated cell so the row height stays uniform.
function singleLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-emerald-700 uppercase tracking-wider">Couchbase findings</span>
    </div>

    <div>
      <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Slow queries</span>
      <div class="mt-1 flex flex-col gap-1">
        {#each slowQueries as q}
          <div class="flex items-center gap-2 text-[0.6875rem]">
            <span class="font-mono text-gray-800 truncate max-w-[280px]" title={q.statement}>{singleLine(q.statement)}</span>
            <div class="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div
                class="h-full bg-emerald-500 rounded-full transition-all"
                style="width: {barWidthPct(q.avgServiceTime)}%"
              ></div>
            </div>
            <span class="text-gray-700 tabular-nums shrink-0 w-14 text-right">{q.avgServiceTime ?? "—"}</span>
            {#if q.queries !== undefined}
              <span class="text-[0.5625rem] text-gray-500 tabular-nums shrink-0 w-8 text-right" title="runs">×{q.queries}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
