# Git-Native Skill Promotion (SIO-1345, Option 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the manual two-step skill promotion (run CLI, hand-paste a line into agent.yaml) into a one-command git-native flow: the CLI renders the SKILL.md, registers it in agent.yaml, and opens a ready-for-review PR — the human merge IS the review gate. Also closes the discovery gap with a `--list` mode.

**Architecture:** Extends the existing SIO-1017 promote CLI (`skill-promote-cli.ts`) with three modes: default (unchanged draft+hint), `--list` (enumerate pending `kind:skill` proposals with promotion status), and `--pr` (branch + SKILL.md + agent.yaml edit + commit + push + `gh pr create`, then return to the original branch). All new logic lives in pure, unit-tested functions; git/gh I/O goes through an injectable runner. This aligns step 04 of the gitagent.sh skill-learning workflow (automatic crystallization into a real skill) while preserving the human-review boundary on `agent.yaml` (merge = approval), matching the repo's "agent proposes, GitOps disposes" philosophy.

**Tech Stack:** Bun, TypeScript strict, Zod (existing schemas), `yaml` package (read-only parse; edits are line-based to preserve comments), `Bun.spawnSync` for git/gh, bun:test.

## Global Constraints

- TypeScript strict, never `any` (biome `noExplicitAny: "error"`).
- No emojis anywhere.
- File headers: single-line relative path comment only.
- Named exports. Zod for runtime validation.
- The proposal fact funnel (`learnFromTurn`, gates, judge) is correct — do not touch it.
- Do NOT parse+stringify `agent.yaml` for edits — comments/formatting must survive byte-for-byte outside the inserted line.
- `agent.yaml` skills lists exist in two GAP dialects: `- name` (incident-analyzer) and `- id: name` (elastic-iac). Both must be handled for read AND write.
- Out of scope (do not build): per-turn applied-skills trace (spec step 06 wiring), skill search/matching at task time (spec step 05), `negative_examples` population, auto-PR from the AgentCore runtime.
- Commit format `SIO-1345: <message>`; PR ready-for-review, never draft.

## File Structure

- Create `packages/agent/src/skill-manifest.ts` — pure `manifestHasSkill` / `addSkillToManifest` (YAML-parse read, line-based edit).
- Create `packages/agent/src/skill-manifest.test.ts`
- Create `packages/agent/src/skill-promote-git.ts` — pure builders (branch name, commit message, PR title/body) + `GitRunner` interface + `runPromotion` orchestration + `spawnRunner` (Bun.spawnSync). Imported lazily by the CLI only.
- Create `packages/agent/src/skill-promote-git.test.ts` — fake-runner tests, no real git.
- Create `packages/agent/src/skill-promote-load.test.ts` — end-to-end structural: rendered skill + manifest edit in a temp dir loads via `loadAgent`.
- Modify `packages/agent/src/skill-learner.ts` — add `summarizeSkillProposalHits` (pure) + `listSkillProposals` (thin I/O).
- Modify `packages/agent/src/skill-learner.test.ts` — tests for the pure summarizer.
- Modify `packages/agent/src/skill-promote.ts` — `renderSkillMarkdown` gains `opts?: { mode?: "draft" | "pr" }`.
- Modify `packages/agent/src/skill-promote.test.ts` — PR-mode banner tests.
- Modify `packages/agent/src/skill-promote-cli.ts` — `--list` / `--pr` / `--ticket` flags, stale `--add-to-manifest` header comment removed, mode dispatch in `main()`.
- Modify `packages/agent/src/skill-promote-cli.test.ts` — new arg-parsing tests.

---

### Task 1: `listSkillProposals` discovery query

**Files:**
- Modify: `packages/agent/src/skill-learner.ts` (after `skillProposalExists`, ~line 144)
- Test: `packages/agent/src/skill-learner.test.ts`

**Interfaces:**
- Consumes: `searchAgentMemory(agent, "", {kind:"skill"}, 8, {deterministic:true})` from `./memory-backend.ts` (deterministic mode = filter-only, no top-k truncation; `limit` is ignored) and `MemorySearchHit { text: string; annotations: AnnotationMap }`.
- Produces: `interface SkillProposalSummary { name: string; category: string; learnedAt: string; learnedFrom: string; text: string }`, `summarizeSkillProposalHits(hits: MemorySearchHit[]): SkillProposalSummary[]`, `listSkillProposals(agentName?: string): Promise<SkillProposalSummary[]>`. Task 5's CLI consumes both.

- [ ] **Step 1: Write the failing tests** (append a new `describe` to `skill-learner.test.ts`; the file already owns the memory-backend mock — the pure summarizer needs none of it)

