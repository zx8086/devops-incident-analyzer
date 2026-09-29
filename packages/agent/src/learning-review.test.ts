// agent/src/learning-review.test.ts

// SIO-1891: the human gate over learning candidates. Memory is the injected
// client stub; the PR opener and base-file fetch are injected deps.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realMemoryBackendNs from "./memory-backend.ts";

const realMemoryBackend = { ...realMemoryBackendNs };
mock.module("./memory-backend.ts", () => realMemoryBackend);

import { applyEdits, listReviewRows, renderCandidateRunbook, reviewCandidate, rowFromHit } from "./learning-review.ts";

const NOW = "2026-09-29T12:00:00Z";
const prevBackend = process.env.LIVE_MEMORY_BACKEND;

type Hit = { text: string; annotations: Record<string, string> };

function stub(hits: Hit[]) {
	const added: Array<{ facts: string[]; annotations?: Record<string, string> }> = [];
	const client = {
		async ensureUser() {},
		async ensureSession() {},
		async addFacts(_ref: unknown, facts: string[], opts?: { annotations?: Record<string, string> }) {
			added.push({ facts, annotations: opts?.annotations });
			return { blockIds: ["b"], acceptedCount: facts.length, rejectedCount: 0 };
		},
		async addMessages() {
			return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
		},
		async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
			return hits.filter((h) => !opts?.annotations?.kind || h.annotations.kind === opts.annotations.kind);
		},
		async updateSession() {},
		async endSession() {},
		async checkHealth() {
			return { ok: true };
		},
	};
	return { client, added };
}

const TEXT = [
	"Proposed skill: lag-corr - Correlate consumer lag with error spikes.",
	"When to use: When a lag alert coincides with an error-rate rise.",
	"Procedure: Pull lag and error rate over the same window, align timestamps, confirm the overlap.",
	"Evidence:\n- correlated kafka lag with elastic errors",
].join("\n");

const candidate = (over: Record<string, string> = {}): Hit => ({
	text: TEXT,
	annotations: {
		kind: "skill",
		skill_name: "lag-corr",
		status: "candidate",
		source: "turn",
		confidence: "0.5",
		learned_from: "thread:t1",
		learned_at: "2026-09-01T00:00:00Z",
		task_success: "1",
		task_success_source: "feedback",
		...over,
	},
});

async function install(hits: Hit[]) {
	const { __setAgentMemoryClient } = await import("./memory-backend.ts");
	const s = stub(hits);
	// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
	__setAgentMemoryClient(s.client as any);
	return s;
}

beforeEach(() => {
	process.env.LIVE_MEMORY_BACKEND = "agent-memory";
	mock.module("./memory-backend.ts", () => realMemoryBackend);
});

afterEach(async () => {
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	const { __setAgentMemoryClient } = await import("./memory-backend.ts");
	__setAgentMemoryClient(null);
	mock.module("./memory-backend.ts", () => realMemoryBackend);
});

describe("rows", () => {
	test("rowFromHit parses the fact into title, applicability, body and evidence with the state fields", () => {
		const row = rowFromHit("elastic-iac", { ...candidate(), blockId: "b1" });
		expect(row).toMatchObject({
			agent: "elastic-iac",
			skillName: "lag-corr",
			status: "candidate",
			source: "turn",
			taskSuccess: "1",
			taskSuccessSource: "feedback",
			title: "Correlate consumer lag with error spikes.",
			whenToUse: "When a lag alert coincides with an error-rate rise.",
			evidence: ["correlated kafka lag with elastic errors"],
		});
		expect(row.body).toContain("Pull lag and error rate");
	});

	test("listReviewRows keeps the latest state per skill", async () => {
		await install([
			candidate(),
			candidate({ status: "rejected", learned_at: "2026-09-02T00:00:00Z" }),
			candidate({ skill_name: "other", status: "approved" }),
		]);
		const rows = await listReviewRows("incident-analyzer");
		expect(rows.map((r) => [r.skillName, r.status])).toEqual([
			["lag-corr", "rejected"],
			["other", "approved"],
		]);
	});
});

