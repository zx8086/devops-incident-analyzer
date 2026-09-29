// agent/src/learn-ingest.test.ts

// SIO-1892: candidate drafts -> candidate facts, through the same gates as the
// post-turn learner. Every dependency is injected; nothing touches a backend.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CandidateDraftSchema, ingestCandidates, redactAwsIdentifiers } from "./learn-ingest.ts";
import { parseIngestArgs } from "./learn-ingest-cli.ts";

const NOW = "2026-09-29T12:00:00Z";
const prevFlag = process.env.LEARNING_INGEST_ENABLED;
const prevBackend = process.env.LIVE_MEMORY_BACKEND;

const draft = (over: Record<string, unknown> = {}) => ({
	kind: "runbook",
	skill_name: "rds-storage-nearly-full",
	title: "Storage nearly full on orders after the nightly load.",
	applicability: "When a rds finding reports: Storage nearly full on orders after the nightly load.",
	body: "Do: Enable storage autoscaling, then purge the audit table.\nWhy: Seen 2 time(s) across 2 spoke(s).\nConfirm with: aws rds describe-db-instances",
	evidence: [{ ref: "journal:abcd1234/aws-spoke#0.0", excerpt: "aws rds describe-db-instances -> autoscaling off" }],
	source: "fleet",
	learned_from: "fleet:abcd1234/aws-spoke,ef567890/aws-spoke",
	status: "candidate",
	task_success: "1",
	task_success_source: "fleet-verdict",
	target_dir: "agents/incident-analyzer/knowledge/aws/runbooks",
	...over,
});

const applied =
	(taskSuccess: number, qualifies = true) =>
	async () => ({
		outcome: "applied" as const,
		model: "jev",
		verdict: { qualifies, score: 0.8, taskSuccess, reason: qualifies ? "qualifies" : "reusable_correction" },
	});

function harness(over: { exists?: boolean; accepted?: boolean } = {}) {
	const writes: Array<{ agent: string; text: string; annotations: Record<string, string> }> = [];
	return {
		writes,
		deps: {
			exists: async () => over.exists ?? false,
			write: async (agent: string, text: string, annotations: Record<string, string>) => {
				writes.push({ agent, text, annotations });
				return over.accepted ?? true;
			},
			now: () => NOW,
		},
	};
}

beforeEach(() => {
	delete process.env.LEARNING_INGEST_ENABLED;
	process.env.LIVE_MEMORY_BACKEND = "agent-memory";
});
afterEach(() => {
	if (prevFlag === undefined) delete process.env.LEARNING_INGEST_ENABLED;
	else process.env.LEARNING_INGEST_ENABLED = prevFlag;
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
});

describe("CandidateDraftSchema", () => {
	test("is the candidate record without the agent", () => {
		expect(CandidateDraftSchema.safeParse(draft()).success).toBe(true);
		expect(CandidateDraftSchema.safeParse(draft({ skill_name: "Bad Name" })).success).toBe(false);
		expect(CandidateDraftSchema.safeParse(draft({ evidence: [] })).success).toBe(false);
	});
});

