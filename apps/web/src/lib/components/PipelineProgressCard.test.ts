// apps/web/src/lib/components/PipelineProgressCard.test.ts
// SIO-928: the IaC pipeline-progress lines render as an avatar + card (live) or, after completion,
// an always-expanded log (SIO-941: no longer a collapsible <details>), never as bare floating text.
// These lock in both variants.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import PipelineProgressCard from "./PipelineProgressCard.svelte";

const lines = [
	"Pipeline #2606400810: created",
	"Pipeline #2606400810: fleet apply: started -- 1608 agent(s) -> 9.4.2, expected ~60 min",
];

describe("PipelineProgressCard", () => {
	test("renders no card when there are no lines", () => {
		// Svelte SSR still emits hydration comment markers (<!--[-->) for an empty {#if}; assert there
		// is no actual rendered content rather than a literally empty string.
		const { body } = render(PipelineProgressCard, { props: { lines: [] } });
		expect(body).not.toContain("Pipeline progress");
		expect(body).not.toContain("<details");
		expect(body).not.toContain("rounded-full"); // no avatar
	});

	test("live variant shows the bot avatar and every progress line", () => {
		const { body } = render(PipelineProgressCard, { props: { lines, variant: "live" } });
		// avatar present (Icon name="bot" renders an svg; the offwhite avatar wrapper is the tell)
		expect(body).toContain("rounded-full");
		expect(body).toContain("Pipeline progress");
		for (const line of lines) expect(body).toContain(line);
		// live variant is NOT a <details> log
		expect(body).not.toContain("<details");
	});

	test("collapsed variant renders an always-expanded log (no <details>) with a pluralised step count", () => {
		const { body } = render(PipelineProgressCard, { props: { lines, variant: "collapsed" } });
		// SIO-941: the post-completion log is no longer collapsible -- steps show inline.
		expect(body).not.toContain("<details");
		expect(body).not.toContain("<summary");
		expect(body).toContain("Pipeline log (2 steps)");
		for (const line of lines) expect(body).toContain(line);
	});

	test("collapsed variant uses the singular 'step' for a single line", () => {
		const { body } = render(PipelineProgressCard, {
			props: { lines: ["Pipeline #1: created"], variant: "collapsed" },
		});
		expect(body).toContain("Pipeline log (1 step)");
	});
});
