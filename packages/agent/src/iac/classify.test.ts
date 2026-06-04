// agent/src/iac/classify.test.ts
import { describe, expect, test } from "bun:test";
import { intentFromText } from "./nodes.ts";

// SIO-870: the classifier LLM returns a single word; intentFromText maps it to the
// route. Only an explicit "gitops" mention enters the maker pipeline; everything
// else (including blank/garbled replies) defaults to the safe read-only path... but
// the node's prompt biases ambiguous "should I" requests to literally answer gitops.
describe("intentFromText", () => {
	test("maps an explicit gitops reply to gitops", () => {
		expect(intentFromText("gitops")).toBe("gitops");
		expect(intentFromText("GitOps")).toBe("gitops");
		expect(intentFromText("the answer is gitops")).toBe("gitops");
	});

	test("maps info and anything non-gitops to info", () => {
		expect(intentFromText("info")).toBe("info");
		expect(intentFromText("INFO")).toBe("info");
		expect(intentFromText("")).toBe("info");
		expect(intentFromText("unsure")).toBe("info");
	});

	// SIO-882: a "drift"/"reconcile" reply routes to the drift + per-stack reconcile flow.
	test("maps drift/reconcile replies to drift", () => {
		expect(intentFromText("drift")).toBe("drift");
		expect(intentFromText("reconcile")).toBe("drift");
		expect(intentFromText("the answer is drift")).toBe("drift");
	});

	// SIO-902: synthetics phrasings route to synthetics-drift, and must win the tiebreak over
	// plain "drift"/"reconcile" (a synthetics reply contains those words too).
	test("maps synthetics replies to synthetics-drift", () => {
		expect(intentFromText("synthetics-drift")).toBe("synthetics-drift");
		expect(intentFromText("synthetic")).toBe("synthetics-drift");
		expect(intentFromText("monitor drift")).toBe("synthetics-drift");
		expect(intentFromText("uptime")).toBe("synthetics-drift");
		// "reconcile synthetics" / "synthetics drift" contain "drift"/"reconcile" but must NOT
		// fall through to plain drift.
		expect(intentFromText("reconcile synthetics")).toBe("synthetics-drift");
		expect(intentFromText("synthetics drift")).toBe("synthetics-drift");
	});

	test("plain drift requests still route to drift (not synthetics)", () => {
		expect(intentFromText("check eu-b2b for drift")).toBe("drift");
		expect(intentFromText("reconcile the lifecycle-policies stack")).toBe("drift");
	});
});
