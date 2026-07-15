// apps/web/src/lib/components/CompletedProgress.test.ts
// SIO-934: CompletedProgress is the single source of truth for whether a trace renders
// (ChatMessage now only gates on !isStreaming). These lock its self-gating (hasContent),
// the per-outcome chip label, and that completedNodes ALONE is enough to render -- the case
// that an elastic-iac resume turn produces (nodes carried forward, no other metadata).
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import CompletedProgress from "./CompletedProgress.svelte";

describe("CompletedProgress self-gating (SIO-934)", () => {
	test("renders the chip from completedNodes alone (no responseTime/tools/findings)", () => {
		const { body } = render(CompletedProgress, {
			props: { completedNodes: new Map([["openMr", { duration: 800 }]]) },
		});
		expect(body).toContain("Completed");
	});

	test("renders no chip when there is no content at all", () => {
		// SSR still emits {#if} comment markers, so assert on the absence of chip text,
		// not an empty string.
		const { body } = render(CompletedProgress, { props: {} });
		expect(body).not.toContain("Completed");
		expect(body).not.toContain("Pipeline");
	});

	test("renders no chip for an empty completedNodes map and no other signal", () => {
		const { body } = render(CompletedProgress, { props: { completedNodes: new Map() } });
		expect(body).not.toContain("Completed");
		expect(body).not.toContain("Pipeline");
	});

	// SIO-984: the post-MR watchPipeline node is now a first-class pill labelled "Pipeline" -- a
	// watchPipeline-only completedNodes map still renders the outcome chip (the per-node pill list is
	// behind a client-side expand toggle that SSR can't open, so we assert the chip renders, i.e. the
	// node is treated as content and not dropped).
	test("a watchPipeline completedNode still renders the trace chip", () => {
		const { body } = render(CompletedProgress, {
			props: { completedNodes: new Map([["watchPipeline", { duration: 130_000 }]]) },
		});
		expect(body).toContain("Completed");
	});
});

describe("CompletedProgress outcome chip (SIO-934 / SIO-930)", () => {
	const nodes = new Map([["draftChange", { duration: 1224 }]]);

	test("completed -> green 'Completed'", () => {
		const { body } = render(CompletedProgress, { props: { completedNodes: nodes, outcome: "completed" } });
		expect(body).toContain("Completed");
	});

	test("blocked -> amber 'Blocked'", () => {
		const { body } = render(CompletedProgress, { props: { completedNodes: nodes, outcome: "blocked" } });
		expect(body).toContain("Blocked");
		expect(body).not.toContain("Completed");
	});

	test("rejected -> amber 'Plan rejected'", () => {
		const { body } = render(CompletedProgress, { props: { completedNodes: nodes, outcome: "rejected" } });
		expect(body).toContain("Plan rejected");
	});

	test("pipeline-failed -> red 'Pipeline failed'", () => {
		const { body } = render(CompletedProgress, { props: { completedNodes: nodes, outcome: "pipeline-failed" } });
		expect(body).toContain("Pipeline failed");
	});

	// SIO-1110: an errored stream renders a red "Failed" chip, never green "Completed".
	test("error -> red 'Failed', not 'Completed'", () => {
		const { body } = render(CompletedProgress, { props: { completedNodes: nodes, outcome: "error" } });
		expect(body).toContain("Failed");
		expect(body).toContain("text-red-700");
		expect(body).not.toContain("Completed");
	});

	// SIO-1110 review: a client-side fetch failure carries no nodes/metadata at
	// all; the error outcome alone must defeat the hasContent gate.
	test("error with no trace content still renders the Failed chip", () => {
		const { body } = render(CompletedProgress, { props: { outcome: "error" } });
		expect(body).toContain("Failed");
		expect(body).toContain("text-red-700");
		expect(body).not.toContain("Completed");
	});

	test("completed chip shows the response time when present", () => {
		const { body } = render(CompletedProgress, {
			props: { completedNodes: nodes, responseTime: 13166, outcome: "completed" },
		});
		expect(body).toContain("13.2s");
	});
});
