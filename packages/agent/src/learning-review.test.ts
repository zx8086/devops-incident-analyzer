// agent/src/learning-review.test.ts

// SIO-1891: the human gate over learning candidates. Memory is the injected
// client stub; the PR opener and base-file fetch are injected deps.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realMemoryBackendNs from "./memory-backend.ts";

const realMemoryBackend = { ...realMemoryBackendNs };
mock.module("./memory-backend.ts", () => realMemoryBackend);

import {
	applyEdits,
	defaultRunbookDir,
	listReviewRows,
	neutraliseLabels,
	renderCandidateRunbook,
	reviewCandidate,
	rowFromHit,
} from "./learning-review.ts";
import { parseSkillFactBody } from "./skill-promote.ts";

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
		// Codex SIO-1896: accepted writes are visible to the next search, as the
		// real backend does, so a re-read after a transition sees it.
		async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
			const written = added.map((a) => ({ text: a.facts[0] ?? "", annotations: a.annotations ?? {} }));
			return [...hits, ...written].filter(
				(h) => !opts?.annotations?.kind || h.annotations.kind === opts.annotations.kind,
			);
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

// SIO-1896 / Greptile #924: the promotion outcome is its own kind:promotion fact.
const promotionFact = (promotion: string, url?: string, kind = "skill"): Hit => ({
	text: `Promotion outcome for ${kind} lag-corr: ${promotion}`,
	annotations: {
		kind: "promotion",
		skill_name: "lag-corr",
		target_kind: kind,
		promotion,
		...(url ? { pr_url: url } : {}),
		learned_at: "2026-09-02T00:00:00Z",
		agent: "incident-analyzer",
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
		// SIO-1896: the decision first, then the promotion outcome as its own fact.
		expect(added).toHaveLength(2);
		expect(added[1]?.annotations).toMatchObject({
			kind: "promotion",
			skill_name: "lag-corr",
			target_kind: "skill",
			promotion: "opened",
			pr_url: "https://github.com/o/r/pull/9",
		});
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
		// Greptile PR #919: the branch names the owning agent.
		expect((promote.mock.calls[0]?.[0] as { branch: string } | undefined)?.branch).toBe(
			"agent/learn/incident-analyzer/skill-lag-corr",
		);
	});

	// Greptile PR #919: an approval whose PR was skipped can be approved again to
	// retry the PR, without a second transition.
	test("re-approving an approved candidate retries the PR and writes no transition", async () => {
		const { added } = await install([candidate({ status: "approved" }), promotionFact("skipped")]);
		const promote = mock(async (_proposal: unknown) => ({
			status: "opened" as const,
			url: "https://github.com/o/r/pull/11",
		}));
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				// biome-ignore lint/suspicious/noExplicitAny: SIO-1891 - narrow test doubles
				promote: promote as any,
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - x\n" }),
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({ ok: true, status: "approved", prStatus: "opened" });
		// SIO-1896: only the promotion outcome is recorded on a retry
		expect(added).toHaveLength(1);
		expect(added[0]?.annotations).toMatchObject({ kind: "promotion", promotion: "opened" });
		expect(promote).toHaveBeenCalledTimes(1);
	});

	// SIO-1896 (Codex review): a promotion that opened is done; retrying would hit its branch.
	test("re-approving a candidate whose promotion PR opened is refused", async () => {
		const { added } = await install([
			candidate({ status: "approved" }),
			promotionFact("opened", "https://github.com/o/r/pull/9"),
		]);
		const out = await reviewCandidate({ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" });
		expect(out).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining("pull/9") });
		expect(added).toHaveLength(0);
	});

	// Codex SIO-1896: a blocked promotion fails the same way on unchanged text, and
	// an approval whose outcome was never stored is treated as done, not retried.
	test("re-approving a blocked or outcome-less approval is refused", async () => {
		for (const extra of [[promotionFact("blocked")], []]) {
			const { added } = await install([candidate({ status: "approved" }), ...extra]);
			const out = await reviewCandidate({ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" });
			expect(out).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining("already had its promotion") });
			expect(added).toHaveLength(0);
		}
	});

	// Codex SIO-1896: the PR opened but the outcome write was rejected; the reviewer
	// is told, because the row now offers no retry and a later approve is refused.
	test("a rejected promotion-outcome write is reported in the response", async () => {
		const s = await install([candidate()]);
		let writes = 0;
		s.client.addFacts = async (_ref: unknown, facts: string[], opts?: { annotations?: Record<string, string> }) => {
			writes += 1;
			if (writes > 1) return { blockIds: [], acceptedCount: 0, rejectedCount: 1 };
			s.added.push({ facts, annotations: opts?.annotations });
			return { blockIds: ["b"], acceptedCount: 1, rejectedCount: 0 };
		};
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				promote: async () => ({ status: "opened" as const, url: "https://github.com/o/r/pull/12" }),
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - x\n" }),
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({
			ok: true,
			prStatus: "opened",
			prUrl: "https://github.com/o/r/pull/12",
			prReason: expect.stringContaining("promotion outcome not stored"),
			promotionStored: false,
		});
		expect(writes).toBe(2);
	});

	// Codex SIO-1896: a skill already listed in agent.yaml fails identically on
	// every retry, so the outcome is terminal and the pane offers no retry.
	test("a skill already listed in the manifest is approved but blocked, not retryable", async () => {
		const s = await install([candidate()]);
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				promote: async () => {
					throw new Error("must not be called");
				},
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - lag-corr\n" }),
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({
			ok: true,
			status: "approved",
			prStatus: "blocked",
			prReason: expect.stringContaining("already listed"),
			promotionStored: true,
		});
		expect(s.added[1]?.annotations).toMatchObject({ kind: "promotion", promotion: "blocked" });
		// a second approve is refused: blocked is not in RETRYABLE_PROMOTIONS
		expect(
			await reviewCandidate({ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" }),
		).toMatchObject({ ok: false, code: 409 });
	});

	// Codex SIO-1896 / Greptile #924: an approval and a synchronous skipped
	// outcome can land in the same millisecond; the outcome is its own fact, so
	// the skill fact's tie rule cannot drop it and the row keeps its retry state.
	test("a synchronous skipped outcome is its own fact and survives a same-millisecond approval", async () => {
		const s = await install([candidate()]);
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				fetchBase: async () => ({ status: "skipped" as const, reason: "MEMORY_PR_ENABLED is not set" }),
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({ ok: true, prStatus: "skipped", promotionStored: true });
		expect(s.added).toHaveLength(2);
		expect(s.added[0]?.annotations).toMatchObject({ kind: "skill", status: "approved", learned_at: NOW });
		expect(s.added[1]?.annotations).toMatchObject({ kind: "promotion", promotion: "skipped", learned_at: NOW });
		const rows = await listReviewRows("incident-analyzer");
		expect(rows.find((r) => r.skillName === "lag-corr")).toMatchObject({ status: "approved", promotion: "skipped" });
	});

	// Codex SIO-1896: Agent Memory writes are async by default, so the approval
	// just written may not be searchable when the outcome is recorded; a stale
	// "candidate" read is not a concurrent decision and the outcome is stored.
	test("an approval not yet visible to search still gets its promotion outcome", async () => {
		const s = await install([candidate()]);
		s.client.searchMemory = async () => [candidate()]; // index lags every write
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				promote: async () => ({ status: "opened" as const, url: "https://github.com/o/r/pull/14" }),
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - x\n" }),
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({ ok: true, status: "approved", prStatus: "opened", promotionStored: true });
		expect(s.added).toHaveLength(2);
		expect(s.added[1]?.annotations).toMatchObject({
			kind: "promotion",
			promotion: "opened",
			pr_url: "https://github.com/o/r/pull/14",
		});
	});

	// Codex SIO-1896: a memory failure while storing the outcome is not a PR
	// failure; the PR that opened is reported with its URL and no retry is offered.
	test("an outcome write that throws after the PR opened keeps the opened result", async () => {
		const s = await install([candidate()]);
		let writes = 0;
		s.client.addFacts = async (_ref: unknown, facts: string[], opts?: { annotations?: Record<string, string> }) => {
			writes += 1;
			if (writes > 1) throw new Error("agent memory 503");
			s.added.push({ facts, annotations: opts?.annotations });
			return { blockIds: ["b"], acceptedCount: 1, rejectedCount: 0 };
		};
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				promote: async () => ({ status: "opened" as const, url: "https://github.com/o/r/pull/15" }),
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - x\n" }),
				now: () => NOW,
			},
		);
		expect(out).toMatchObject({
			ok: true,
			status: "approved",
			prStatus: "opened",
			prUrl: "https://github.com/o/r/pull/15",
			promotionStored: false,
			prReason: expect.stringContaining("promotion outcome not stored"),
		});
	});

	// Codex SIO-1896: outcomes are read per approved row, keyed by the row's own
	// kind and name; a runbook's outcome is found under target_kind "runbook".
	test("outcomes are read per approved row by kind and name, never in bulk", async () => {
		const s = await install([
			candidate({ status: "approved" }),
			candidate({ status: "approved", kind: "runbook", target_dir: "agents/incident-analyzer/knowledge/runbooks" }),
			promotionFact("failed"),
			promotionFact("opened", "https://github.com/o/r/pull/3", "runbook"),
		]);
		const seen: Array<Record<string, string> | undefined> = [];
		const base = s.client.searchMemory;
		s.client.searchMemory = async (ref: unknown, q: string, opts?: { annotations?: Record<string, string> }) => {
			seen.push(opts?.annotations);
			const a = opts?.annotations;
			const hits = await base(ref, q, opts);
			return a?.kind === "promotion" ? hits.filter((h) => h.annotations.target_kind === a.target_kind) : hits;
		};
		const rows = await listReviewRows("incident-analyzer");
		expect(rows.find((r) => r.kind === "skill")).toMatchObject({ status: "approved", promotion: "failed" });
		expect(rows.find((r) => r.kind === "runbook")).toMatchObject({
			status: "approved",
			promotion: "opened",
			prUrl: "https://github.com/o/r/pull/3",
		});
		const promotionReads = seen.filter((a) => a?.kind === "promotion");
		expect(promotionReads).toEqual(
			expect.arrayContaining([
				{ kind: "promotion", target_kind: "skill", skill_name: "lag-corr" },
				{ kind: "promotion", target_kind: "runbook", skill_name: "lag-corr" },
			]),
		);
		expect(promotionReads.every((a) => a?.skill_name)).toBe(true);
	});

	// Codex SIO-1896 / Greptile #924: a reject written while the PR call ran must
	// not be undone by the outcome. The outcome is its own fact, so the reject
	// stays the latest skill fact; the response reports the rejected status.
	test("a transition written during promotion wins; the outcome is stored beside it", async () => {
		const s = await install([candidate()]);
		const promote = async () => {
			// thumbs-down lands while the PR is being opened
			s.client.searchMemory = async () => [candidate({ status: "rejected", task_success: "0" })];
			return { status: "opened" as const, url: "https://github.com/o/r/pull/13" };
		};
		const out = await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", action: "approve" },
			{
				promote,
				fetchBase: async () => ({ status: "ok" as const, content: "name: incident-analyzer\nskills:\n  - x\n" }),
				now: () => NOW,
			},
		);
		// Greptile #924: the response carries the status the re-read found
		expect(out).toMatchObject({ ok: true, status: "rejected", prStatus: "opened", promotionStored: true });
		// the approval transition and the outcome fact; NO skill fact restores "approved"
		expect(s.added).toHaveLength(2);
		expect(s.added[0]?.annotations).toMatchObject({ kind: "skill", status: "approved" });
		expect(s.added[1]?.annotations).toMatchObject({ kind: "promotion", promotion: "opened" });
		expect(s.added.filter((a) => a.annotations?.kind === "skill")).toHaveLength(1);
	});

	test("a stale expectedStatus is refused; reject on an approved candidate is refused", async () => {
		const { added } = await install([candidate({ status: "approved" })]);
		expect(
			await reviewCandidate({
				agent: "incident-analyzer",
				skillName: "lag-corr",
				action: "reject",
				expectedStatus: "candidate",
			}),
		).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining("is now approved") });
		expect(
			await reviewCandidate({ agent: "incident-analyzer", skillName: "lag-corr", action: "reject" }),
		).toMatchObject({
			ok: false,
			code: 409,
			reason: expect.stringContaining("supersede"),
		});
		expect(added).toHaveLength(0);
	});

	test("a skill and a runbook sharing a name are both listed and addressed by kind", async () => {
		const { added } = await install([candidate(), candidate({ kind: "runbook", source: "fleet" })]);
		const rows = await listReviewRows("incident-analyzer");
		expect(rows.map((r) => r.kind)).toEqual(["skill", "runbook"]);
		await reviewCandidate(
			{ agent: "incident-analyzer", skillName: "lag-corr", kind: "runbook", action: "reject" },
			{ now: () => NOW },
		);
		expect(added[0]?.annotations).toMatchObject({ kind: "runbook", status: "rejected" });
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
		// SIO-1896: decision first, then the promotion outcome as its own fact
		expect(added).toHaveLength(2);
		expect(added[1]?.annotations).toMatchObject({ kind: "promotion", target_kind: "runbook", promotion: "opened" });
		const proposal = promote.mock.calls[0]?.[0] as { kind: string; files: Array<{ path: string; contents: string }> };
		expect(proposal.kind).toBe("runbook");
		expect(proposal.files[0]?.path).toBe("agents/incident-analyzer/knowledge/aws/runbooks/rds-storage-full.md");
		expect((promote.mock.calls[0]?.[0] as { branch: string } | undefined)?.branch).toBe(
			"agent/learn/incident-analyzer/runbook-rds-storage-full",
		);
		expect(proposal.files[0]?.contents).toContain("# Rds Storage Full (DRAFT)");
		expect(proposal.files[0]?.contents).toContain("- source: fleet");
	});

	// SIO-1896 (Codex review): a stored target_dir outside the agent's tree never becomes a PR path.
	test("approve refuses a runbook whose target_dir is outside the agent's runbook tree", async () => {
		const { added } = await install([
			candidate({ kind: "runbook", skill_name: "escape", target_dir: "agents/incident-analyzer/skills" }),
		]);
		const out = await reviewCandidate({
			agent: "incident-analyzer",
			skillName: "escape",
			kind: "runbook",
			action: "approve",
		});
		expect(out).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining("runbook tree") });
		expect(added).toHaveLength(0);
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
		// a rejected row is terminal: supersede is refused (the stub surfaces the write)
		expect(
			await reviewCandidate(
				{ agent: "incident-analyzer", skillName: "lag-corr", action: "supersede", supersedes: "lag-corr-v2" },
				{ now: () => NOW },
			),
		).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining("already rejected") });
		expect(added).toHaveLength(1);

		const fresh = await install([candidate()]);
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
		expect(fresh.added).toHaveLength(1);
		expect(fresh.added[0]?.annotations).toMatchObject({ status: "superseded", supersedes: "lag-corr-v2" });

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
		expect(added).toHaveLength(2);
		expect(added[1]?.annotations).toMatchObject({ kind: "promotion", promotion: "failed" });
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

	test("defaultRunbookDir follows the owning agent", () => {
		expect(defaultRunbookDir("incident-analyzer")).toBe("agents/incident-analyzer/knowledge/general/runbooks");
		expect(defaultRunbookDir("elastic-iac")).toBe("agents/elastic-iac/knowledge/runbooks");
	});

	test("a reviewer's line that starts with a section label survives the round trip", () => {
		const row = rowFromHit("incident-analyzer", candidate());
		const text = applyEdits(row, { body: "First step.\nProcedure: not a new section\nEvidence: nor this" });
		expect(neutraliseLabels("Procedure: x")).toBe(" Procedure: x");
		const parsed = parseSkillFactBody(text);
		expect(parsed.procedure).toContain("not a new section");
		expect(parsed.procedure).toContain("nor this");
		expect(parsed.evidence).toEqual(["correlated kafka lag with elastic errors"]);
	});

	test("renderCandidateRunbook emits catalog-shaped frontmatter", () => {
		const row = rowFromHit("incident-analyzer", candidate({ kind: "runbook", skill_name: "db-io" }));
		const md = renderCandidateRunbook(row, TEXT);
		expect(md.startsWith("---\ntriggers:\n  metrics:\n    - db-io\n")).toBe(true);
		expect(md).toContain("## Procedure");
		expect(md).toContain("## Provenance");
	});
});
