// agent/src/incident-close-workflow-handlers.ts
//
// SIO-1357: preset-workflow execution path for the incident-close workflow --
// the skillflow executor's SECOND production wiring (the first is
// resolve-identifiers-workflow-handlers.ts). Registers the `skill` StepHandler
// (unimplemented anywhere until now) and a `tool` handler for the memory-pr
// step. Runs entirely POST-TURN as a detached background workflow; nothing
// here may throw in a way that reaches the caller uncaught -- runIncidentClose
// wraps runWorkflow and reports a soft outcome instead. The LLM call and the
// memory-pr write are both injected via ClosureDeps (mirrors PresetProbeDeps
// in resolve-identifiers-workflow-handlers.ts) so this module is testable
// without live Bedrock credentials or a real GitHub token.

import { existsSync, readFileSync } from "node:fs";
import type { OpenMemoryPrResult } from "@devops-agent/memory-pr";
import { openMemoryPr } from "@devops-agent/memory-pr";
import { getLogger } from "@devops-agent/observability";
import { redactPiiContent } from "@devops-agent/shared";
import { runWorkflow } from "@devops-agent/skillflow";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { loadIncidentCloseWorkflow } from "./close-workflow.ts";
import { createLlm, type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { getWorkspaceRoot, skillFilePath } from "./paths.ts";

const logger = getLogger("agent:incidentCloseWorkflow");

const CLOSURE_AGENT = "incident-analyzer";

// SIO-1357: default OFF until live-verified (same idiom as
// RESOLVE_IDENTIFIERS_PRESETS_ENABLED before its SIO-1355 flip).
export function isClosureLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.CLOSURE_LEARNING_ENABLED;
	return v === "true" || v === "1";
}

export interface ClosureContext {
	threadId: string;
	ticketKey?: string;
	report: string;
	confidence?: string;
}

export interface WikiPageProposal {
	kind: "wiki-page";
	branch: string;
	title: string;
	body: string;
	files: Array<{ path: string; contents: string }>;
	labels?: string[];
}

export interface ClosureDeps {
	// One production LLM call: system prompt (the skill body) + human text
	// (the resolved, redacted `with` inputs) -> response text. Production
	// wiring calls createLlm("closureSkillStep", ...) + invokeWithDeadline,
	// mirroring learnDistill (learn/distill.ts) -- injected here so this
	// module never imports @langchain/aws directly.
	invokeSkillLlm: (systemPrompt: string, humanText: string) => Promise<string>;
	// Opens (or soft-skips/blocks) the wiki-page memory PR. Production wiring
	// is openMemoryPr from @devops-agent/memory-pr.
	openWikiPr: (proposal: WikiPageProposal) => Promise<OpenMemoryPrResult>;
}

function loadSkillBody(skillName: string): string | undefined {
	const path = skillFilePath(getWorkspaceRoot(), CLOSURE_AGENT, skillName);
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch (error) {
		logger.warn({ skillName, error: error instanceof Error ? error.message : String(error) }, "skill body read failed");
		return undefined;
	}
}

function renderInputs(inputs: Record<string, string>): string {
	return Object.entries(inputs)
		.filter(([, value]) => value !== "")
		.map(([key, value]) => `${key}:\n${value}`)
		.join("\n\n");
}

// Deterministic proposal shape for the wiki-page memory PR: the LLM composes
// the page body (via the wiki-ingest skill step); everything else (branch,
// title, labels, path) is fixed so a malformed model output can never smuggle
// an unexpected file path or branch name into the PR.
export function buildWikiPageProposal(threadId: string, pageBody: string): WikiPageProposal {
	const slug = threadId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "incident";
	return {
		kind: "wiki-page",
		branch: `agent/learn/closure-${slug}`,
		title: `Closure wiki update (thread ${threadId})`,
		body: "Automated wiki-page proposal from an incident-closure learning run. Review before merge.",
		files: [{ path: `agents/${CLOSURE_AGENT}/memory/wiki/pages/closure-${slug}.md`, contents: pageBody }],
		labels: ["incident-closure"],
	};
}

export interface CloseWorkflowResult {
	status: "opened" | "skipped" | "blocked" | "no-fragment";
	reason?: string;
	url?: string;
}

