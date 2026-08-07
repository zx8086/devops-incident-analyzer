// agent/src/live-memory-section.test.ts
// SIO-1446: pure-renderer tests. Deliberately does NOT import prompt-context.ts
// (mock.module'd process-globally by sibling suites -- see lifecycle.test.ts's
// pollution note), so these assertions hold regardless of file load order.
import { describe, expect, test } from "bun:test";
import { renderLiveMemorySection } from "./live-memory-section.ts";

describe("renderLiveMemorySection (SIO-1446)", () => {
	test("renders context and bounded key decisions exactly as before (no recall)", () => {
		const out = renderLiveMemorySection({ context: "ctx block", keyDecisions: "d1\nd2" });
		expect(out).toContain("## Live Memory");
		expect(out).toContain("ctx block");
		expect(out).toContain("### Recent Key Decisions\n\nd1\nd2");
		expect(out).not.toContain("Recalled From Past Sessions");
	});

	test("appends the recalled block, labeled and last", () => {
		const out = renderLiveMemorySection({ context: "ctx block" }, "prior incident: kafka lag caused by ILM policy");
		expect(out).toContain("### Recalled From Past Sessions\n\nprior incident: kafka lag caused by ILM policy");
		expect(out.indexOf("ctx block")).toBeLessThan(out.indexOf("Recalled From Past Sessions"));
	});

	test("recall alone still produces a Live Memory section (agent-memory backend with stale files)", () => {
		const out = renderLiveMemorySection({}, "recalled-only content");
		expect(out).toContain("## Live Memory");
		expect(out).toContain("### Recalled From Past Sessions\n\nrecalled-only content");
	});

	test("whitespace-only recall is ignored, preserving the empty-section fast path", () => {
		expect(renderLiveMemorySection({}, "   \n  ")).toBe("");
		expect(renderLiveMemorySection({})).toBe("");
	});

	test("key decisions beyond the bound are tail-truncated with an ellipsis marker", () => {
		const long = "x".repeat(4100);
		const out = renderLiveMemorySection({ keyDecisions: long });
		expect(out).toContain("...\n");
		expect(out).not.toContain(long);
	});
});
