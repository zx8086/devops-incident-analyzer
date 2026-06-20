// agent/src/iac/classify.test.ts
import { describe, expect, test } from "bun:test";
import {
	intentFromText,
	looksLikeChangeRequest,
	looksLikeFleetStatusCheck,
	resolvePipelinePollBudgetMs,
} from "./nodes.ts";

// SIO-982: the GitOps pipeline poll budget is per-call. By default it is the (short) configured
// budget so the turn stays snappy; when the user asks to wait for the pipeline to finish ("watch
// until done", "wait for it to finish", "watch it to completion"), it extends to the longer budget
// so the pipeline reaches terminal within the turn. Pure; the watchPipeline node calls it on the
// latest human text.
describe("resolvePipelinePollBudgetMs (SIO-982)", () => {
	test("returns the default budget for an ordinary status check", () => {
		expect(resolvePipelinePollBudgetMs("check my MR", 90_000, 300_000)).toBe(90_000);
		expect(resolvePipelinePollBudgetMs("", 90_000, 300_000)).toBe(90_000);
	});

	test("extends to the longer budget when the user asks to wait for completion", () => {
		expect(resolvePipelinePollBudgetMs("watch until done", 90_000, 300_000)).toBe(300_000);
		expect(resolvePipelinePollBudgetMs("wait for it to finish", 90_000, 300_000)).toBe(300_000);
		expect(resolvePipelinePollBudgetMs("watch it to completion", 90_000, 300_000)).toBe(300_000);
		expect(resolvePipelinePollBudgetMs("keep watching until it's complete", 90_000, 300_000)).toBe(300_000);
	});

	test("is case-insensitive", () => {
		expect(resolvePipelinePollBudgetMs("WATCH UNTIL DONE", 90_000, 300_000)).toBe(300_000);
	});

	test("a plain 'check on it' does NOT extend (that is a one-shot status check)", () => {
		expect(resolvePipelinePollBudgetMs("check on it", 90_000, 300_000)).toBe(90_000);
	});
});

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

// SIO-928: a dispatched fleet binary apply has NO merge request, so its follow-ups ("how is the
// rollout?", "check on it", "watch the pipeline") never matched the MR-scoped pipeline-status
// classifier and fell through to info -> answerInfo, which can't re-poll the live pipeline. This
// deterministic guard short-circuits the LLM: when a fleet apply is in flight, a status-check-shaped
// message routes straight to pipeline-status (-> watchPipeline -> checkFleetApplyStatus).
describe("looksLikeFleetStatusCheck (SIO-928)", () => {
	test("matches the rollout/upgrade follow-up phrasings the user actually typed", () => {
		expect(looksLikeFleetStatusCheck("How is the rollout?")).toBe(true);
		expect(looksLikeFleetStatusCheck("check on it or watch the pipeline")).toBe(true);
		expect(looksLikeFleetStatusCheck("check on it")).toBe(true);
		expect(looksLikeFleetStatusCheck("hows the upgrade going")).toBe(true);
		expect(looksLikeFleetStatusCheck("is the upgrade done yet")).toBe(true);
		expect(looksLikeFleetStatusCheck("watch the pipeline")).toBe(true);
		expect(looksLikeFleetStatusCheck("any progress on the agents?")).toBe(true);
		expect(looksLikeFleetStatusCheck("status?")).toBe(true);
	});

	test("does NOT match a fresh upgrade request (that must still start a new apply)", () => {
		// These name a target version -- they are a NEW upgrade, not a status check, even though the
		// guard only fires when a pipeline is already in flight. Keep them out so a second upgrade is
		// never swallowed as a status check.
		expect(looksLikeFleetStatusCheck("upgrade all the fleet elastic agents to 9.4.2 on us-cld")).toBe(false);
		expect(looksLikeFleetStatusCheck("upgrade the agents on eu-b2b to 9.5.0")).toBe(false);
		expect(looksLikeFleetStatusCheck("bump fleet agents to 9.4.3")).toBe(false);
	});

	test("does NOT match unrelated IaC requests", () => {
		expect(looksLikeFleetStatusCheck("check eu-b2b for drift")).toBe(false);
		expect(looksLikeFleetStatusCheck("downsize the warm tier to 8 GB")).toBe(false);
		expect(looksLikeFleetStatusCheck("what version is ap-cld running")).toBe(false);
	});
});

// SIO-983: after a proposal is rejected, the user often re-asks for the change as a REACTION to the
// rejected proposal ("no, follow my prompt and open the MR"). The classifier LLM tends to emit
// "converse" for that framing, routing to the read-only converseIac node which cannot open an MR.
// This deterministic guard short-circuits the LLM: an explicit imperative MR/change request routes
// straight to gitops (the proposal lane + review gate), even on a follow-up turn.
describe("looksLikeChangeRequest (SIO-983)", () => {
	test("matches explicit imperative MR/change phrasings", () => {
		expect(looksLikeChangeRequest("create the MR as you do!")).toBe(true);
		expect(looksLikeChangeRequest("open the MR")).toBe(true);
		expect(looksLikeChangeRequest("open an merge request")).toBe(true);
		expect(looksLikeChangeRequest("open a merge request")).toBe(true);
		expect(looksLikeChangeRequest("raise the MR")).toBe(true);
		expect(looksLikeChangeRequest("now make the change")).toBe(true);
		expect(looksLikeChangeRequest("go ahead and open the merge request")).toBe(true);
		expect(looksLikeChangeRequest("go ahead and create the branch and MR")).toBe(true);
	});

	test("is case-insensitive", () => {
		expect(looksLikeChangeRequest("CREATE THE MR")).toBe(true);
	});

	test("does NOT match conversational follow-ups (those stay converse)", () => {
		expect(looksLikeChangeRequest("why was that config wrong?")).toBe(false);
		expect(looksLikeChangeRequest("explain that policy")).toBe(false);
		expect(looksLikeChangeRequest("I don't think that config is complete")).toBe(false);
		// A question ABOUT not opening the MR is not an imperative to open it.
		expect(looksLikeChangeRequest("why didn't you just open the mr earlier?")).toBe(false);
	});

	test("does NOT match read-only / status-check requests", () => {
		expect(looksLikeChangeRequest("is eu-b2b healthy?")).toBe(false);
		expect(looksLikeChangeRequest("check my MR")).toBe(false);
		expect(looksLikeChangeRequest("how is the rollout going?")).toBe(false);
	});
});
