// agent/src/incident-close-workflow-handlers.test.ts

import { describe, expect, test } from "bun:test";
import type { OpenMemoryPrResult } from "@devops-agent/memory-pr";
import {
	buildWikiPageProposal,
	type CloseWorkflowResult,
	type ClosureDeps,
	isClosureLearningEnabled,
	runIncidentClose,
	type WikiPageProposal,
} from "./incident-close-workflow-handlers.ts";

function fakeDeps(overrides: Partial<ClosureDeps> = {}): {
	deps: ClosureDeps;
	skillCalls: Array<{ systemPrompt: string; humanText: string }>;
	prCalls: WikiPageProposal[];
} {
	const skillCalls: Array<{ systemPrompt: string; humanText: string }> = [];
	const prCalls: WikiPageProposal[] = [];
	const deps: ClosureDeps = {
		invokeSkillLlm: async (systemPrompt, humanText) => {
			skillCalls.push({ systemPrompt, humanText });
			return systemPrompt.includes("Wiki Ingest") ? "# Compiled wiki page\ncontent" : "## Postmortem\ncontent";
		},
		openWikiPr: async (proposal) => {
			prCalls.push(proposal);
			return { status: "opened", url: "https://github.com/o/r/pull/9", number: 9 };
		},
		...overrides,
	};
	return { deps, skillCalls, prCalls };
}

describe("SIO-1357 isClosureLearningEnabled", () => {
	test("defaults OFF; only 'true'/'1' enable", () => {
		expect(isClosureLearningEnabled({})).toBe(false);
		expect(isClosureLearningEnabled({ CLOSURE_LEARNING_ENABLED: "false" })).toBe(false);
		expect(isClosureLearningEnabled({ CLOSURE_LEARNING_ENABLED: "true" })).toBe(true);
		expect(isClosureLearningEnabled({ CLOSURE_LEARNING_ENABLED: "1" })).toBe(true);
	});
});

describe("SIO-1357 buildWikiPageProposal", () => {
	test("builds a deterministic wiki-page proposal from a thread id", () => {
		const proposal = buildWikiPageProposal("thread-abc-123", "# Page\nbody");
		expect(proposal.kind).toBe("wiki-page");
		expect(proposal.branch).toBe("agent/learn/closure-thread-abc-123");
		expect(proposal.files).toEqual([
			{ path: "agents/incident-analyzer/memory/wiki/pages/closure-thread-abc-123.md", contents: "# Page\nbody" },
		]);
		expect(proposal.labels).toEqual(["incident-closure"]);
	});

	test("sanitizes an unsafe thread id into a path/branch-safe slug", () => {
		const proposal = buildWikiPageProposal("../../etc/passwd; rm -rf", "body");
		expect(proposal.branch.startsWith("agent/learn/closure-")).toBe(true);
		const slug = proposal.branch.slice("agent/learn/closure-".length);
		expect(slug).not.toContain("/");
		expect(slug).not.toContain(".");
		expect(proposal.files[0]?.path).not.toContain("..");
	});

	test("falls back to a stable slug when the thread id sanitizes to empty", () => {
		const proposal = buildWikiPageProposal("///", "body");
		expect(proposal.branch).toBe("agent/learn/closure-incident");
	});
});

describe("SIO-1357 runIncidentClose", () => {
	test("composes the skill handler results and returns opened on success", async () => {
		const { deps, skillCalls, prCalls } = fakeDeps();
		const result = await runIncidentClose({ threadId: "thread-1", report: "the report text", confidence: "0.8" }, deps);
		expect(result).toEqual<CloseWorkflowResult>({ status: "opened", url: "https://github.com/o/r/pull/9" });
		// postmortem then post_wiki -- both skill steps invoked exactly once.
		expect(skillCalls).toHaveLength(2);
		expect(prCalls).toHaveLength(1);
		expect(prCalls[0]?.branch).toBe("agent/learn/closure-thread-1");
	});

	test("propagates a skipped memory-pr status without treating it as failure", async () => {
		const { deps } = fakeDeps({
			openWikiPr: async (): Promise<OpenMemoryPrResult> => ({ status: "skipped", reason: "MEMORY_PR_ENABLED not set" }),
		});
		const result = await runIncidentClose({ threadId: "thread-2", report: "r" }, deps);
		expect(result.status).toBe("skipped");
	});

	test("a failing skill call never throws out of runIncidentClose -- degrades to no-fragment", async () => {
		const { deps } = fakeDeps({
			invokeSkillLlm: async () => {
				throw new Error("bedrock unavailable");
			},
		});
		const result = await runIncidentClose({ threadId: "thread-3", report: "r" }, deps);
		expect(result.status).toBe("no-fragment");
		expect(result.reason).toBeDefined();
	});

	test("a failing memory-pr write never throws out of runIncidentClose", async () => {
		const { deps } = fakeDeps({
			openWikiPr: async () => {
				throw new Error("GitHub API 422: reference already exists");
			},
		});
		const result = await runIncidentClose({ threadId: "thread-4", report: "r" }, deps);
		expect(result.status).toBe("no-fragment");
	});

	// SIO-1357: idempotency proof -- a second closure for the SAME thread hits
	// the SAME deterministic branch. openMemoryPr's real implementation throws
	// on a duplicate ref (GitHub 422); this simulates that via the injected dep
	// to prove the workflow fails closed rather than opening a duplicate PR.
	test("second closure attempt on the same thread fails closed (no duplicate PR)", async () => {
		const openedBranches = new Set<string>();
		const { deps } = fakeDeps({
			openWikiPr: async (proposal) => {
				if (openedBranches.has(proposal.branch)) {
					throw new Error(`reference refs/heads/${proposal.branch} already exists`);
				}
				openedBranches.add(proposal.branch);
				return { status: "opened", url: "https://github.com/o/r/pull/9", number: 9 };
			},
		});
		const ctx = { threadId: "thread-dup", report: "r" };
		const first = await runIncidentClose(ctx, deps);
		const second = await runIncidentClose(ctx, deps);
		expect(first.status).toBe("opened");
		expect(second.status).toBe("no-fragment");
		expect(openedBranches.size).toBe(1);
	});
});
