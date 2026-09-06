// agent/src/pi-handoff-workflow-handlers.ts
//
// SIO-1651: the skillflow executor's THIRD production wiring (after
// resolve-identifiers and incident-close), and the first to register the
// `graph` and `agent` StepHandlers -- both of which threw MissingHandlerError
// everywhere until now. Runs entirely POST-TURN as a detached background
// workflow; nothing here may throw in a way that reaches the caller uncaught.
//
// The `graph` step READS the completed turn's report rather than re-invoking
// the pipeline. classify already snapshots the prior investigation into
// closingReport (classifier.ts, SIO-1357) precisely so closing an incident
// never re-runs a multi-minute fan-out; re-invoking here would repeat that
// whole 7-agent investigation to reproduce a report that already exists. The
// report therefore arrives through the injected readCompletedReport dep, which
// the web layer backs with graph.getState.
//
// The `agent` step reuses runHubTask (pi-verifier.ts) so the workflow path and
// the SIO-1635 card path share one hub implementation and cannot drift.

import { getLogger } from "@devops-agent/observability";
import { PI_VERDICT_RESPONSE_SCHEMA, type PiVerdict, PiVerdictSchema, redactPiiContent } from "@devops-agent/shared";
import { runWorkflow } from "@devops-agent/skillflow";
import {
	buildVerifyPrompt,
	isPiComsConfigured,
	type PiVerifierDeps,
	readPiComsCapability,
	resolvePiComsConfig,
	runHubTask,
} from "./action-tools/pi-verifier.ts";
import { loadPiHandoffWorkflow } from "./pi-handoff-workflow.ts";
import { recordVerdictDecision } from "./pi-verdict-memory.ts";

const logger = getLogger("agent:piHandoffWorkflow");

// The agent name the workflow's verify step binds to. A step naming anything
// else is a YAML/wiring bug, refused rather than dispatched (mirrors the
// memory-pr guard in incident-close-workflow-handlers.ts).
const VERIFY_AGENT_TARGET = "aws-spoke";

// SIO-1655: default ON (kill-switch semantics). Set PI_HANDOFF_ENABLED=false (or
// 0) to disable. runPiHandoff already skips when no hub is configured, so a
// deployment without pi-coms never sends anything.
export function isPiHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return readPiComsCapability(env, "handoff");
}

export interface PiHandoffContext {
	threadId: string;
	estate: string;
	requestId: string;
}

export interface PiHandoffDeps {
	// Reads the completed turn's investigation report for this thread. Injected
	// so this module never imports the web layer's graph/checkpointer access.
	readCompletedReport: (threadId: string) => Promise<string>;
	// fetchImpl/now/env passthrough for hermetic tests.
	verifierDeps?: PiVerifierDeps;
}

export type PiHandoffResult =
	| { status: "verdict"; verdict: PiVerdict["verdict"]; target: string; msgId: string }
	| { status: "queued"; target: string; msgId: string }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

// Runs analyze (read the completed report) -> verify (spoke). Never throws:
// every failure mode resolves to a PiHandoffResult so the detached caller
// needs no try/catch of its own.
export async function runPiHandoff(ctx: PiHandoffContext, deps: PiHandoffDeps): Promise<PiHandoffResult> {
	const env = deps.verifierDeps?.env ?? process.env;
	if (!isPiComsConfigured(env)) return { status: "skipped", reason: "pi-coms hub is not configured" };
	const config = resolvePiComsConfig(env);

	// Captured from the agent step so the outcome survives the executor's
	// string-only step outputs (a queued send has no verdict to report).
	let target: string | undefined;
	let queued = false;

	const result = await runWorkflow(loadPiHandoffWorkflow(), {
		trigger: { thread_id: ctx.threadId, estate: ctx.estate },
		handlers: {
			graph: async (resolved) => {
				const report = await deps.readCompletedReport(ctx.threadId);
				if (!report.trim()) throw new Error(`thread ${ctx.threadId} has no completed report to verify`);
				const outputName = resolved.step.outputs?.[0] ?? "report";
				return { [outputName]: report };
			},
			agent: async (resolved) => {
				if (resolved.target !== VERIFY_AGENT_TARGET) throw new Error(`unbound agent step "${resolved.target}"`);
				const report = resolved.inputs.report ?? "";
				if (!report.trim()) throw new Error("verify step ran without a report");
				const estate = resolved.inputs.estate ?? ctx.estate;

				const outcome = await runHubTask({
					estate,
					// Redacted before the report leaves the process, as the
					// incident-close skill steps do with their inputs.
					prompt: buildVerifyPrompt({ params: { estate }, report: redactPiiContent(report) }),
					responseSchema: PI_VERDICT_RESPONSE_SCHEMA,
					budgetMs: config.verifyTimeoutMs,
					config,
					deps: deps.verifierDeps ?? {},
				});

				if (outcome.kind === "failed") throw new Error(outcome.error);
				target = outcome.target;
				if (outcome.kind === "queued") {
					// The spoke was offline and the send is parked in the durable
					// mailbox. No verdict exists, so nothing is remembered; the
					// step still satisfies its declared outputs.
					queued = true;
					logger.info({ estate, target: outcome.target }, "pi hand-off queued to the fallback mailbox");
					return { verdict: "", msg_id: outcome.msg_id };
				}

				const parsed = PiVerdictSchema.safeParse(outcome.response);
				if (!parsed.success) {
					throw new Error(`pi agent ${outcome.target} replied with an unusable verdict (schema mismatch)`);
				}
				// Structured fields only; see pi-verdict-memory.ts.
				recordVerdictDecision({
					estate,
					target: outcome.target,
					msgId: outcome.msg_id,
					requestId: ctx.requestId,
					verdict: parsed.data,
				});
				return { verdict: parsed.data.verdict, msg_id: outcome.msg_id };
			},
		},
	});

	if (!result.ok) {
		logger.warn({ threadId: ctx.threadId, workflow: result.workflow }, "pi-handoff workflow degraded");
	}

	const analyzeStep = result.steps.find((s) => s.name === "analyze");
	if (analyzeStep?.status !== "ok") {
		return { status: "skipped", reason: analyzeStep?.error ?? "analyze step did not run" };
	}
	const verifyStep = result.steps.find((s) => s.name === "verify");
	if (verifyStep?.status !== "ok") {
		return { status: "failed", reason: verifyStep?.error ?? "verify step did not run" };
	}

	const msgId = verifyStep.outputs.msg_id ?? "";
	if (queued) return { status: "queued", target: target ?? "", msgId };

	const verdict = verifyStep.outputs.verdict;
	const validated = PiVerdictSchema.shape.verdict.safeParse(verdict);
	if (!validated.success) return { status: "failed", reason: `unexpected verdict value: ${verdict}` };
	return { status: "verdict", verdict: validated.data, target: target ?? "", msgId };
}

// The one call site the post-turn background hook uses. Wraps runPiHandoff with
// its own top-level try/catch -- this function is the boundary a
// fire-and-forget caller can await without any risk of an unhandled rejection
// reaching the process (mirrors runIncidentCloseForClosingTurn).
export async function runPiHandoffForClosingTurn(
	ctx: PiHandoffContext,
	readCompletedReport: (threadId: string) => Promise<string>,
): Promise<PiHandoffResult> {
	try {
		return await runPiHandoff(ctx, { readCompletedReport });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ threadId: ctx.threadId, error: message }, "pi-handoff workflow failed");
		return { status: "failed", reason: message };
	}
}