// Runs the incident-close workflow end to end: postmortem -> post_wiki ->
// learn (memory-pr). Never throws -- every failure mode (missing skill body,
// LLM error, memory-pr disabled/blocked) resolves to a CloseWorkflowResult so
// the caller (the post-turn background hook) never needs its own try/catch.
export async function runIncidentClose(ctx: ClosureContext, deps: ClosureDeps): Promise<CloseWorkflowResult> {
	let wikiProposalBody: string | undefined;

	const result = await runWorkflow(loadIncidentCloseWorkflow(), {
		trigger: {
			report: ctx.report,
			confidence: ctx.confidence ?? "",
		},
		handlers: {
			// A skill step = the named skill's SKILL.md body as the system prompt,
			// the resolved `with` inputs (already template-substituted by the
			// executor) redacted here before they leave the process, one LLM call.
			skill: async (resolved) => {
				const skillBody = loadSkillBody(resolved.target);
				if (!skillBody) throw new Error(`skill "${resolved.target}" has no SKILL.md under ${CLOSURE_AGENT}`);
				const humanText = redactPiiContent(renderInputs(resolved.inputs));
				const text = await deps.invokeSkillLlm(skillBody, humanText);
				if (resolved.step.name === "post_wiki") wikiProposalBody = text;
				// Both skill steps in this workflow declare exactly one output
				// (report/proposal) -- the executor doesn't care which name, it
				// just needs a Record<string,string> matching what the YAML
				// declared, which resolveStep/applyStepResult already validate.
				const outputName = resolved.step.outputs?.[0] ?? "result";
				return { [outputName]: text };
			},
			tool: async (resolved) => {
				if (resolved.target !== "memory-pr") throw new Error(`unbound tool step "${resolved.target}"`);
				if (!wikiProposalBody) throw new Error("memory-pr step ran without a wiki proposal body");
				const proposal = buildWikiPageProposal(ctx.threadId, wikiProposalBody);
				const opened = await deps.openWikiPr(proposal);
				return { status: opened.status, url: opened.url ?? "" };
			},
		},
	});

	if (!result.ok) {
		logger.warn({ threadId: ctx.threadId, workflow: result.workflow }, "incident-close workflow degraded");
	}

	const learnStep = result.steps.find((s) => s.name === "learn");
	if (learnStep?.status !== "ok") {
		return { status: "no-fragment", reason: learnStep?.error ?? "learn step did not run" };
	}
	const status = learnStep.outputs.status;
	if (status === "opened" || status === "skipped" || status === "blocked") {
		return { status, url: learnStep.outputs.url || undefined };
	}
	return { status: "no-fragment", reason: `unexpected memory-pr status: ${status}` };
}

// SIO-1357: idempotency against duplicate PRs on repeated closure of the same
// thread comes from the deterministic branch name (buildWikiPageProposal:
// agent/learn/closure-<thread>) plus GitHub's own ref semantics, not a
// separate check here. createBranch (memory-pr/src/github-client.ts) POSTs
// `refs/heads/<branch>` unconditionally -- GitHub 422s if the ref already
// exists, ghFetch throws on any non-ok response, and the executor's own
// per-step try/catch (runOne) converts that throw into a "failed" learn
// StepRunResult rather than a second PR. A repeat "close incident" for the
// same thread therefore fails closed (no PR, logged failure) instead of
// opening a duplicate -- verified by the "second closure attempt on the same
// thread fails closed" test below.

// Production ClosureDeps: the real Bedrock call (createLlm + invokeWithDeadline,
// mirroring learnDistill in learn/distill.ts) and the real memory-pr write.
const productionDeps: ClosureDeps = {
	invokeSkillLlm: async (systemPrompt, humanText) => {
		const llm = createLlm("closureSkillStep", CLOSURE_AGENT);
		const result = await invokeWithDeadline(llm as InvokableLlm, "closureSkillStep", [
			new SystemMessage(systemPrompt),
			new HumanMessage(humanText),
		]);
		return extractTextFromContent(result.content);
	},
	openWikiPr: (proposal) => openMemoryPr(proposal),
};

// The one call site the post-turn background hook uses. Wraps runIncidentClose
// with the production deps AND its own top-level try/catch -- this function is
// the boundary a fire-and-forget caller can await without any risk of an
// unhandled rejection reaching the process (the hook itself is detached, but
// a promise that never resolves/rejects predictably is still a bug).
export async function runIncidentCloseForClosingTurn(ctx: ClosureContext): Promise<CloseWorkflowResult> {
	try {
		return await runIncidentClose(ctx, productionDeps);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ threadId: ctx.threadId, error: message }, "incident-close workflow failed");
		return { status: "no-fragment", reason: message };
	}
}