describe("reviewCandidate", () => {
	test("approve refuses without a confirmed task_success and writes nothing", async () => {
		const { added } = await install([candidate({ task_success: "", task_success_source: "" })]);
		const out = await reviewCandidate({ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" });
		expect(out).toMatchObject({ ok: false, code: 409 });
		if (!out.ok) expect(out.reason).toContain("task_success");
		expect(added).toHaveLength(0);
	});

	test("approve with edits writes the approved transition and opens the skill PR under the agent's tree", async () => {
		const { added } = await install([candidate()]);
		const promote = mock(async (_proposal: unknown) => ({
			status: "opened" as const,
			url: "https://github.com/o/r/pull/9",
		}));
		const fetchBase = mock(async () => ({
			status: "ok" as const,
			content: ["name: incident-analyzer", "skills:", "  - existing", ""].join("\n"),
		}));
		const out = await reviewCandidate(
			{
				agent: "incident-analyzer",
				skillName: "lag-corr",
				action: "approve",
				edits: {
					title: "Correlate lag with downstream errors.",
					body: "Pull both series, align, confirm the overlap holds.",
				},
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-1891 - narrow test doubles for the two deps
			{ promote: promote as any, fetchBase: fetchBase as any, now: () => NOW },
		);
		expect(out).toMatchObject({
			ok: true,
			status: "approved",
			prStatus: "opened",
			prUrl: "https://github.com/o/r/pull/9",
		});
		expect(added).toHaveLength(1);
		expect(added[0]?.annotations).toMatchObject({ status: "approved", learned_at: NOW, skill_name: "lag-corr" });
		expect(added[0]?.facts[0]).toContain("Proposed skill: lag-corr - Correlate lag with downstream errors.");
		expect(added[0]?.facts[0]).toContain("Procedure: Pull both series, align, confirm the overlap holds.");
		expect(added[0]?.facts[0]).toContain("Evidence:\n- correlated kafka lag with elastic errors");
		const proposal = promote.mock.calls[0]?.[0] as { kind: string; files: Array<{ path: string; contents: string }> };
		expect(proposal.kind).toBe("new-skill");
		expect(proposal.files.map((f) => f.path)).toEqual([
			"agents/incident-analyzer/skills/lag-corr/SKILL.md",
			"agents/incident-analyzer/agent.yaml",
		]);
		expect(proposal.files[0]?.contents).toContain("status: approved");
	});

	test("approve of a runbook candidate stages markdown under its target dir", async () => {
		const { added } = await install([
			candidate({
				kind: "runbook",
				skill_name: "rds-storage-full",
				source: "fleet",
				target_dir: "agents/incident-analyzer/knowledge/aws/runbooks",
			}),
		]);
		const promote = mock(async (_proposal: unknown) => ({
			status: "opened" as const,
			url: "https://github.com/o/r/pull/10",
		}));
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "rds-storage-full", action: "approve" },
			// biome-ignore lint/suspicious/noExplicitAny: SIO-1891 - narrow test double
			{ promote: promote as any, now: () => NOW },
		);
		expect(out).toMatchObject({ ok: true, status: "approved", prStatus: "opened" });
		expect(added).toHaveLength(1);
		const proposal = promote.mock.calls[0]?.[0] as { kind: string; files: Array<{ path: string; contents: string }> };
		expect(proposal.kind).toBe("runbook");
		expect(proposal.files[0]?.path).toBe("agents/incident-analyzer/knowledge/aws/runbooks/rds-storage-full.md");
		expect(proposal.files[0]?.contents).toContain("# Rds Storage Full (DRAFT)");
		expect(proposal.files[0]?.contents).toContain("- source: fleet");
	});

	test("reject and supersede write only the transition; a terminal state refuses further actions", async () => {
		const { added } = await install([candidate()]);
		expect(
			await reviewCandidate(
				{ agent: "incident-analyzer", skillName: "lag-corr", action: "reject" },
				{ now: () => NOW },
			),
		).toEqual({
			ok: true,
			status: "rejected",
		});
		expect(added[0]?.annotations).toMatchObject({ status: "rejected", learned_at: NOW });
		expect(
			await reviewCandidate(
				{ agent: "incident-analyzer", skillName: "lag-corr", action: "supersede" },
				{ now: () => NOW },
			),
		).toMatchObject({ ok: false, code: 409 });
		expect(
			await reviewCandidate(
				{ agent: "incident-analyzer", skillName: "lag-corr", action: "supersede", supersedes: "lag-corr-v2" },
				{ now: () => NOW },
			),
		).toEqual({ ok: true, status: "superseded" });
		expect(added[1]?.annotations).toMatchObject({ status: "superseded", supersedes: "lag-corr-v2" });

		const done = await install([candidate({ status: "rejected" })]);
		expect(
			await reviewCandidate({ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" }),
		).toMatchObject({
			ok: false,
			code: 409,
		});
		expect(done.added).toHaveLength(0);
	});

	test("an unknown candidate is 404; the file backend is refused", async () => {
		await install([]);
		expect(await reviewCandidate({ agent: "incident-analyzer", skillName: "nope", action: "reject" })).toMatchObject({
			ok: false,
			code: 404,
		});
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(await reviewCandidate({ agent: "incident-analyzer", skillName: "nope", action: "reject" })).toMatchObject({
			ok: false,
			code: 409,
		});
	});

	test("a PR failure after approval reports the approval and the failed PR, never an undo", async () => {
		const { added } = await install([candidate()]);
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - x\n" }),
				promote: async () => {
					throw new Error("github down");
				},
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({ ok: true, status: "approved", prStatus: "failed" });
		expect(added).toHaveLength(1);
	});
});

describe("helpers", () => {
	test("applyEdits keeps untouched sections", () => {
		const row = rowFromHit("incident-analyzer", candidate());
		const text = applyEdits(row, { body: "New procedure text." });
		expect(text).toContain("Correlate consumer lag with error spikes.");
		expect(text).toContain("When to use: When a lag alert coincides");
		expect(text).toContain("Procedure: New procedure text.");
	});

	test("renderCandidateRunbook emits catalog-shaped frontmatter", () => {
		const row = rowFromHit("incident-analyzer", candidate({ kind: "runbook", skill_name: "db-io" }));
		const md = renderCandidateRunbook(row, TEXT);
		expect(md.startsWith("---\ntriggers:\n  metrics:\n    - db-io\n")).toBe(true);
		expect(md).toContain("## Procedure");
		expect(md).toContain("## Provenance");
	});
});