```ts
describe("summarizeSkillProposalHits (SIO-1345)", () => {
	test("maps annotations to summaries and drops nameless hits", () => {
		const hits = [
			{
				text: "Proposed skill: lag-correlation - correlate lag with errors",
				annotations: {
					kind: "skill",
					skill_name: "lag-correlation",
					task_category: "lag-correlation",
					learned_at: "2026-07-30T10:00:00Z",
					learned_from: "thread:t1",
				},
			},
			{ text: "malformed, no name", annotations: { kind: "skill" } },
		];
		const out = summarizeSkillProposalHits(hits);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({
			name: "lag-correlation",
			category: "lag-correlation",
			learnedAt: "2026-07-30T10:00:00Z",
			learnedFrom: "thread:t1",
			text: "Proposed skill: lag-correlation - correlate lag with errors",
		});
	});

	test("tolerates absent optional annotations", () => {
		const out = summarizeSkillProposalHits([{ text: "body", annotations: { skill_name: "thin" } }]);
		expect(out[0]).toEqual({ name: "thin", category: "", learnedAt: "", learnedFrom: "", text: "body" });
	});
});
```

Add `summarizeSkillProposalHits` to the import list from `./skill-learner.ts` at the top of the file.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/skill-learner.test.ts`
Expected: FAIL — `summarizeSkillProposalHits` is not exported.

- [ ] **Step 3: Implement** (in `skill-learner.ts`, directly below `skillProposalExists`)

```ts
// SIO-1345: discovery for the promotion flow. Deterministic filter-only listing of
// every kind:skill proposal fact for an agent (the same retrieval mode
// skillProposalExists uses, without the name filter). The pure summarizer is split
// out so it is testable without the backend.
export interface SkillProposalSummary {
	name: string;
	category: string;
	learnedAt: string;
	learnedFrom: string;
	text: string;
}

export function summarizeSkillProposalHits(
	hits: Array<{ text: string; annotations: Record<string, string | undefined> }>,
): SkillProposalSummary[] {
	return hits
		.map((h) => ({
			name: h.annotations.skill_name ?? "",
			category: h.annotations.task_category ?? "",
			learnedAt: h.annotations.learned_at ?? "",
			learnedFrom: h.annotations.learned_from ?? "",
			text: h.text,
		}))
		.filter((p) => p.name !== "");
}

export async function listSkillProposals(agentName: string = LEARNER_AGENT): Promise<SkillProposalSummary[]> {
	const hits = await searchAgentMemory(agentName, "", { kind: "skill" }, 8, { deterministic: true });
	return summarizeSkillProposalHits(hits);
}
```

Note the parameter type of `summarizeSkillProposalHits` is structural (`{ text; annotations }`) rather than `MemorySearchHit` so tests never import memory-backend types; `MemorySearchHit` satisfies it (`AnnotationMap` is `Record<string, string>`-shaped).

- [ ] **Step 4: Run tests**

Run: `bun test packages/agent/src/skill-learner.test.ts`
Expected: PASS (all pre-existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/skill-learner.ts packages/agent/src/skill-learner.test.ts
git commit -m "SIO-1345: add listSkillProposals discovery query"
```

---

### Task 2: manifest read/edit helpers (`skill-manifest.ts`)

**Files:**
- Create: `packages/agent/src/skill-manifest.ts`
- Test: `packages/agent/src/skill-manifest.test.ts`

**Interfaces:**
- Consumes: `parse` from `yaml` (read path only).
- Produces: `manifestHasSkill(yamlText: string, skillName: string): boolean`, `addSkillToManifest(yamlText: string, skillName: string): { content: string; changed: boolean }`. Task 5's CLI consumes both; `addSkillToManifest` THROWS when there is no top-level `skills:` key.

- [ ] **Step 1: Write the failing tests**

```ts
// agent/src/skill-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { addSkillToManifest, manifestHasSkill } from "./skill-manifest.ts";

const PLAIN = `name: incident-analyzer
version: "1.0.0"
description: test

# hand-curated list
skills:
  - normalize-incident
  - aggregate-findings

tools:
  - elastic-logs
`;

const ID_DIALECT = `name: elastic-iac
version: "1.0.0"
description: test
skills:
  - id: version-upgrade
  - id: resize-tier
