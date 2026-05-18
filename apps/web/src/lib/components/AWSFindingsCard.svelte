<script lang="ts">
// apps/web/src/lib/components/AWSFindingsCard.svelte
// SIO-785 Phase 2: typed AWS CloudWatch alarm findings inline in chat.
// Mirrors KafkaFindingsCard's state-aggregate header + per-row status-dot
// pattern. Sort: ALARM first, INSUFFICIENT_DATA second, OK last so the
// triage signal is at the top of the list.
import type { AwsFindings } from "@devops-agent/shared";

let { findings }: { findings: AwsFindings } = $props();

function statePriority(state: string): number {
	switch (state.toUpperCase()) {
		case "ALARM":
			return 0;
		case "INSUFFICIENT_DATA":
			return 1;
		case "OK":
			return 2;
		default:
			return 3;
	}
}

function stateDotClass(state: string): string {
	switch (state.toUpperCase()) {
		case "OK":
			return "bg-green-500";
		case "ALARM":
			return "bg-red-500";
		case "INSUFFICIENT_DATA":
			return "bg-slate-400";
		default:
			return "bg-slate-300";
	}
}

const alarms = $derived.by(() => {
	const rows = findings.alarms ?? [];
	return [...rows].sort((a, b) => statePriority(a.state) - statePriority(b.state));
});

const hasContent = $derived(alarms.length > 0);

const stateCounts = $derived.by(() => {
	const counts: Record<string, number> = {};
	for (const a of alarms) {
		const k = a.state.toUpperCase();
		counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
});

const aggregateLabel = $derived(
	Object.entries(stateCounts)
		.sort((a, b) => statePriority(a[0]) - statePriority(b[0]))
		.map(([s, n]) => `${n} ${s}`)
		.join(" · "),
);
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-amber-100 bg-amber-50/40 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-amber-700 uppercase tracking-wider">AWS findings</span>
    </div>

    <div>
      <div class="flex items-center gap-2 mb-1">
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">CloudWatch alarms</span>
        <span class="text-[0.5625rem] text-gray-500 tabular-nums">{aggregateLabel}</span>
      </div>
      <div class="mt-1 flex flex-col gap-1">
        {#each alarms as alarm}
          <div class="flex items-center gap-2 text-[0.6875rem]">
            <div class="w-1.5 h-1.5 rounded-full shrink-0 {stateDotClass(alarm.state)}" title={alarm.state}></div>
            <span class="font-medium text-gray-800 truncate max-w-[240px]" title={alarm.name}>{alarm.name}</span>
            <span class="text-[0.5625rem] uppercase tracking-wider text-gray-400 shrink-0">{alarm.state}</span>
            {#if alarm.namespace}
              <span class="text-[0.5625rem] text-gray-400 shrink-0">{alarm.namespace}</span>
            {/if}
            {#if alarm.reason}
              <span class="text-gray-600 truncate" title={alarm.reason}>{alarm.reason}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