describe("ingestCandidates", () => {
	test("stores a qualifying draft as a candidate fact under the agent with the draft's own verdict", async () => {
		const h = harness();
		const report = await ingestCandidates([draft()], "incident-analyzer", { ...h.deps, gate: applied(0.2) });
		expect(report).toEqual({ stored: ["rds-storage-nearly-full"], skipped: [] });
		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]?.agent).toBe("incident-analyzer");
		expect(h.writes[0]?.annotations).toMatchObject({
			kind: "runbook",
			skill_name: "rds-storage-nearly-full",
			status: "candidate",
			source: "fleet",
			learned_from: "fleet:abcd1234/aws-spoke,ef567890/aws-spoke",
			learned_at: NOW,
			task_success: "1",
			task_success_source: "fleet-verdict",
			target_dir: "agents/incident-analyzer/knowledge/aws/runbooks",
			evidence_count: "1",
		});
		expect(h.writes[0]?.text).toContain("Proposed skill: rds-storage-nearly-full - Storage nearly full");
		expect(h.writes[0]?.text).toContain("Evidence:\n- aws rds describe-db-instances -> autoscaling off");
	});

	test("without a draft verdict the Jev estimate seeds task_success; with neither, the draft is unevaluated and skipped", async () => {
		const h = harness();
		await ingestCandidates([draft({ task_success: "", task_success_source: "" })], "incident-analyzer", {
			...h.deps,
			gate: applied(0.9),
		});
		expect(h.writes[0]?.annotations).toMatchObject({ task_success: "1", task_success_source: "jev" });
		const skipped = harness();
		const report = await ingestCandidates([draft({ task_success: "", task_success_source: "" })], "incident-analyzer", {
			...skipped.deps,
			gate: async () => ({ outcome: "skipped" as const, reason: "no-key" as const }),
		});
		expect(skipped.writes).toHaveLength(0);
		expect(report.skipped).toEqual([{ name: "rds-storage-nearly-full", reason: "unevaluated:no-key" }]);
		// reflect's negative case is filed as it is, evaluated or not
		const rejected = harness();
		await ingestCandidates(
			[draft({ status: "rejected", task_success: "0", task_success_source: "fleet-verdict" })],
			"incident-analyzer",
			{ ...rejected.deps, gate: async () => ({ outcome: "skipped" as const, reason: "no-key" as const }) },
		);
		expect(rejected.writes[0]?.annotations).toMatchObject({ status: "rejected" });
	});

	// SIO-1896 (Codex review): the PR path must stay inside the agent's knowledge tree.
	test("a target_dir outside the agent's runbook tree, or another agent's, is refused", async () => {
		const h = harness();
		const report = await ingestCandidates(
			[
				draft({ skill_name: "escape", target_dir: "agents/incident-analyzer/skills" }),
				draft({ skill_name: "other-agent", target_dir: "agents/elastic-iac/knowledge/runbooks" }),
				draft({ skill_name: "fine", target_dir: "agents/incident-analyzer/knowledge/general/runbooks" }),
			],
			"incident-analyzer",
			{ ...h.deps, gate: applied(0.9) },
		);
		expect(report.stored).toEqual(["fine"]);
		expect(report.skipped.map((s) => s.name)).toEqual(["escape", "other-agent"]);
		expect(report.skipped[0]?.reason).toContain("runbook tree");
	});

	// Greptile PR #920: only the review pane approves; a draft's claim is not a state.
	test("a draft marked approved or superseded enters as a candidate", async () => {
		const h = harness();
		await ingestCandidates(
			[draft({ status: "approved" }), draft({ skill_name: "second", status: "superseded" })],
			"incident-analyzer",
			{
				...h.deps,
				gate: applied(0.9),
			},
		);
		expect(h.writes.map((w) => w.annotations.status)).toEqual(["candidate", "candidate"]);
	});

	// Greptile PR #920: a hand-written or reflect draft may carry AWS identifiers.
	test("AWS identifiers are redacted before the gate sees the draft and before it is stored", async () => {
		const h = harness();
		let seen: string[] = [];
		await ingestCandidates(
			[
				draft({
					title: "Fix role arn:aws:iam::111122223333:role/x in 444455556666.",
					evidence: [{ ref: "r", excerpt: "key AKIAABCDEFGHIJKLMNOP seen" }],
				}),
			],
			"incident-analyzer",
			{
				...h.deps,
				gate: async (input) => {
					seen = input.events;
					return applied(0.9)();
				},
			},
		);
		expect(seen.join("\n")).not.toMatch(/arn:aws|\b\d{12}\b|AKIA/);
		expect(h.writes[0]?.text).not.toMatch(/arn:aws|\b\d{12}\b|AKIA/);
		expect(h.writes[0]?.text).toContain("[ARN_REDACTED]");
		expect(redactAwsIdentifiers("acct 111122223333")).toBe("acct [ACCOUNT_REDACTED]");
		// Greptile PR #920 round 2: the stored annotation fields are covered as well.
		const ann = harness();
		await ingestCandidates(
			[
				draft({
					supersedes: "old-111122223333",
					evidence: [{ ref: "journal:111122223333/x#0", excerpt: "acct 444455556666 ok" }],
				}),
			],
			"incident-analyzer",
			{ ...ann.deps, gate: applied(0.9) },
		);
		expect(JSON.stringify(ann.writes[0]?.annotations)).not.toMatch(/\b\d{12}\b/);
		expect(ann.writes[0]?.text).not.toMatch(/\b\d{12}\b/);
	});

	test("skips invalid drafts, rubric failures, Jev rejections, duplicates and refused writes with the reason", async () => {
		const h = harness({ exists: true });
		const report = await ingestCandidates(
			[
				{ nonsense: true },
				draft({ skill_name: "short-body", body: "too short" }),
				draft({ skill_name: "jev-no" }),
				draft({ skill_name: "dup" }),
			],
			"incident-analyzer",
			{ ...h.deps, gate: async (input) => (input.events[0]?.includes("Storage") && false) || applied(0.9, false)() },
		);
		expect(report.stored).toEqual([]);
		expect(report.skipped.map((s) => s.reason)).toEqual([
			"invalid draft: kind",
			"rubric:body",
			"jev:reusable_correction",
			"jev:reusable_correction",
		]);
		const dup = harness({ exists: true });
		expect(
			(await ingestCandidates([draft()], "incident-analyzer", { ...dup.deps, gate: applied(0.9) })).skipped,
		).toEqual([{ name: "rds-storage-nearly-full", reason: "duplicate" }]);
		const refused = harness({ accepted: false });
		expect(
			(await ingestCandidates([draft()], "incident-analyzer", { ...refused.deps, gate: applied(0.9) })).skipped,
		).toEqual([{ name: "rds-storage-nearly-full", reason: "write not accepted" }]);
	});

	test("dry-run reports without writing; the kill-switch and the file backend refuse", async () => {
		const h = harness({ exists: true });
		const dry = await ingestCandidates([draft()], "incident-analyzer", { ...h.deps, gate: applied(0.9), dryRun: true });
		expect(dry.stored).toEqual(["rds-storage-nearly-full"]);
		expect(h.writes).toHaveLength(0);
		process.env.LEARNING_INGEST_ENABLED = "false";
		expect((await ingestCandidates([draft()], "incident-analyzer", h.deps)).skipped[0]?.reason).toContain(
			"LEARNING_INGEST_ENABLED",
		);
		delete process.env.LEARNING_INGEST_ENABLED;
		delete process.env.LIVE_MEMORY_BACKEND;
		expect((await ingestCandidates([draft()], "incident-analyzer", h.deps)).skipped[0]?.reason).toContain(
			"agent-memory",
		);
	});
});

describe("parseIngestArgs", () => {
	test("requires --file and defaults the agent", () => {
		expect(parseIngestArgs(["--file", "d.json"])).toEqual({
			file: "d.json",
			agent: "incident-analyzer",
			dryRun: false,
		});
		expect(parseIngestArgs(["--file", "d.json", "--agent", "elastic-iac", "--dry-run"])).toEqual({
			file: "d.json",
			agent: "elastic-iac",
			dryRun: true,
		});
		expect(() => parseIngestArgs([])).toThrow("--file");
	});
});