tools: []
`;

describe("manifestHasSkill (SIO-1345)", () => {
	test("finds plain-dialect entries", () => {
		expect(manifestHasSkill(PLAIN, "normalize-incident")).toBe(true);
		expect(manifestHasSkill(PLAIN, "missing")).toBe(false);
	});
	test("finds id-dialect entries", () => {
		expect(manifestHasSkill(ID_DIALECT, "resize-tier")).toBe(true);
		expect(manifestHasSkill(ID_DIALECT, "missing")).toBe(false);
	});
	test("false on unparseable or listless yaml", () => {
		expect(manifestHasSkill("not: [valid", "x")).toBe(false);
		expect(manifestHasSkill("name: a\n", "x")).toBe(false);
	});
});

describe("addSkillToManifest (SIO-1345)", () => {
	test("appends to a plain-dialect block, preserving everything else byte-for-byte", () => {
		const { content, changed } = addSkillToManifest(PLAIN, "lag-correlation");
		expect(changed).toBe(true);
		expect(content).toBe(PLAIN.replace("  - aggregate-findings\n", "  - aggregate-findings\n  - lag-correlation\n"));
	});
	test("appends in id dialect when the block uses id entries", () => {
		const { content } = addSkillToManifest(ID_DIALECT, "new-skill");
		expect(content).toContain("  - id: resize-tier\n  - id: new-skill\n");
	});
	test("idempotent when the skill is already listed", () => {
		const { content, changed } = addSkillToManifest(PLAIN, "aggregate-findings");
		expect(changed).toBe(false);
		expect(content).toBe(PLAIN);
	});
	test("inserts right after the header when the block is empty", () => {
		const empty = "name: a\nversion: \"1\"\ndescription: d\nskills:\ntools: []\n";
		const { content } = addSkillToManifest(empty, "first");
		expect(content).toContain("skills:\n  - first\ntools: []");
	});
	test("throws when there is no skills key", () => {
		expect(() => addSkillToManifest("name: a\nversion: \"1\"\ndescription: d\n", "x")).toThrow(/skills/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/skill-manifest.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// agent/src/skill-manifest.ts
//
// SIO-1345: read/edit helpers for an agent.yaml `skills:` list. The READ uses a real
// YAML parse so both GAP dialects (`- name` and `- id: name`) are recognized; the
// EDIT is line-based (never parse+stringify) so comments and formatting elsewhere in
// the hand-curated manifest survive byte-for-byte.

import { parse } from "yaml";

export interface ManifestEdit {
	content: string;
	changed: boolean;
}

export function manifestHasSkill(yamlText: string, skillName: string): boolean {
	let doc: unknown;
	try {
		doc = parse(yamlText);
	} catch {
		return false;
	}
	if (typeof doc !== "object" || doc === null) return false;
	const skills = (doc as Record<string, unknown>).skills;
	if (!Array.isArray(skills)) return false;
	return skills.some((entry) =>
		typeof entry === "string"
			? entry === skillName
			: typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).id === skillName,
	);
}

// Insert skillName at the end of the `skills:` block, matching the block's existing
// dialect and indentation. Idempotent. Throws when the manifest has no top-level
// `skills:` key -- the caller must not guess where the list belongs.
export function addSkillToManifest(yamlText: string, skillName: string): ManifestEdit {
	if (manifestHasSkill(yamlText, skillName)) return { content: yamlText, changed: false };
	const lines = yamlText.split("\n");
	const headerIdx = lines.findIndex((line) => /^skills:\s*(#.*)?$/.test(line));
	if (headerIdx === -1) {
		throw new Error("agent.yaml has no top-level `skills:` list; add the skill entry by hand");
	}
	let lastEntryIdx = headerIdx;
	let indent = "  ";
	let dialect: "plain" | "id" = "plain";
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const m = lines[i]?.match(/^(\s+)-\s+(.*)$/);
		if (!m) break;
		lastEntryIdx = i;
		indent = m[1] ?? "  ";
		if (/^id:\s/.test(m[2] ?? "")) dialect = "id";
	}
	const entry = dialect === "id" ? `${indent}- id: ${skillName}` : `${indent}- ${skillName}`;
	lines.splice(lastEntryIdx + 1, 0, entry);
	return { content: lines.join("\n"), changed: true };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/agent/src/skill-manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/skill-manifest.ts packages/agent/src/skill-manifest.test.ts
git commit -m "SIO-1345: add comment-preserving agent.yaml skills-list editor"
```

---

### Task 3: PR-mode rendering in `skill-promote.ts`

**Files:**
- Modify: `packages/agent/src/skill-promote.ts` (the `DRAFT_BANNER` const at ~line 99 and `renderSkillMarkdown` at ~line 107)
- Test: `packages/agent/src/skill-promote.test.ts`

**Interfaces:**
- Produces: `renderSkillMarkdown(input: SkillScaffoldInput, opts?: { mode?: "draft" | "pr" })` — default `"draft"` keeps today's output byte-identical. Task 5 and Task 6 consume `mode: "pr"`.

- [ ] **Step 1: Write the failing tests** (append to `skill-promote.test.ts`)

```ts
describe("renderSkillMarkdown pr mode (SIO-1345)", () => {
	const input = {
		annotations: { skill_name: "lag-correlation", confidence: "0.5" },
		body: "Proposed skill: lag-correlation - correlate lag\nProcedure: check lag then errors",
	};
	test("default mode keeps the DRAFT banner", () => {
		expect(renderSkillMarkdown(input)).toContain("# DRAFT");
	});
	test("pr mode swaps in the merge-activation banner", () => {
		const md = renderSkillMarkdown(input, { mode: "pr" });
		expect(md).toContain("activates on merge");
		expect(md).not.toContain("# DRAFT");
	});
	test("frontmatter is identical across modes", () => {
		const fm = (s: string) => s.split("---")[1];
		expect(fm(renderSkillMarkdown(input, { mode: "pr" }))).toBe(fm(renderSkillMarkdown(input)));
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/skill-promote.test.ts`
Expected: FAIL — second argument not accepted / banner assertions fail.

- [ ] **Step 3: Implement** (below `DRAFT_BANNER`; change `renderSkillMarkdown` signature)

```ts
// SIO-1345: the --pr flow registers the skill in agent.yaml on the same branch, so
// the "not loaded until you edit agent.yaml" draft language would be wrong there.
const PR_BANNER = `# Learned skill -- activates on merge

> Scaffolded from a learned kind:skill proposal (SIO-1345 git-native promotion).
> This branch also registers the skill under \`skills:\` in agent.yaml, so merging
> this PR makes the skill live in the agent's prompt. Review the procedure and
> verify any tool names it references exist for this agent before merging.`;

export type PromoteRenderMode = "draft" | "pr";

export function renderSkillMarkdown(input: SkillScaffoldInput, opts?: { mode?: PromoteRenderMode }): string {
	const parsed = parseSkillFactBody(input.body);
	const frontmatter = buildSkillFrontmatter(input.annotations, {
		...(parsed.description ? { description: parsed.description } : {}),
	});
	const yaml = stringify(frontmatter).trimEnd();
	const banner = (opts?.mode ?? "draft") === "pr" ? PR_BANNER : DRAFT_BANNER;
	const sections = [`---\n${yaml}\n---`, "", banner];
	if (parsed.whenToUse) sections.push("", "## When to use", "", parsed.whenToUse);
	sections.push("", "## Procedure", "", parsed.procedure, "");
	return sections.join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/agent/src/skill-promote.test.ts`
Expected: PASS (pre-existing draft-mode tests unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/skill-promote.ts packages/agent/src/skill-promote.test.ts
git commit -m "SIO-1345: add pr render mode with merge-activation banner"
```

---

### Task 4: git/gh mechanics (`skill-promote-git.ts`)

**Files:**
- Create: `packages/agent/src/skill-promote-git.ts`
- Test: `packages/agent/src/skill-promote-git.test.ts`

**Interfaces:**
- Produces (Task 5 consumes all of these):
  - `interface GitRunner { run(argv: string[]): { ok: boolean; stdout: string; stderr: string } }`
  - `spawnRunner(cwd: string): GitRunner` (Bun.spawnSync)
  - `promotionBranchName(agent: string, skill: string): string` → `skill/<agent>/<skill>`
  - `promotionCommitMessage(i: { agent: string; skill: string; ticket?: string }): string`
  - `buildPrTitle(agent: string, skill: string): string`
  - `buildPrBody(i: { agent: string; skill: string; annotations: Record<string, string | undefined> }): string`
  - `interface PromotionResult { branch: string; prUrl?: string; manualSteps: string[] }`
  - `runPromotion(runner: GitRunner, input: PromotionInput, writeFiles: () => void): PromotionResult` where `interface PromotionInput { agent: string; skill: string; skillFile: string; manifestFile: string; ticket?: string; annotations: Record<string, string | undefined> }`

Semantics `runPromotion` MUST implement, in order:
1. `git status --porcelain` — non-empty stdout → throw `"working tree not clean; commit or stash first"`.
2. `git rev-parse --abbrev-ref HEAD` — capture the original branch.
3. `git checkout -b <branch>` — throw on failure (branch may already exist; the error surfaces git's message).
4. `writeFiles()` (the CLI writes SKILL.md + agent.yaml here).
5. `git add <skillFile> <manifestFile>`; `git commit -m <msg>`; `git push -u origin <branch>` — any failure throws with the failed argv + stderr (no auto-rollback; the human sees the branch state).
6. `gh pr create --title <t> --body <b> --head <branch>` — on failure do NOT throw; push already succeeded, so record the exact command in `manualSteps` and continue. On success capture the PR URL from stdout.
7. `git checkout <original branch>` — on failure append a manual step instead of throwing.

- [ ] **Step 1: Write the failing tests** (fake runner; no real git)

```ts
// agent/src/skill-promote-git.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildPrBody,
	buildPrTitle,
	type GitRunner,
	promotionBranchName,
	promotionCommitMessage,
	runPromotion,
} from "./skill-promote-git.ts";

function fakeRunner(overrides: Record<string, { ok: boolean; stdout?: string; stderr?: string }> = {}) {
	const calls: string[][] = [];
	const runner: GitRunner = {
		run(argv) {
			calls.push(argv);
			const key = argv.slice(0, 3).join(" ");
			const hit = Object.entries(overrides).find(([k]) => key.startsWith(k))?.[1];
			return { ok: hit?.ok ?? true, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
		},
	};
	return { runner, calls };
}

const INPUT = {
	agent: "incident-analyzer",
	skill: "lag-correlation",
	skillFile: "/repo/agents/incident-analyzer/skills/lag-correlation/SKILL.md",
	manifestFile: "/repo/agents/incident-analyzer/agent.yaml",
	annotations: { learned_from: "thread:t1", learned_at: "2026-07-30T10:00:00Z", task_category: "lag-correlation" },
};

describe("pure builders (SIO-1345)", () => {
	test("branch, commit message, title", () => {
		expect(promotionBranchName("incident-analyzer", "lag-correlation")).toBe("skill/incident-analyzer/lag-correlation");
		expect(promotionCommitMessage({ agent: "a", skill: "s" })).toBe("promote learned skill s (a)");
		expect(promotionCommitMessage({ agent: "a", skill: "s", ticket: "SIO-9" })).toBe("SIO-9: promote learned skill s (a)");
		expect(buildPrTitle("a", "s")).toBe("Promote learned skill: s (a)");
	});
	test("pr body carries provenance and the merge-activates note", () => {
		const body = buildPrBody(INPUT);
		expect(body).toContain("thread:t1");
		expect(body).toContain("2026-07-30T10:00:00Z");
		expect(body).toContain("Merging this PR activates the skill");
	});
});

describe("runPromotion (SIO-1345)", () => {
	test("happy path: status, branch off, write, add/commit/push, pr, return", () => {
		const { runner, calls } = fakeRunner({
			"git rev-parse --abbrev-ref": { ok: true, stdout: "main\n" },
			"gh pr create": { ok: true, stdout: "https://github.com/o/r/pull/1\n" },
		});
		let wrote = false;
		const result = runPromotion(runner, INPUT, () => {
			wrote = true;
		});
		expect(wrote).toBe(true);
		expect(result.branch).toBe("skill/incident-analyzer/lag-correlation");
		expect(result.prUrl).toBe("https://github.com/o/r/pull/1");
		expect(result.manualSteps).toEqual([]);
		expect(calls[0]).toEqual(["git", "status", "--porcelain"]);
		expect(calls.at(-1)).toEqual(["git", "checkout", "main"]);
	});
	test("dirty tree aborts before any branch is created", () => {
		const { runner, calls } = fakeRunner({ "git status --porcelain": { ok: true, stdout: " M x.ts\n" } });
		expect(() => runPromotion(runner, INPUT, () => {})).toThrow(/not clean/);
		expect(calls).toHaveLength(1);
	});
	test("gh failure degrades to a manual step instead of throwing", () => {
		const { runner } = fakeRunner({
			"git rev-parse --abbrev-ref": { ok: true, stdout: "main\n" },
			"gh pr create": { ok: false, stderr: "gh: not logged in" },
		});
		const result = runPromotion(runner, INPUT, () => {});
		expect(result.prUrl).toBeUndefined();
		expect(result.manualSteps.join(" ")).toContain("gh pr create");
	});
	test("commit failure throws with the failing argv", () => {
		const { runner } = fakeRunner({
			"git rev-parse --abbrev-ref": { ok: true, stdout: "main\n" },
			"git commit -m": { ok: false, stderr: "hook rejected" },
		});
		expect(() => runPromotion(runner, INPUT, () => {})).toThrow(/git commit/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/skill-promote-git.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// agent/src/skill-promote-git.ts
//
// SIO-1345: git/gh mechanics for the --pr promotion flow. Pure builders are unit-
// tested with a fake runner; spawnRunner is the only real-process seam. Imported
// LAZILY by skill-promote-cli.ts main() only -- never from graph/runtime code.

export interface GitRunner {
	run(argv: string[]): { ok: boolean; stdout: string; stderr: string };
}

export function spawnRunner(cwd: string): GitRunner {
	return {
		run(argv) {
			const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
			return {
				ok: proc.exitCode === 0,
				stdout: proc.stdout.toString(),
				stderr: proc.stderr.toString(),
			};
		},
	};
}

export function promotionBranchName(agent: string, skill: string): string {
	return `skill/${agent}/${skill}`;
}

export function promotionCommitMessage(input: { agent: string; skill: string; ticket?: string }): string {
	const prefix = input.ticket ? `${input.ticket}: ` : "";
	return `${prefix}promote learned skill ${input.skill} (${input.agent})`;
}

export function buildPrTitle(agent: string, skill: string): string {
	return `Promote learned skill: ${skill} (${agent})`;
}

export function buildPrBody(input: {
	agent: string;
	skill: string;
	annotations: Record<string, string | undefined>;
}): string {
	const a = input.annotations;
	return [
		`Promotes the learned kind:skill proposal \`${input.skill}\` for \`${input.agent}\` (SIO-1345 git-native promotion; merge = approval).`,
		"",
		`- learned_from: ${a.learned_from ?? "unknown"}`,
		`- learned_at: ${a.learned_at ?? "unknown"}`,
		`- task_category: ${a.task_category ?? "unknown"}`,
		"",
		"Review checklist:",
		"- [ ] Procedure is correct and generalizable (not incident-specific)",
		"- [ ] Tool names referenced by the skill exist for this agent (see docs/development/action-tool-maps.md)",
		"- [ ] Frontmatter counters look sane (fresh promotion seeds confidence 0.5, counts 0)",
		"- [ ] agent.yaml gained exactly one skills entry",
		"",
		"Merging this PR activates the skill in the agent prompt. Closing it declines the proposal (the durable fact remains for future reference).",
	].join("\n");
}

export interface PromotionInput {
	agent: string;
	skill: string;
	skillFile: string;
	manifestFile: string;
	ticket?: string;
	annotations: Record<string, string | undefined>;
}

export interface PromotionResult {
	branch: string;
	prUrl?: string;
	manualSteps: string[];
}

function must(runner: GitRunner, argv: string[]): string {
	const r = runner.run(argv);
	if (!r.ok) throw new Error(`${argv.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout;
}

export function runPromotion(runner: GitRunner, input: PromotionInput, writeFiles: () => void): PromotionResult {
	const status = must(runner, ["git", "status", "--porcelain"]);
	if (status.trim() !== "") throw new Error("working tree not clean; commit or stash first");

	const original = must(runner, ["git", "rev-parse", "--abbrev-ref", "HEAD"]).trim();
	const branch = promotionBranchName(input.agent, input.skill);
	must(runner, ["git", "checkout", "-b", branch]);

	writeFiles();

	must(runner, ["git", "add", input.skillFile, input.manifestFile]);
	must(runner, ["git", "commit", "-m", promotionCommitMessage(input)]);
	must(runner, ["git", "push", "-u", "origin", branch]);

	const manualSteps: string[] = [];
	const title = buildPrTitle(input.agent, input.skill);
	const body = buildPrBody(input);
	const pr = runner.run(["gh", "pr", "create", "--title", title, "--body", body, "--head", branch]);
	let prUrl: string | undefined;
	if (pr.ok) {
		prUrl = pr.stdout.trim().split("\n").at(-1);
	} else {
		manualSteps.push(`gh pr create --title ${JSON.stringify(title)} --head ${branch} --body-file <body.md>`);
	}

	const back = runner.run(["git", "checkout", original]);
	if (!back.ok) manualSteps.push(`git checkout ${original}`);

	return { branch, ...(prUrl ? { prUrl } : {}), manualSteps };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/agent/src/skill-promote-git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/skill-promote-git.ts packages/agent/src/skill-promote-git.test.ts
git commit -m "SIO-1345: add injectable git/gh promotion runner"
```

---

### Task 5: CLI wiring (`--list`, `--pr`, `--ticket`)

**Files:**
- Modify: `packages/agent/src/skill-promote-cli.ts` (header comment, `PromoteArgs`, `parsePromoteArgs`, `main`)
- Test: `packages/agent/src/skill-promote-cli.test.ts`

**Interfaces:**
- Consumes: `listSkillProposals` (Task 1), `manifestHasSkill`/`addSkillToManifest` (Task 2), `renderSkillMarkdown(..., { mode: "pr" })` (Task 3), `spawnRunner`/`runPromotion` (Task 4), existing `skillFilePath`/`getWorkspaceRoot`/`getAgentsDir` from `./paths.ts`.
- Produces: `PromoteArgs` becomes `{ agent: string; skill?: string; force: boolean; list: boolean; pr: boolean; ticket?: string }`; `--skill` is required unless `--list`.

- [ ] **Step 1: Write the failing arg tests** (append to `skill-promote-cli.test.ts`)

```ts
describe("parsePromoteArgs modes (SIO-1345)", () => {
	test("--list needs no --skill", () => {
		const args = parsePromoteArgs(["--list"]);
		expect(args.list).toBe(true);
		expect(args.skill).toBeUndefined();
	});
	test("--pr with --ticket", () => {
		const args = parsePromoteArgs(["--skill", "s", "--pr", "--ticket", "SIO-1345"]);
		expect(args.pr).toBe(true);
		expect(args.ticket).toBe("SIO-1345");
	});
	test("still throws without --skill in promote modes", () => {
		expect(() => parsePromoteArgs(["--pr"])).toThrow(/--skill/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/agent/src/skill-promote-cli.test.ts`
Expected: FAIL — unknown options.

- [ ] **Step 3: Implement.** Replace the stale header (which describes a never-implemented `--add-to-manifest` flag) and extend parsing + main:

Header comment becomes:

```ts
#!/usr/bin/env bun
// agent/src/skill-promote-cli.ts
//
// SIO-1017 + SIO-1345: CLI over kind:skill proposal facts. Three modes:
//   --list             enumerate pending proposals with promotion status
//   --skill <name>     scaffold a local SKILL.md DRAFT + print the agent.yaml hint
//   --skill <n> --pr   git-native promotion: branch + SKILL.md + agent.yaml edit +
//                      commit + push + ready-for-review PR (merge = approval gate)
//
//   bun run --filter @devops-agent/agent skill:promote -- [--list] [--skill <n>]
//     [--agent <a>] [--force] [--pr] [--ticket SIO-XXXX]
//
// The pure helpers (parsePromoteArgs, skillFilePath) are exported + unit-tested;
// main() is guarded by import.meta.main so importing this module is side-effect free.
// Default mode never edits agent.yaml (propose-only posture); --pr edits it ON A
// BRANCH so the human review boundary moves to the PR merge, not the local file.
```

`PromoteArgs` + parser:

```ts
export interface PromoteArgs {
	agent: string;
	skill?: string;
	force: boolean;
	list: boolean;
	pr: boolean;
	ticket?: string;
}

export function parsePromoteArgs(argv: string[]): PromoteArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			agent: { type: "string" },
			skill: { type: "string" },
			force: { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			pr: { type: "boolean", default: false },
			ticket: { type: "string" },
		},
		allowPositionals: false,
	});
	if (!values.list && !values.skill) throw new Error("missing required --skill <skill_name> (or use --list)");
	return {
		agent: values.agent ?? DEFAULT_AGENT,
		...(values.skill ? { skill: values.skill } : {}),
		force: values.force ?? false,
		list: values.list ?? false,
		pr: values.pr ?? false,
		...(values.ticket ? { ticket: values.ticket } : {}),
	};
}
```

`main()` dispatch (backend guard stays first, unchanged). List mode:

```ts
	if (args.list) {
		const { listSkillProposals } = await import("./skill-learner.ts");
		const { manifestHasSkill } = await import("./skill-manifest.ts");
		const proposals = await listSkillProposals(args.agent);
		if (proposals.length === 0) {
			console.log(`No kind:skill proposals found for agent ${args.agent}.`);
			return;
		}
		const manifestText = readFileSync(join(getAgentsDir(args.agent), "agent.yaml"), "utf8");
		for (const p of proposals) {
			const fileExists = existsSync(skillFilePath(getWorkspaceRoot(), args.agent, p.name));
			const inManifest = manifestHasSkill(manifestText, p.name);
			const status = fileExists && inManifest ? "promoted" : fileExists ? "drafted" : inManifest ? "broken" : "pending";
			console.log(`${status.padEnd(9)} ${p.name}  [${p.category}]  learned ${p.learnedAt} from ${p.learnedFrom}`);
		}
		console.log("\nPromote one with: --skill <name> --pr");
		return;
	}
```

(`readFileSync`/`join`/`getAgentsDir` join the existing imports; `args.skill` is defined past this point — narrow with `const skill = args.skill;` + `if (!skill) throw ...` to satisfy strict mode.)

PR mode replaces the plain write when `args.pr` (after the existing fact lookup + existing-file guard, which both stay):

```ts
	const markdown = renderSkillMarkdown({ annotations: hit.annotations, body: hit.text }, { mode: args.pr ? "pr" : "draft" });

	if (!args.pr) {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, markdown, "utf8");
		console.log(`Wrote DRAFT skill: ${filePath}`);
		console.log(manifestHint(args.agent, skill));
		console.log("Review the DRAFT banner and procedure before relying on this skill.");
		return;
	}

	const { addSkillToManifest } = await import("./skill-manifest.ts");
	const { runPromotion, spawnRunner } = await import("./skill-promote-git.ts");
	const manifestFile = join(getAgentsDir(args.agent), "agent.yaml");
	const result = runPromotion(
		spawnRunner(getWorkspaceRoot()),
		{
			agent: args.agent,
			skill,
			skillFile: filePath,
			manifestFile,
			...(args.ticket ? { ticket: args.ticket } : {}),
			annotations: hit.annotations,
		},
		() => {
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, markdown, "utf8");
			const edited = addSkillToManifest(readFileSync(manifestFile, "utf8"), skill);
			if (edited.changed) writeFileSync(manifestFile, edited.content, "utf8");
		},
	);
	console.log(`Promotion branch pushed: ${result.branch}`);
	if (result.prUrl) console.log(`PR (ready for review; merging activates the skill): ${result.prUrl}`);
	for (const step of result.manualSteps) console.log(`MANUAL STEP NEEDED: ${step}`);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test packages/agent/src/skill-promote-cli.test.ts && bun run --filter @devops-agent/agent typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/skill-promote-cli.ts packages/agent/src/skill-promote-cli.test.ts
git commit -m "SIO-1345: wire --list and --pr promotion modes into the CLI"
```

---

### Task 6: end-to-end structural proof — a promoted skill actually loads

**Files:**
- Create: `packages/agent/src/skill-promote-load.test.ts`

**Interfaces:**
- Consumes: `renderSkillMarkdown` (Task 3), `addSkillToManifest` (Task 2), `loadAgent(agentDir)` from `@devops-agent/gitagent-bridge` (requires `name`/`version`/`description` in agent.yaml; missing shared root is tolerated).

- [ ] **Step 1: Write the test** (this is the integration proof, written after the units exist — it should pass immediately; if it fails, the units are wrong)

```ts
// agent/src/skill-promote-load.test.ts
//
// SIO-1345: structural end-to-end -- render a proposal in pr mode, register it via
// addSkillToManifest, and prove loadAgent serves both the body and the typed
// frontmatter. Mirrors the elastic-iac-load.test.ts "skill content reaches the
// assembled prompt" canary, against a temp agent dir.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "@devops-agent/gitagent-bridge";
import { addSkillToManifest } from "./skill-manifest.ts";
import { renderSkillMarkdown } from "./skill-promote.ts";

const MANIFEST = `name: testagent
version: "0.0.1"
description: promotion load test
skills:
  - placeholder
`;

describe("promoted skill loads end-to-end (SIO-1345)", () => {
	test("pr-mode render + manifest edit -> loadAgent serves skill + frontmatter", () => {
		const root = mkdtempSync(join(tmpdir(), "skill-promote-load-"));
		const agentDir = join(root, "agents", "testagent");
		mkdirSync(join(agentDir, "skills", "lag-correlation"), { recursive: true });

		const markdown = renderSkillMarkdown(
			{
				annotations: {
					skill_name: "lag-correlation",
					confidence: "0.5",
					usage_count: "0",
					success_count: "0",
					failure_count: "0",
					learned_from: "thread:t1",
					learned_at: "2026-07-30T10:00:00Z",
				},
				body: "Proposed skill: lag-correlation - correlate lag with errors\nProcedure: check consumer lag, then downstream error rates",
			},
			{ mode: "pr" },
		);
		writeFileSync(join(agentDir, "skills", "lag-correlation", "SKILL.md"), markdown, "utf8");
		writeFileSync(join(agentDir, "agent.yaml"), addSkillToManifest(MANIFEST, "lag-correlation").content, "utf8");

		const agent = loadAgent(agentDir);
		expect(agent.skills.get("lag-correlation")).toContain("check consumer lag");
		expect(agent.skillMeta.get("lag-correlation")?.confidence).toBe(0.5);
		expect(agent.skillMeta.get("lag-correlation")?.learned_from).toBe("thread:t1");
	});
});
```

- [ ] **Step 2: Run**

Run: `bun test packages/agent/src/skill-promote-load.test.ts`
Expected: PASS. If `@devops-agent/gitagent-bridge` fails to resolve in a fresh worktree, run `bun install` (then `git diff package.json bun.lock` — bun install can rewrite catalog pins; revert any pin churn).

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/skill-promote-load.test.ts
git commit -m "SIO-1345: prove a git-native promoted skill loads via loadAgent"
```

---

### Task 7: full verification + PR

- [ ] **Step 1: Full gates**

Run: `bun run typecheck && bun run lint && bun test packages/agent/src/skill-learner.test.ts packages/agent/src/skill-manifest.test.ts packages/agent/src/skill-outcome.test.ts packages/agent/src/skill-promote.test.ts packages/agent/src/skill-promote-git.test.ts packages/agent/src/skill-promote-cli.test.ts packages/agent/src/skill-promote-load.test.ts`
Expected: all green, no new failures (main has known pre-existing red elsewhere; compare against main if anything unrelated fails).

- [ ] **Step 2: Live smoke (best-effort)** — only if the agent-memory backend is reachable:

Run: `curl -s http://localhost:8070/health`
If healthy: `LIVE_MEMORY_BACKEND=agent-memory bun packages/agent/src/skill-promote-cli.ts --list` and confirm it prints proposals or the explicit "No kind:skill proposals" message (not a crash). Do NOT run `--pr` against the real repo in the smoke test.

- [ ] **Step 3: Push branch + open PR** (ready for review, never draft), then run the CodeRabbit lifecycle from CLAUDE.md (SHA-scoped completion check, triage every finding).

## Self-Review Notes

- Spec coverage: discovery gap → Task 1 + `--list` (Task 5); manual agent.yaml edit → Task 2 + `--pr` (Task 5); review boundary preserved → PR-as-gate (Task 4 semantics, PR body checklist); stale `--add-to-manifest` comment → Task 5 header rewrite; "prove it loads" → Task 6.
- Deliberately NOT touched: `learnFromTurn` funnel, `skill-outcome.ts`, `skill-learner-install.ts` stub (post-promotion application trace stays a separate follow-up ticket).
- Type consistency: `PromoteArgs.skill` becomes optional — the only consumers are this CLI's `main()` (narrowed) and its tests (updated in Task 5).
