# pi-fleet Phase 0b + Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move pi-coms into this monorepo as `packages/pi-coms/` (Phase 0b, SIO-1654), then land PR #682 and remove the analyzer's two-agent and single-hub assumptions (Phase 0, SIO-1635), so every later pi-fleet phase builds on one codebase and per-environment hubs.

**Architecture:** Phase 0b is a `git subtree add --squash` of `zx8086/pi-coms` main (`275cf6d`) that keeps pi-coms's internal layout; the package joins the Bun workspace through the existing `packages/*` glob, its monitor dependencies stay in a nested non-workspace `scripts/package.json`, the fleet bundle is staged from the subtree with a standalone lockfile, and the hub wire types move into `packages/pi-coms/contracts/` as the single source. Phase 0 rebases and merges PR #682, replaces the memory-backend ternaries with an explicit identity map that throws on unknown agents, gives the hub client a sender prefix, a public heartbeat and a `mailbox()` reader, and introduces a `hubs` map keyed by environment (`dev`, `stg`, `prd`) selected from the estate name suffix so a prd estate can never reach the dev hub.

**Tech Stack:** Bun 1.3.14 (root `.bun-version`), TypeScript strict, Zod 4 (root override 4.3.6), Biome 2.5, just, Terraform, GitHub Actions, git subtree.

**Spec:** `docs/architecture/pi-fleet-gitagent-feasibility.md` (sections "Decision: one codebase" and "Phase 0"), Linear SIO-1654 (full steps) and the two SIO-1635 comments dated 2026-09-06, `experiments/HANDOFF-2026-09-06-pi-fleet-program.md`.

## Context

The feasibility work for the pi-fleet program is merged (PR #689). Two decisions from that work shape all later phases: one codebase (pi-coms becomes `packages/pi-coms/`) and no cross-environment access (one hub per environment, hub chosen by the estate's environment). Nothing is implemented yet. PR #682 (SIO-1635, the `verify-with-pi` / `investigate-with-pi` action cards) is open, 16 commits behind main and 3 ahead, and merges only after the user mints the hub token, smoke-tests through the corp hub tunnel and gives an explicit go-ahead (Greptile skips every review account-wide, SIO-1642). The analyzer `.env` has no `PI_COMS_*` variables yet, so that smoke test has not happened.

Facts verified this session that change the work as written in the issues:

- Both repos are public. pi-coms tracked files carry one real 12-digit account id (`deploy/accounts/eu-oit-dev/main.tf:73` default `pi-coms-dist-352896877281` and the usage example at `deploy/publish-fleet.sh:9`) and one personal token-file path (`AGENTS.md:147`). They are already public in pi-coms, but the import PR removes them anyway (feedback: never add new occurrences).
- `packages/pi-coms/package.json` auto-joins the workspace; the root `bun run typecheck` and `bun run test` fan out with `--filter '*'` and silently skip a package without those scripts; root `lint` is one `biome check .` over the tree, and a second Biome root config under `packages/pi-coms/` would break it.
- pi-coms's `deploy/publish-fleet.sh` archives `git rev-parse --show-toplevel` (the whole monorepo after the move) and needs two lockfiles that a workspace does not have at the package root. `git archive HEAD:packages/pi-coms` plus `bun install --lockfile-only` in the stage fixes both; `bun install --help` confirms `--lockfile-only` exists locally.
- Every pi-coms test resolves paths with `import.meta.dir`; the hub resolves state from `os.homedir()`. No test or script depends on cwd. The tests do depend on `scripts/node_modules` (checks import `@aws-sdk/client-*`), which only `bun install --cwd scripts` provides.
- The verdict and investigation Zod schemas exist only on the #682 branch. Issue step 7 (contracts move) is therefore split: Phase 0b moves the hub wire types into `packages/pi-coms/contracts/`; Phase 0 makes the analyzer import them. The verdict and investigation Zod schemas stay in `packages/shared/src/pi-coms-types.ts` because they are the analyzer's own `response_schema` payloads, the spoke receives them over the wire, the extension uses typebox, and keeping Zod out of the Pi package manifest preserves SIO-1632. This deviation is recorded on SIO-1654 in Task 0b.1.
- Rebasing #682 onto main conflicts only in `docs/code-review-bakeoff.md` (both sides appended at the tail).
- Estate ids are free-form strings (keys of `AWS_ESTATES`). Real names end in `-dev`, `-stg`, `-prd`; a few committed names end in `-prod`. The environment resolver accepts `-prod` as an alias for `prd` and treats any other suffix as an error.
- `memory-backend.ts:430` passes an already-resolved `userId` into `resolveRole`; it works today only because both agents' user ids equal their names. The identity map gets a `roleForUserId` lookup for that call site.

## User decisions (2026-09-06, this session)

- Order: Phase 0b (SIO-1654) first, then Phase 0 (SIO-1635). One plan, two branches, two PRs.
- Subtree import: `--squash` (one import commit naming the pi-coms source SHA `275cf6d`).
- Unknown agent name in `memory-backend.ts`: throw.

## Authorization scope of this plan

Approving this plan authorizes the commits listed below on the two feature branches, `bun install` runs, and opening the two PRs as ready for review. It does NOT authorize: merging either PR, editing the root `package.json`, editing `packages/agent/package.json` (Task 0.4 asks before adding the one workspace dependency), minting hub tokens, publishing a fleet bundle, or archiving the pi-coms repo. Those are asked for individually.

## Global Constraints

- Bun runtime, TypeScript strict, never `any`, Zod for validation, no `.default()` in config schemas, Biome lint, named exports, tabs (Biome default) in TS and JSON.
- No emojis anywhere. No em dashes in prose.
- Root `package.json` is not edited (the `packages/*` glob already matches `packages/pi-coms`). After every `bun install`, run `git diff --stat package.json bun.lock`; if the root manifest changed (catalog refs rewritten to concrete versions), `git checkout package.json bun.lock && bun install` and re-check.
- `packages/pi-coms/scripts/package.json` stays nested and NON-workspace; its `bun.lock` stays; the package-root `bun.lock` is deleted (the workspace root owns the only lockfile).
- Public repo: no 12-digit account ids, personal names, tokens, tfstate or tfvars in any commit. Sweep every diff with `git diff origin/main..HEAD | grep -nE '[0-9]{12}|simon|pvhcorp|tommy\.com'` before pushing.
- No cross-environment access: a prd estate never produces a request on the dev hub and vice versa.
- Hub replies and inbox bodies never reach an LLM prompt; only structured fields do.
- Commit format `SIO-XXXX: message`; commit body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; commit with a HEREDOC (`git commit -F - <<'MSG' ... MSG`).
- PRs ready for review, never draft. Open with `gh api repos/zx8086/devops-incident-analyzer/pulls -f title=... -f head=... -f base=main -F draft=false -F body=@<file>` (the auto-mode classifier blocks `gh pr create`). Merge only on the user's explicit per-PR go-ahead; check `mcp__greptile__list_code_reviews` once at PR open; append a ledger row and detail section to `docs/code-review-bakeoff.md` after the merge decision.
- Linear: SIO-1654 and SIO-1635 to In Progress at task start, In Review with the PR link, never Done without the user. Never put an issue id of a planning-only PR in a title; these two PRs are implementation PRs and keep `SIO-1654:` / `SIO-1635:` prefixes.
- Every process started in verification is killed by its tracked PID and its port proven free: `lsof -nP -iTCP:<port> -sTCP:LISTEN` returns nothing.
- Work from the worktree absolute path only. Never `git stash` bare; never `git checkout main` (occupied by the primary worktree); push docs to main only with `git push origin HEAD:main`.
- Tests: `cd packages/agent && bun test --isolate` (non-isolated shows 15 pre-existing iac mock-pollution failures); `cd packages/shared && bun test`; `cd apps/web && bun run test`; `cd packages/pi-coms && bun test`.

---

# Phase 0b: SIO-1654, pi-coms into `packages/pi-coms/`

Branch: `claude/sio-1654-pi-coms-subtree` off `origin/main`.

## File structure after Phase 0b

```
packages/pi-coms/                      subtree root (pi-coms repo root, layout intact)
  package.json                         renamed @devops-agent/pi-coms, scripts, exports, files
  contracts/wire.ts                    hub wire types moved out of scripts/coms-net-server.ts
  contracts/index.ts                   re-exports
  scripts/coms-net-server.ts           imports its wire types from ../contracts/wire.ts
  scripts/package.json + scripts/bun.lock   nested non-workspace monitor deps (unchanged)
  tests/harness.ts                     imports the response envelope types from ../contracts
  tests/aws-sdk-parity.test.ts         new: major-version parity with packages/mcp-server-aws
  tests/publish-stage.test.ts          new: stages a bundle from the subtree with --stage-only
  deploy/publish-fleet.sh              stages HEAD:packages/pi-coms with a standalone lockfile
  deploy/accounts/eu-oit-dev/main.tf   dist_bucket has no default (account id removed)
  justfile, tsconfig.json, .gitignore, .env.sample, docs/, README.md, CLAUDE.md, AGENTS.md  kept
  (deleted) bun.lock, biome.json, .github/, .yamllint.yml
justfile                               new root file delegating operator recipes
biome.json                             root: excludes packages/pi-coms/deploy
.github/workflows/ci.yml               new job pi-coms (extension syntax, bash -n, terraform fmt)
CLAUDE.md, docs/README.md              pi-coms bullets, index row, changelog row
docs/superpowers/plans/2026-09-06-pi-fleet-phase-0b-and-0.md   this plan, committed
experiments/HANDOFF-2026-09-06-pi-fleet-program.md            status line per phase
```

### Task 0b.1: Branch, Linear, subtree import

**Files:**
- Create: `packages/pi-coms/**` (subtree), `docs/superpowers/plans/2026-09-06-pi-fleet-phase-0b-and-0.md`
- Delete: `packages/pi-coms/bun.lock`, `packages/pi-coms/.github/workflows/ci.yml`, `packages/pi-coms/.yamllint.yml`

**Interfaces:**
- Produces: the subtree at `packages/pi-coms/` at pi-coms SHA `275cf6d`; every later 0b task edits files under it.

- [ ] **Step 1: Linear**

Set SIO-1654 to In Progress. Append a comment (never replace):

```
# Execution start 2026-09-06

Plan: docs/superpowers/plans/2026-09-06-pi-fleet-phase-0b-and-0.md (this repo, on the SIO-1654 branch).
Decisions taken at plan time: subtree --squash; the package-root bun.lock is dropped (workspace root owns the lockfile) and publish-fleet.sh writes a standalone lockfile in the stage; the nested biome.json is dropped in favour of the root config (Biome 2 rejects a second root config) with packages/pi-coms/deploy excluded; step 7 is split: hub wire types move to packages/pi-coms/contracts/ now, the analyzer imports them in Phase 0 (SIO-1635), and the verdict and investigation Zod schemas stay in packages/shared because they are the analyzer's response_schema payloads and keeping zod out of the Pi manifest preserves SIO-1632.
```

- [ ] **Step 2: Branch and import**

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/.claude/worktrees/pi-fleet-program-planning-3be424
git fetch origin
git checkout -b claude/sio-1654-pi-coms-subtree origin/main
git subtree add --prefix packages/pi-coms https://github.com/zx8086/pi-coms.git main --squash
git log --oneline -3
```

Expected: two new commits, `Squashed 'packages/pi-coms/' content from commit 275cf6d` and `Merge commit '<sha>' as 'packages/pi-coms'`.

- [ ] **Step 3: Verify the import and the nested ignore file**

```bash
test -f packages/pi-coms/package.json && test -f packages/pi-coms/extensions/coms-net.ts && test -f packages/pi-coms/scripts/bun.lock && echo tree-ok
git check-ignore -v packages/pi-coms/deploy/accounts/eu-oit-dev/terraform.tfvars packages/pi-coms/deploy/accounts/eu-oit-dev/terraform.tfstate packages/pi-coms/deploy/accounts/eu-oit-dev/.terraform/lock packages/pi-coms/scripts/node_modules/x packages/pi-coms/.env
git ls-files packages/pi-coms | grep -E 'tfstate|tfvars|\.env$|node_modules' ; echo "(must print nothing above)"
git ls-files packages/pi-coms | wc -l
```

Expected: five `packages/pi-coms/.gitignore:` matches, nothing tracked that matches, about 100 files.

- [ ] **Step 4: Remove the files that only made sense at a repo root**

```bash
git rm -q packages/pi-coms/bun.lock packages/pi-coms/.github/workflows/ci.yml packages/pi-coms/.yamllint.yml
git commit -F - <<'MSG'
SIO-1654: drop pi-coms root lockfile, workflow and yamllint config after the subtree import

The workspace root owns the only bun.lock; the package-root lockfile would
drift silently. GitHub only reads .github at the repo root, so the pi-coms
workflow moves into the root ci.yml in a later commit. The yamllint config was
dead (its script passed -d relaxed inline).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

- [ ] **Step 5: Commit this plan into the repo**

Copy the approved plan file to `docs/superpowers/plans/2026-09-06-pi-fleet-phase-0b-and-0.md` (verbatim, this file) and commit:

```bash
git add docs/superpowers/plans/2026-09-06-pi-fleet-phase-0b-and-0.md
git commit -F - <<'MSG'
docs: implementation plan for pi-fleet Phase 0b (subtree move) and Phase 0 (hub map)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.2: Package manifest, workspace install, Biome, typecheck

**Files:**
- Modify: `packages/pi-coms/package.json`, `biome.json` (root), `packages/pi-coms/scripts/package.json` (formatting only)
- Delete: `packages/pi-coms/biome.json`

**Interfaces:**
- Produces: `@devops-agent/pi-coms` with scripts `deps:monitor`, `test`, `typecheck`, and `exports["./contracts"]` pointing at `./contracts/index.ts` (created in Task 0b.4).

- [ ] **Step 1: Rewrite `packages/pi-coms/package.json`**

Replace the whole file with (tabs):

```json
{
	"name": "@devops-agent/pi-coms",
	"private": true,
	"type": "module",
	"description": "Peer-to-peer communication for Pi Coding Agent instances, with multi-account AWS deployment",
	"version": "0.1.0",
	"keywords": ["pi-package"],
	"files": ["extensions", "contracts", "scripts/coms-net-server.ts", "README.md", "docs"],
	"exports": {
		"./contracts": "./contracts/index.ts"
	},
	"pi": {
		"extensions": ["./extensions/coms-net.ts"]
	},
	"scripts": {
		"deps:monitor": "bun install --frozen-lockfile --cwd scripts",
		"test": "bun run deps:monitor && bun test",
		"typecheck": "bun run deps:monitor && bunx tsc --noEmit",
		"biome:check": "biome check .",
		"biome:check:write": "biome check --write ."
	},
	"peerDependencies": {
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		"typebox": "*"
	},
	"peerDependenciesMeta": {
		"@earendil-works/pi-coding-agent": { "optional": true },
		"@earendil-works/pi-tui": { "optional": true },
		"typebox": { "optional": true }
	},
	"devDependencies": {
		"@biomejs/biome": "^2.5.12",
		"@earendil-works/pi-coding-agent": "0.84.4",
		"@earendil-works/pi-tui": "0.84.4",
		"@types/bun": "^1.3.13",
		"typebox": "1.3.7",
		"typescript": "^5"
	}
}
```

Why literal versions and not `catalog:`: the staged fleet bundle is installed standalone (no workspace root, no catalog), so the manifest must resolve on its own. `@types/bun` moves from `latest` to the root catalog's range. `typescript ^5` stays: pi-coms typechecks under tsc 5 today; bumping to 6 is a separate change.

- [ ] **Step 2: Install and check for root catalog drift**

```bash
bun install
git diff --stat package.json bun.lock
```

Expected: `package.json` unchanged; `bun.lock` gains entries for `@devops-agent/pi-coms` and its devDependencies only. If `package.json` shows catalog rewrites: `git checkout package.json bun.lock && bun install` and re-check.

```bash
bun run --filter @devops-agent/pi-coms deps:monitor
ls packages/pi-coms/scripts/node_modules/@aws-sdk | head -3
git status --short   # must not list bun.lock or package.json at the root or in scripts/
```

- [ ] **Step 3: Drop the nested Biome config, exclude deploy at the root, reformat**

Delete `packages/pi-coms/biome.json`. In root `biome.json`, add two entries to `files.includes` after `"!.fallow"`:

```json
			"!packages/pi-coms/deploy",
			"!packages/pi-coms/scripts/node_modules"
```

Then:

```bash
bunx biome check --write packages/pi-coms
bun run lint
```

Expected: `bun run lint` exit 0. The reformat commit will touch JSON indentation (spaces to tabs) in `packages/pi-coms/package.json`, `scripts/package.json`, `.env.sample` is untouched (not JSON). If Biome reports lint errors in pi-coms sources, fix them (they are real lint findings under the root preset) and note them in the PR body; do not add suppressions without a ticket reference.

- [ ] **Step 4: Typecheck and test the package from the root and from the package**

```bash
bun run typecheck
cd packages/pi-coms && bun test; cd -
```

Expected: root typecheck exit 0 (includes pi-coms); pi-coms tests 30 files pass (7 spawn a real hub on port 0 in a temp HOME). If a test fails under Bun 1.3.14 that passed on pi-coms's 1.4.0, report it with output before touching it.

- [ ] **Step 5: Commit**

```bash
git add -A packages/pi-coms biome.json bun.lock
git commit -F - <<'MSG'
SIO-1654: register pi-coms as @devops-agent/pi-coms in the workspace

Package scripts run the monitor's nested install before typecheck and test so
the root --filter fan-out works without a manual step. The nested Biome config
is dropped (Biome 2 rejects a second root config); the root config excludes
packages/pi-coms/deploy. Literal devDependency versions are kept so the staged
fleet bundle installs standalone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.3: Sanitize identifiers and package-name strings

**Files:**
- Modify: `packages/pi-coms/deploy/accounts/eu-oit-dev/main.tf:71-73`, `packages/pi-coms/deploy/publish-fleet.sh:9` (rewritten fully in Task 0b.6, but the example line is fixed there too), `packages/pi-coms/AGENTS.md:147`, `packages/pi-coms/docs/README.md:3,62`, `packages/pi-coms/extensions/coms-net.ts:1012,1036`

- [ ] **Step 1: Remove the account id default**

In `deploy/accounts/eu-oit-dev/main.tf`, the `dist_bucket` variable becomes required:

```hcl
variable "dist_bucket" {
  description = "Distribution bucket in the hub account (pi-coms-dist-<hub-account-id>); set in terraform.tfvars"
  type        = string
}
```

Run `terraform fmt -check -recursive packages/pi-coms/deploy` (exit 0). Add a line to `docs/deployment/deployment.md` next to the existing `dist_bucket` mention stating the value now lives in the gitignored `terraform.tfvars` of each spoke root.

- [ ] **Step 2: Generic operator strings**

`AGENTS.md:147`: replace `~/.pi-coms-corp-token-simon` with `~/.pi-coms-corp-token-<you>`.
`docs/README.md:3` and `:62`: the `guides/` links point at an untracked symlink; replace the link text with plain text `the private guides collection (not in this repo)` and drop the two links.
`extensions/coms-net.ts:1012` and `:1036`: `(from the pi-coms package)` becomes `(from packages/pi-coms)`.

- [ ] **Step 3: Sweep and commit**

```bash
git diff origin/main..HEAD -- packages/pi-coms | grep -nE '[0-9]{12}|simon|pvhcorp|tommy\.com' | grep -v 'tests/checks-identity.test.ts'
```

Expected: no output (the checks-identity test uses the synthetic `111122223333`).

```bash
git add -A packages/pi-coms
git commit -F - <<'MSG'
SIO-1654: remove the account id default, personal paths and dangling guides links from the imported tree

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.4: Hub wire contracts in `packages/pi-coms/contracts/`

**Files:**
- Create: `packages/pi-coms/contracts/wire.ts`, `packages/pi-coms/contracts/index.ts`
- Modify: `packages/pi-coms/scripts/coms-net-server.ts:136-238`, `packages/pi-coms/tests/harness.ts:15-22`

**Interfaces:**
- Produces (consumed by Phase 0 Task 0.4 through `@devops-agent/pi-coms/contracts`): `AgentStatus`, `MessageStatus`, `AgentCard`, `ComsMessage`, `RegisterRequest`, `RegisterResponse`, `HeartbeatRequest`, `SendRequest`, `SendResponse`, `ResponseSubmitRequest`, `ErrorResponse`, `InboxMessage`, `InboxListing`, `AgentListing`, `MessageLookup`.

- [ ] **Step 1: Move the exported wire types**

Cut the exported type aliases at `scripts/coms-net-server.ts` lines 136-238 (`AgentStatus`, `MessageStatus`, `AgentCard`, `ComsMessage`, `RegisterRequest`, `RegisterResponse`, `HeartbeatRequest`, `SendRequest`, `SendResponse`, `ResponseSubmitRequest`, `ErrorResponse`) verbatim into `contracts/wire.ts`. Leave `RegistryEntry` (line 156, server-internal) and `AuthPrincipal` (line 307) in the server. If a moved alias references a server-internal type, keep that alias in the server too and say so in the commit body. Header of the new file:

```ts
// packages/pi-coms/contracts/wire.ts
// Hub wire contract: the request and response shapes of scripts/coms-net-server.ts.
// Single source for the hub, the tests and the incident analyzer's hub client
// (SIO-1654). Types only: this file must stay dependency-free so the Pi package
// manifest does not grow a runtime dependency.
```

Append the response envelopes the hub builds (bodies taken from `tests/harness.ts:18-22` and the `MailStore.inbox` return type at `scripts/coms-net-server.ts:660`):

```ts
export type AgentListing = { agents: AgentCard[] };

export type InboxMessage = {
	msg_id: string;
	sender_name: string;
	target_name: string | null;
	prompt: string;
	status: string;
	error: string | null;
	response: unknown;
	created_at: string;
	delivered_at: string | null;
	completed_at: string | null;
};

export type InboxListing = { ok: true; name: string; messages: InboxMessage[] };

export type MessageLookup = { msg_id: string; status: MessageStatus; response: unknown; error: string | null };
```

`contracts/index.ts`:

```ts
// packages/pi-coms/contracts/index.ts
export type * from "./wire.ts";
```

In `scripts/coms-net-server.ts`, add at the top of the imports:

```ts
import type {
	AgentCard,
	AgentStatus,
	ComsMessage,
	ErrorResponse,
	HeartbeatRequest,
	MessageStatus,
	RegisterRequest,
	RegisterResponse,
	ResponseSubmitRequest,
	SendRequest,
	SendResponse,
} from "../contracts/wire.ts";
export type { AgentCard, AgentStatus, ComsMessage, ErrorResponse, MessageStatus, RegisterResponse, SendResponse };
```

(The re-export keeps `tests/*.test.ts` imports of these names from `../scripts/coms-net-server.ts` working.)

Make `MailStore.inbox` return `InboxMessage[]` (import the type) instead of the inline object type at lines 664-675 so the contract and the implementation cannot drift.

- [ ] **Step 2: Point the harness at the contract**

In `tests/harness.ts`, replace the local `AgentListing`, `InboxMessage`, `InboxListing`, `MessageLookup` definitions (lines 18-22) with:

```ts
export type { AgentListing, InboxListing, InboxMessage, MessageLookup } from "../contracts/wire.ts";
```

and add `contracts/**/*.ts` to `tsconfig.json` `include`.

- [ ] **Step 3: Verify**

```bash
cd packages/pi-coms && bunx tsc --noEmit && bun test tests/inbox.integration.test.ts tests/mailbox.integration.test.ts tests/hub-validation.integration.test.ts; cd -
bun run lint
```

Expected: tsc exit 0, the three integration files pass, lint clean.

- [ ] **Step 4: Commit**

```bash
git add -A packages/pi-coms
git commit -F - <<'MSG'
SIO-1654: move the hub wire types into packages/pi-coms/contracts as the single source

The server and the test harness import them relatively; the incident analyzer
imports them through the package exports in Phase 0 (SIO-1635) instead of
keeping a hand-mirrored copy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.5: AWS SDK major-version parity test

**Files:**
- Create: `packages/pi-coms/tests/aws-sdk-parity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/pi-coms/tests/aws-sdk-parity.test.ts
// SIO-1654: the monitor's AWS SDK clients live in the nested scripts/package.json
// (non-workspace, SIO-1632) and the analyzer's live in packages/mcp-server-aws.
// Neither install sees the other, so the major versions are pinned to each other
// here. It is a ratchet: when it goes red, align the two lists on purpose.
import { describe, expect, test } from "bun:test";
import root from "../../../package.json" with { type: "json" };
import mcpAws from "../../mcp-server-aws/package.json" with { type: "json" };
import monitor from "../scripts/package.json" with { type: "json" };

function major(range: string, name: string): string {
	const m = /(\d+)\./.exec(range);
	if (!m?.[1]) throw new Error(`unparseable version range for ${name}: ${range}`);
	return m[1];
}

describe("AWS SDK major-version parity (SIO-1654)", () => {
	const monitorDeps = monitor.dependencies as Record<string, string>;
	const analyzerDeps = mcpAws.dependencies as Record<string, string>;

	test("the monitor declares its nine AWS SDK clients", () => {
		const clients = Object.keys(monitorDeps).filter((n) => n.startsWith("@aws-sdk/client-"));
		expect(clients.length).toBe(9);
	});

	test("every monitor client shares the analyzer's AWS SDK major", () => {
		const reference = analyzerDeps["@aws-sdk/client-sts"];
		if (!reference) throw new Error("mcp-server-aws no longer depends on @aws-sdk/client-sts");
		const expected = major(reference, "@aws-sdk/client-sts");
		for (const [name, range] of Object.entries(monitorDeps)) {
			if (!name.startsWith("@aws-sdk/client-")) continue;
			expect({ name, major: major(range, name) }).toEqual({ name, major: expected });
		}
	});

	test("the monitor's zod major matches the root catalog", () => {
		const catalog = root.workspaces.catalog as Record<string, string>;
		const rootZod = catalog.zod;
		const monitorZod = monitorDeps.zod;
		if (!rootZod || !monitorZod) throw new Error("zod missing from the root catalog or scripts/package.json");
		expect(major(monitorZod, "zod")).toBe(major(rootZod, "zod"));
	});
});
```

- [ ] **Step 2: Run it**

```bash
cd packages/pi-coms && bun test tests/aws-sdk-parity.test.ts && bunx tsc --noEmit; cd -
```

Expected: 3 pass (monitor clients are `^3.11xx`, analyzer `^3.700.0`, both major 3; zod 4 and 4). If tsc rejects the JSON import attribute, add `"resolveJsonModule": true` to `packages/pi-coms/tsconfig.json` `compilerOptions`.

- [ ] **Step 3: Commit**

```bash
git add packages/pi-coms/tests/aws-sdk-parity.test.ts packages/pi-coms/tsconfig.json
git commit -F - <<'MSG'
SIO-1654: pin the monitor's AWS SDK and zod majors to the analyzer's

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.6: Fleet bundle from the subtree

**Files:**
- Modify: `packages/pi-coms/deploy/publish-fleet.sh` (full rewrite)
- Create: `packages/pi-coms/tests/publish-stage.test.ts`

**Interfaces:**
- Produces: `publish-fleet.sh [--stage-only] <bucket> [profile]`; env `PI_COMS_STAGE_DIR` (use this dir instead of mktemp, kept on exit) and `PI_FLEET_PERSONA_DIR` (copied to `vendor/pi-fleet/` in the stage; the Phase 1 exporter hook, no-op when unset). Per-environment upload (issue step 6) is one invocation per hub bucket and profile; the manifest-driven loop over the hubs map is SIO-1653.

- [ ] **Step 1: Write the failing test**

```ts
// packages/pi-coms/tests/publish-stage.test.ts
// SIO-1654: the bundle is staged from the packages/pi-coms subtree, not the
// monorepo root, with a standalone lockfile so hosts can run the frozen install.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "deploy", "publish-fleet.sh");

describe("publish-fleet.sh --stage-only", () => {
	test("stages the subtree with lockfiles, monitor deps and the version stamp", async () => {
		const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coms-stage-"));
		const proc = Bun.spawn(["bash", SCRIPT, "--stage-only"], {
			env: { ...process.env, PI_COMS_STAGE_DIR: stage },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect({ code, err }).toEqual({ code: 0, err: "" });
		expect(out.trim()).toBe(stage);
		for (const f of ["extensions/coms-net.ts", "scripts/coms-net-server.ts", "deploy/AGENTS-spoke.md", "bun.lock", "scripts/bun.lock", ".bundle-version"]) {
			expect({ f, exists: fs.existsSync(path.join(stage, f)) }).toEqual({ f, exists: true });
		}
		expect(fs.existsSync(path.join(stage, "scripts", "node_modules", "@aws-sdk"))).toBe(true);
		expect(fs.existsSync(path.join(stage, "packages"))).toBe(false);
		expect(fs.readFileSync(path.join(stage, ".bundle-version"), "utf8").trim()).toMatch(/^[0-9a-f]{7,}$/);
		fs.rmSync(stage, { recursive: true, force: true });
	}, 180_000);
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd packages/pi-coms && bun test tests/publish-stage.test.ts; cd -
```

Expected: FAIL (the current script has no `--stage-only`, requires a bucket, and archives the monorepo root).

- [ ] **Step 3: Rewrite the script**

```bash
#!/usr/bin/env bash
# packages/pi-coms/deploy/publish-fleet.sh [--stage-only] <s3-bucket> [profile]
#
# Build and upload the fleet bundle: a git archive of the packages/pi-coms
# subtree at HEAD plus vendored node_modules (all deps are pure JS, so the
# vendor tree is platform-independent). Hosts running in S3 bundle mode
# converge on it within the State Manager window, or immediately via Run
# Command.
#
#   ./packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-<hub-account-id> eu-shared-services-dev
#
# --stage-only builds the stage (in PI_COMS_STAGE_DIR when set), prints its
# path and exits without uploading; the dirty-tree check is skipped because it
# is a local dry run. PI_FLEET_PERSONA_DIR, when set, is copied to
# vendor/pi-fleet/ in the stage (the persona exporter hook, SIO-1649).
set -euo pipefail

STAGE_ONLY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --stage-only) STAGE_ONLY=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
BUCKET="${ARGS[0]:-}"
PROFILE="${ARGS[1]:-}"
if [ "$STAGE_ONLY" = 0 ] && [ -z "$BUCKET" ]; then
  echo "usage: publish-fleet.sh [--stage-only] <s3-bucket> [aws-profile]" >&2
  exit 1
fi
PROFILE_ARGS=()
[ -n "$PROFILE" ] && PROFILE_ARGS=(--profile "$PROFILE")

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "$PKG_ROOT" rev-parse --show-toplevel)"
PKG_PREFIX="$(git -C "$PKG_ROOT" rev-parse --show-prefix)"
PKG_PREFIX="${PKG_PREFIX%/}"
VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
if [ "$STAGE_ONLY" = 0 ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- "$PKG_PREFIX")" ]; then
  echo "refusing to publish: uncommitted changes in tracked files under $PKG_PREFIX" >&2
  exit 1
fi

if [ -n "${PI_COMS_STAGE_DIR:-}" ]; then
  STAGE="$PI_COMS_STAGE_DIR"
  mkdir -p "$STAGE"
else
  STAGE="$(mktemp -d)"
  [ "$STAGE_ONLY" = 1 ] || trap 'rm -rf "$STAGE"' EXIT
fi

# The subtree only, with the packages/pi-coms prefix stripped: the bundle root
# is the package root, exactly what the bootstrap and the hub userdata expect.
git -C "$REPO_ROOT" archive "HEAD:$PKG_PREFIX" | tar -x -C "$STAGE"
# The workspace root owns the only lockfile, so the staged tree gets a
# standalone one before the frozen production install the hosts repeat.
(cd "$STAGE" && bun install --lockfile-only && bun install --frozen-lockfile --production --omit=peer)
# The monitor and hub runtime deps live in scripts/package.json (SIO-1632).
(cd "$STAGE/scripts" && bun install --frozen-lockfile --production)
if [ -n "${PI_FLEET_PERSONA_DIR:-}" ]; then
  mkdir -p "$STAGE/vendor"
  cp -R "$PI_FLEET_PERSONA_DIR" "$STAGE/vendor/pi-fleet"
fi
echo "$VERSION" > "$STAGE/.bundle-version"

if [ "$STAGE_ONLY" = 1 ]; then
  echo "$STAGE"
  exit 0
fi

tar -czf "$STAGE.tar.gz" -C "$STAGE" .
aws s3 cp "$STAGE.tar.gz" "s3://$BUCKET/fleet/bundle.tar.gz" "${PROFILE_ARGS[@]}"
printf '%s' "$VERSION" | aws s3 cp - "s3://$BUCKET/fleet/version" "${PROFILE_ARGS[@]}"
rm -f "$STAGE.tar.gz"

echo "published fleet bundle $VERSION to s3://$BUCKET/fleet/"
echo "hosts converge within 30 min; immediate rollout:"
echo "  aws ssm send-command --targets Key=tag:Project,Values=pi-coms-net \\"
echo "    --document-name AWS-RunShellScript --parameters 'commands=[\"/usr/local/bin/pi-coms-update\"]' ${PROFILE_ARGS[*]:-}"
```

- [ ] **Step 4: Run the test and the syntax check**

```bash
bash -n packages/pi-coms/deploy/publish-fleet.sh
cd packages/pi-coms && bun test tests/publish-stage.test.ts; cd -
```

Expected: PASS. The test needs network for `bun install --lockfile-only` (registry resolution of the devDependencies). If `bun install --frozen-lockfile --production --omit=peer` fails on the fresh lockfile, capture the error verbatim; the fallback is to replace both stage-root installs with one `bun install --production --omit=peer` (non-frozen) and keep the `test -f bun.lock` assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-coms/deploy/publish-fleet.sh packages/pi-coms/tests/publish-stage.test.ts
git commit -F - <<'MSG'
SIO-1654: stage the fleet bundle from the packages/pi-coms subtree

git archive HEAD:packages/pi-coms strips the prefix so the bundle root stays
the package root; the stage gets a standalone bun.lock because the workspace
root owns the repo lockfile; --stage-only makes the staging testable without
AWS; PI_FLEET_PERSONA_DIR is the hook the Phase 1 exporter will fill.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.7: Root justfile and CI job

**Files:**
- Create: `justfile` (repo root)
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Root justfile**

```just
# justfile (repo root)
# Operator recipes for the pi-coms hub and console delegate to the package
# justfile, which runs with packages/pi-coms as its working directory (just's
# default for -f) so its relative paths and dotenv-load keep working.

set positional-arguments

pi_just := "just -f packages/pi-coms/justfile"

default:
    @just --list

# Start a local hub (kills a previous listener on PI_COMS_NET_PORT first)
coms-net-server *args:
    {{pi_just}} coms-net-server "$@"

# Start a LAN-exposed local hub
coms-net-server-lan *args:
    {{pi_just}} coms-net-server-lan "$@"

# Open a Pi console session: just coms <cname> [pi args]
coms *args:
    {{pi_just}} coms "$@"

# just token-create <principal> "<names>" <kind> [profile]
token-create *args:
    {{pi_just}} token-create "$@"

# just token-revoke <principal> [profile]
token-revoke *args:
    {{pi_just}} token-revoke "$@"

# just token-list [profile]
token-list *args:
    {{pi_just}} token-list "$@"

# SSM port-forward to the corp hub
hub-tunnel *args:
    {{pi_just}} hub-tunnel "$@"
```

Verify:

```bash
just --list
just --dry-run token-list eu-shared-services-dev
just --dry-run coms laptop
cd packages/pi-coms && just --evaluate 2>/dev/null | head -3; cd -
```

Expected: the seven recipes listed; dry runs print the delegated commands with the arguments intact (no glob expansion of a quoted `incident-analyzer-*`: run `just --dry-run token-create incident-analyzer "incident-analyzer-*" service` and confirm the star survives).

- [ ] **Step 2: CI job**

Append to `.github/workflows/ci.yml`:

```yaml

  pi-coms:
    name: pi-coms deploy checks
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/pi-coms
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version
      - uses: hashicorp/setup-terraform@v3
      - name: extension syntax
        run: bun build extensions/coms-net.ts --external '*' --outfile /dev/null
      - name: shell syntax
        run: |
          bash -n deploy/bootstrap/agent-bootstrap.sh
          bash -n deploy/publish-fleet.sh
          bash -n deploy/token-admin.sh
      - name: terraform fmt
        run: terraform fmt -check -recursive deploy/
```

`bun test` and `bunx tsc` for the package already run inside the existing `test` and `typecheck` jobs through `bun run --filter '*'` (the package scripts install `scripts/` first). Run the three steps locally:

```bash
cd packages/pi-coms && bun build extensions/coms-net.ts --external '*' --outfile /dev/null && bash -n deploy/bootstrap/agent-bootstrap.sh && bash -n deploy/publish-fleet.sh && bash -n deploy/token-admin.sh && terraform fmt -check -recursive deploy/ && echo ci-steps-ok; cd -
yamllint -c .yamllint.yml .github/workflows/ci.yml
```

- [ ] **Step 3: Commit**

```bash
git add justfile .github/workflows/ci.yml
git commit -F - <<'MSG'
SIO-1654: root justfile delegating the pi-coms operator recipes; CI job for the deploy checks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.8: Docs

**Files:**
- Modify: `packages/pi-coms/README.md:21-25,60-84`, `packages/pi-coms/docs/development/usage.md:13,48`, `packages/pi-coms/CLAUDE.md` (Commands section), `CLAUDE.md` (root: Monorepo Structure bullet, Commands, Servers), `docs/README.md` (Architecture table row, changelog row, last-updated line), `docs/architecture/pi-fleet-gitagent-feasibility.md` (tracking row 0b to In Review), `experiments/HANDOFF-2026-09-06-pi-fleet-program.md` (status line)

- [ ] **Step 1: pi-coms README and usage**

README Setup block (lines 21-25) becomes:

```bash
bun install                                              # from the monorepo root (workspace)
bun run --filter @devops-agent/pi-coms deps:monitor      # monitor and hub runtime deps (AWS SDK), nested install
cp packages/pi-coms/.env.sample packages/pi-coms/.env    # fill in provider API keys
```

"Install as a Pi package" (lines 60-84): replace the git URL and tarball paragraphs with:

```bash
# From this checkout (every operator has it); -l keeps it project-local
pi install /absolute/path/to/devops-incident-analyzer/packages/pi-coms -l
```

and rewrite line 62 to: "The package directory `packages/pi-coms` is a Pi package: the `pi` manifest in its `package.json` points at `extensions/coms-net.ts`. Install from the local checkout path; the old git-URL install (`https://github.com/zx8086/pi-coms@v0.1.0`) is retired with the move into the monorepo." Keep the line-84 warning about double-loading.

`docs/development/usage.md:13`: "the `just` recipes do (`set dotenv-load`, reading `packages/pi-coms/.env`; the root `justfile` delegates so `just coms` works from the repo root too)". Line 48: "Operator sessions load `AGENTS.md` from `packages/pi-coms/` (run Pi with that directory as cwd, which `just coms` does)".

- [ ] **Step 2: pi-coms CLAUDE.md**

Under `## Commands`, first paragraph: "This package lives inside the devops-incident-analyzer monorepo (`packages/pi-coms/`, SIO-1654). Root `bun run typecheck`, `bun run lint` and `bun run test` include it; run its tests directly with `cd packages/pi-coms && bun test` (the `test` script runs the nested `scripts/` install first). The root `justfile` delegates `just coms`, `just coms-net-server`, `just token-*` and `just hub-tunnel` here. The fleet bundle is staged from this subtree by `deploy/publish-fleet.sh`; the git-clone host path (`REPO_URL`) is unsupported after the move, bundle mode only."

- [ ] **Step 3: Root CLAUDE.md**

Monorepo Structure list, after the `checkpointer/` bullet:

```
- `pi-coms/` -- the pi-coms hub, Pi extension, fleet monitor, Terraform and deploy scripts (SIO-1654 subtree import, layout intact). Its monitor deps live in a nested NON-workspace `scripts/package.json` (never move them into the package manifest: Pi reads that file on install, SIO-1632); package-local CLAUDE.md and AGENTS.md are read by Pi and stay there. Hub wire types: `packages/pi-coms/contracts/`.
```

Commands block: add `just coms laptop                                       # pi-coms console (delegates to packages/pi-coms/justfile)`.

Servers line: append ` | pi-coms hub (local, just coms-net-server): 52965`. Add after the kill rule bullet: "The kill rule covers `just coms-net-server` and any hub spawned for a smoke test."

Line 11 "10 packages" is stale (18 before this change); do not fix it here beyond changing it to "19 packages" if the line is edited for the pi-coms mention, otherwise leave it.

- [ ] **Step 4: docs/README.md and the feasibility tracking row**

Architecture table, after the Knowledge Graph row:

```
| [pi-coms](../packages/pi-coms/docs/README.md) | pi-coms hub, spoke extension, monitor and fleet deployment (package-local docs; moved into the monorepo by SIO-1654) |
```

Changelog table: `| 2026-09-06 | pi-coms imported as packages/pi-coms (SIO-1654): package-local docs indexed, root justfile, CI deploy checks |`. Update the `Last updated:` line to 2026-09-06. In the feasibility doc's tracking table, set the 0b row status to "In Review (PR #NNN)" once the PR number exists. Append to the program handover under TL;DR: "Status 2026-09-06: Phase 0b implemented on PR #NNN (this plan, Tasks 0b.1 to 0b.9)."

- [ ] **Step 5: Commit**

```bash
git add -A packages/pi-coms/README.md packages/pi-coms/docs packages/pi-coms/CLAUDE.md CLAUDE.md docs/README.md docs/architecture/pi-fleet-gitagent-feasibility.md experiments/HANDOFF-2026-09-06-pi-fleet-program.md
git commit -F - <<'MSG'
SIO-1654: docs for the pi-coms package inside the monorepo (install path, commands, index rows)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0b.9: Full verification, PR, review gate

- [ ] **Step 1: Full gate**

```bash
bun run typecheck && bun run lint && bun run test
cd packages/pi-coms && bun test; cd -
cd packages/agent && bun test --isolate; cd -
cd packages/shared && bun test; cd -
cd apps/web && bun run test; cd -
git status --short           # clean
lsof -nP -iTCP -sTCP:LISTEN | grep -E 'bun|pi-coms' ; echo "(no hub listeners above)"
```

Expected: all green; if root `bun run test` crashes the runner mid-suite (known), rely on the per-package runs and say so in the PR body. Sweep: `git diff origin/main..HEAD | grep -nE '[0-9]{12}|simon|pvhcorp|tommy\.com' | grep -v checks-identity` prints nothing.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin claude/sio-1654-pi-coms-subtree
```

Body file (scratchpad `pr-1654.md`): summary of the move, the decisions from Task 0b.1 Step 1, the verification results, the note that the pi-coms repo stays live until a fleet publish from this repo has converged, and `🤖 Generated with [Claude Code](https://claude.com/claude-code)` as the last line (the PR-body footer is the one place the harness requires the emoji-bearing string; it is generated text, not repo content).

```bash
gh api repos/zx8086/devops-incident-analyzer/pulls -f title="SIO-1654: move pi-coms into packages/pi-coms (git subtree, workspace package, bundle from the subtree)" -f head=claude/sio-1654-pi-coms-subtree -f base=main -F draft=false -F body=@<scratchpad>/pr-1654.md --jq .number
```

Then: SIO-1654 to In Review with the PR link; `mcp__greptile__list_code_reviews` once for the head SHA (expect SKIPPED, SIO-1642); watch the five CI jobs (`gh pr checks <n>`); report the gate state to the user and STOP. Merge only on the user's explicit go-ahead with `gh pr merge <n> --squash` (no `--delete-branch` from a worktree), then append the ledger row and detail section to `docs/code-review-bakeoff.md` on a short `docs:` commit pushed with `git push origin HEAD:main` after verifying `git merge-base --is-ancestor`.

- [ ] **Step 3: Post-merge, user-run steps (not this session)**

Recorded on SIO-1654 as the acceptance path: `./packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-<hub-account-id> eu-shared-services-dev` from a clean main, converge one dev host, confirm the daily digest carries the new `.bundle-version`, `pi install <checkout>/packages/pi-coms -l` on a laptop and `just coms laptop` against the dev hub. Only then archive `zx8086/pi-coms` read-only with a README pointer. None of this runs without the user's AWS credentials and go-ahead.

---

# Phase 0: SIO-1635, land #682 and remove the two-agent and single-hub assumptions

Branch: `claude/sio-1635-phase0-hub-map`. Base: `origin/main` after PR #682 is merged. If #682 is not merged when Phase 0b is done, base the branch on the rebased `claude/pi-agent-devops-incident-0378d5` and open the PR with `-f base=claude/pi-agent-devops-incident-0378d5`, retargeting to main after #682 merges (`gh api -X PATCH repos/zx8086/devops-incident-analyzer/pulls/<n> -f base=main`).

## File structure after Phase 0

```
packages/agent/src/memory-backend.ts             AGENT_MEMORY_IDENTITIES map, resolveAgentMemoryIdentity, resolveRole exported, roleForUserId
packages/agent/src/memory-backend.test.ts        identity tests
packages/shared/src/config.ts                    PiComsEnvironmentSchema, PiComsHubConfigSchema, PiComsConfigSchema with hubs
packages/shared/src/index.ts                     exports
packages/agent/src/action-tools/pi-coms-client.ts   hub-scoped client, senderPrefix, public heartbeat, mailbox(), resolvePiComsConfig, isPiComsConfigured, wire types from @devops-agent/pi-coms/contracts
packages/agent/src/action-tools/pi-coms-client.test.ts
packages/agent/src/action-tools/pi-verifier.ts   environmentForEstate, selectHubForEstate, per-environment routing
packages/agent/src/action-tools/pi-verifier.test.ts
packages/agent/package.json                      + "@devops-agent/pi-coms": "workspace:*" (asks first)
.env.example                                     PI_COMS_HUBS, PI_COMS_NET_ENVIRONMENT
docs/architecture/pi-coms-verification.md        Configuration section: hubs map
```

### Task 0.1: Rebase and land PR #682

**Files:**
- Modify (on `claude/pi-agent-devops-incident-0378d5`): `docs/code-review-bakeoff.md` (conflict resolution only)

- [ ] **Step 1: Rebase**

```bash
git fetch origin
git checkout -B claude/pi-agent-devops-incident-0378d5 origin/claude/pi-agent-devops-incident-0378d5
git rebase origin/main
```

Expected: one conflict in `docs/code-review-bakeoff.md`. Resolve by keeping main's rows and sections and re-inserting the `#682` table row in PR-number order (between #681 and #683) and the `## PR #682 detail` section between the #681 and #683 detail sections. `git add docs/code-review-bakeoff.md && GIT_EDITOR=true git rebase --continue`. Verify: `git diff origin/main --stat` shows 21 files as before.

- [ ] **Step 2: Gate and push**

```bash
bun install && git diff --stat package.json bun.lock
bun run typecheck && bun run lint
cd packages/agent && bun test --isolate src/action-tools src/mitigation.pi.test.ts; cd -
cd packages/shared && bun test; cd -
cd apps/web && bun run test -- src/lib/components/ActionConfirmationCard.test.ts src/lib/stores/agent.handleEvent.test.ts; cd -
git push --force-with-lease origin claude/pi-agent-devops-incident-0378d5
```

- [ ] **Step 3: Hand the merge decision to the user**

Report: the PR is rebased and green; merge requires (a) the `incident-analyzer` principal minted on the hub that `PI_COMS_NET_SERVER_URL` points at (`just token-create incident-analyzer "incident-analyzer-*" service <profile>` from the repo root after Phase 0b; the only deployed hub reads `/pi-coms/auth` in eu-shared-services-dev), (b) the user's smoke test through `just hub-tunnel`, (c) the explicit merge go-ahead. STOP here until the user answers; continue with Task 0.2 on the stacked branch in the meantime only if the user says so.

### Task 0.2: Agent Memory identity map

**Files:**
- Modify: `packages/agent/src/memory-backend.ts:81-91,430`
- Test: `packages/agent/src/memory-backend.test.ts:180-193`

**Interfaces:**
- Produces: `resolveAgentMemoryIdentity(agentName): { userId: string; role: string }` (throws on unknown), `resolveUserId(agentName)`, `resolveRole(agentName)` (now exported), `roleForUserId(userId)`.

- [ ] **Step 1: Write the failing tests**

Replace the `maps each agent to its own user id` test (lines 188-192) with:

```ts
	test("maps each registered agent to its own user id and role", () => {
		expect(resolveUserId("incident-analyzer")).toBe("incident-analyzer");
		expect(resolveUserId("elastic-iac")).toBe("elastic-iac");
		expect(resolveRole("incident-analyzer")).toBe("incident-correlator");
		expect(resolveRole("elastic-iac")).toBe("iac-maker");
		expect(roleForUserId("elastic-iac")).toBe("iac-maker");
	});

	test("an unregistered agent name throws instead of sharing the incident-analyzer user (SIO-1635 Phase 0)", () => {
		expect(() => resolveUserId("pi-fleet")).toThrow('No Agent Memory identity registered for agent "pi-fleet"');
		expect(() => resolveRole("pi-fleet")).toThrow("pi-fleet");
		expect(() => roleForUserId("nobody")).toThrow('No Agent Memory identity has user id "nobody"');
	});
```

Add `resolveRole, roleForUserId` to the file's import from `./memory-backend.ts`.

- [ ] **Step 2: Run to see them fail**

```bash
cd packages/agent && bun test --isolate src/memory-backend.test.ts -t "registered agent|unregistered agent"
```

Expected: FAIL (`resolveRole` not exported, `roleForUserId` undefined, `"pi-fleet"` returns `incident-analyzer`).

- [ ] **Step 3: Implement**

Replace lines 81-91 of `memory-backend.ts`:

```ts
// Agent identity -> Agent Memory user_id and role. One user per agent (SIO-938
// decision 3; role recorded as user metadata, SIO-952). The map is explicit and
// an unregistered agent throws at first use, so a new agent can never silently
// share another agent's memory (SIO-1635 Phase 0).
type AgentMemoryIdentity = { userId: string; role: string };

const AGENT_MEMORY_IDENTITIES: Readonly<Record<string, AgentMemoryIdentity>> = {
	"incident-analyzer": { userId: "incident-analyzer", role: "incident-correlator" },
	"elastic-iac": { userId: "elastic-iac", role: "iac-maker" },
};

export function resolveAgentMemoryIdentity(agentName: string): AgentMemoryIdentity {
	const identity = AGENT_MEMORY_IDENTITIES[agentName];
	if (!identity) {
		throw new Error(
			`No Agent Memory identity registered for agent "${agentName}"; add it to AGENT_MEMORY_IDENTITIES in memory-backend.ts`,
		);
	}
	return identity;
}

export function resolveUserId(agentName: string): string {
	return resolveAgentMemoryIdentity(agentName).userId;
}

export function resolveRole(agentName: string): string {
	return resolveAgentMemoryIdentity(agentName).role;
}

// For call sites that only hold the resolved user id (the write-behind queue).
export function roleForUserId(userId: string): string {
	const hit = Object.values(AGENT_MEMORY_IDENTITIES).find((identity) => identity.userId === userId);
	if (!hit) throw new Error(`No Agent Memory identity has user id "${userId}"`);
	return hit.role;
}
```

Line 430: `{ agent: w.ref.userId, role: roleForUserId(w.ref.userId) },`.

- [ ] **Step 4: Run the whole file and the package**

```bash
cd packages/agent && bun test --isolate src/memory-backend.test.ts && bun test --isolate; cd -
grep -rn "resolveUserId\|resolveRole" packages/agent/src --include=*.ts | grep -v memory-backend
```

Expected: all pass. If any other test (memory-writer, lifecycle, web server tests) fails because it passes an unregistered agent name into the agent-memory backend, change that fixture to `incident-analyzer` or `elastic-iac`; do not widen the map.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/memory-backend.ts packages/agent/src/memory-backend.test.ts
git commit -F - <<'MSG'
SIO-1635: explicit Agent Memory identity map; unknown agents throw instead of sharing incident-analyzer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0.3: Per-environment hub config schema and resolver

**Files:**
- Modify: `packages/shared/src/config.ts:45-56`, `packages/shared/src/index.ts` (export the two new schemas and types), `packages/agent/src/action-tools/pi-coms-client.ts` (config resolver moves here), `packages/agent/src/action-tools/pi-verifier.ts:24-27,68-120` (resolver removed), `.env.example:428-444`
- Test: `packages/shared/src/config.test.ts` (or the nearest existing config test file; create `packages/shared/src/pi-coms-config.test.ts` if none covers `PiComsConfigSchema`), `packages/agent/src/action-tools/pi-coms-client.test.ts`

**Interfaces:**
- Produces: `PiComsEnvironmentSchema` (`"dev" | "stg" | "prd"`), `PiComsHubConfigSchema` `{ serverUrl, authToken, project, fallbackTarget }`, `PiComsConfigSchema` `{ hubs: Partial<Record<PiComsEnvironment, PiComsHubConfig>> (non-empty), estateAgentMap, verifyTimeoutMs, investigateTimeoutMs }`; in the client module: `isPiComsConfigured(env)`, `resolvePiComsConfig(env)`, constants `PI_COMS_DEFAULT_PROJECT`, `PI_COMS_DEFAULT_FALLBACK_TARGET`.

- [ ] **Step 1: Confirm `z.partialRecord` under the pinned zod**

```bash
cd packages/shared && bun -e 'import { z } from "zod"; console.log(typeof z.partialRecord, z.partialRecord(z.enum(["dev","prd"]), z.string()).parse({ prd: "x" }))'
```

Expected: `function { prd: "x" }`. If `partialRecord` is missing, use `z.object({ dev: PiComsHubConfigSchema.optional(), stg: ..., prd: ... })` instead and keep the same TypeScript type.

- [ ] **Step 2: Failing schema test**

```ts
// packages/shared/src/pi-coms-config.test.ts
import { describe, expect, test } from "bun:test";
import { PiComsConfigSchema } from "./config.ts";

const hub = { serverUrl: "http://hub.test", authToken: "t", project: "default", fallbackTarget: "ops" };

describe("PiComsConfigSchema (SIO-1635 Phase 0 hubs map)", () => {
	test("accepts a partial hubs map keyed by environment", () => {
		const parsed = PiComsConfigSchema.parse({ hubs: { prd: hub }, estateAgentMap: {}, verifyTimeoutMs: 1, investigateTimeoutMs: 1 });
		expect(Object.keys(parsed.hubs)).toEqual(["prd"]);
	});
	test("rejects an empty hubs map and unknown environments", () => {
		expect(() => PiComsConfigSchema.parse({ hubs: {}, estateAgentMap: {}, verifyTimeoutMs: 1, investigateTimeoutMs: 1 })).toThrow();
		expect(() => PiComsConfigSchema.parse({ hubs: { qa: hub }, estateAgentMap: {}, verifyTimeoutMs: 1, investigateTimeoutMs: 1 })).toThrow();
	});
});
```

Run: `cd packages/shared && bun test src/pi-coms-config.test.ts` -> FAIL (`hubs` unknown key today).

- [ ] **Step 3: Schema**

Replace lines 45-56 of `packages/shared/src/config.ts`:

```ts
// SIO-1635: pi-coms hub client config. One hub per environment (no cross-environment
// access, user decision 2026-09-06); the estate name suffix selects the hub. No
// .default() here (project rule); defaults are applied in resolvePiComsConfig
// (packages/agent/src/action-tools/pi-coms-client.ts).
export const PiComsEnvironmentSchema = z.enum(["dev", "stg", "prd"]);
export type PiComsEnvironment = z.infer<typeof PiComsEnvironmentSchema>;

export const PiComsHubConfigSchema = z.object({
	serverUrl: z.string().url(),
	authToken: z.string().min(1),
	project: z.string().min(1),
	fallbackTarget: z.string().min(1),
});
export type PiComsHubConfig = z.infer<typeof PiComsHubConfigSchema>;

export const PiComsConfigSchema = z.object({
	hubs: z
		.partialRecord(PiComsEnvironmentSchema, PiComsHubConfigSchema)
		.refine((hubs) => Object.keys(hubs).length > 0, { message: "at least one hub must be configured" }),
	estateAgentMap: z.record(z.string(), z.string()),
	verifyTimeoutMs: z.number().int().positive(),
	investigateTimeoutMs: z.number().int().positive(),
});
export type PiComsConfig = z.infer<typeof PiComsConfigSchema>;
```

Export `PiComsEnvironmentSchema`, `PiComsEnvironment`, `PiComsHubConfigSchema`, `PiComsHubConfig` from `packages/shared/src/index.ts` next to the existing `PiComsConfigSchema` export. Run the schema test: PASS.

- [ ] **Step 4: Failing resolver tests (client module)**

Append to `pi-coms-client.test.ts`:

```ts
describe("resolvePiComsConfig (per-environment hubs)", () => {
	test("PI_COMS_HUBS json wins and fills project and fallback defaults per hub", () => {
		const cfg = resolvePiComsConfig({
			PI_COMS_HUBS: JSON.stringify({
				dev: { serverUrl: "http://dev.hub.test", authToken: "d" },
				prd: { serverUrl: "http://prd.hub.test", authToken: "p", project: "fleet", fallbackTarget: "ops-prd" },
			}),
		});
		expect(cfg.hubs.dev).toEqual({ serverUrl: "http://dev.hub.test", authToken: "d", project: "default", fallbackTarget: "ops" });
		expect(cfg.hubs.prd?.project).toBe("fleet");
		expect(cfg.hubs.stg).toBeUndefined();
	});

	test("the single-hub variables become a one-entry map for PI_COMS_NET_ENVIRONMENT (default dev)", () => {
		const cfg = resolvePiComsConfig({ PI_COMS_NET_SERVER_URL: "http://hub.test", PI_COMS_NET_AUTH_TOKEN: "t" });
		expect(Object.keys(cfg.hubs)).toEqual(["dev"]);
		const prd = resolvePiComsConfig({ PI_COMS_NET_SERVER_URL: "http://hub.test", PI_COMS_NET_AUTH_TOKEN: "t", PI_COMS_NET_ENVIRONMENT: "prd" });
		expect(Object.keys(prd.hubs)).toEqual(["prd"]);
	});

	test("a malformed PI_COMS_HUBS is a readable error, never a silent fallback", () => {
		expect(() => resolvePiComsConfig({ PI_COMS_HUBS: "{not json", PI_COMS_NET_SERVER_URL: "http://hub.test", PI_COMS_NET_AUTH_TOKEN: "t" })).toThrow("PI_COMS_HUBS");
		expect(() => resolvePiComsConfig({ PI_COMS_HUBS: JSON.stringify({ qa: { serverUrl: "http://x.test", authToken: "t" } }) })).toThrow("PI_COMS_HUBS");
	});

	test("isPiComsConfigured accepts either form", () => {
		expect(isPiComsConfigured({})).toBe(false);
		expect(isPiComsConfigured({ PI_COMS_HUBS: "{}" })).toBe(false);
		expect(isPiComsConfigured({ PI_COMS_HUBS: '{"dev":{"serverUrl":"http://x.test","authToken":"t"}}' })).toBe(true);
		expect(isPiComsConfigured({ PI_COMS_NET_SERVER_URL: "http://x.test", PI_COMS_NET_AUTH_TOKEN: "t" })).toBe(true);
	});
});
```

Add `isPiComsConfigured, resolvePiComsConfig` to the test's import. Run -> FAIL (not exported from the client).

- [ ] **Step 5: Move the resolver into the client module**

Delete `DEFAULT_PROJECT`, `DEFAULT_FALLBACK_TARGET`, `DEFAULT_VERIFY_TIMEOUT_MS`, `DEFAULT_INVESTIGATE_TIMEOUT_MS`, `isPiComsConfigured`, `readPositiveInt`, `readEstateAgentMap`, `resolvePiComsConfig` from `pi-verifier.ts` (lines 24-27 and 68-120) and add to `pi-verifier.ts` imports: `import { isPiComsConfigured, resolvePiComsConfig } from "./pi-coms-client.ts";` (re-export both from `pi-verifier.ts` so `executor.ts` and existing tests keep their import paths: `export { isPiComsConfigured, resolvePiComsConfig };`).

In `pi-coms-client.ts` add (after the imports; `getLogger` from `@devops-agent/observability`, `z` from `zod`, `PiComsConfigSchema`, `PiComsEnvironmentSchema`, `PiComsHubConfigSchema`, types from `@devops-agent/shared`):

```ts
const logger = getLogger("agent:action-tools:pi-coms-client");

export const PI_COMS_DEFAULT_PROJECT = "default";
export const PI_COMS_DEFAULT_FALLBACK_TARGET = "ops";
const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;
const DEFAULT_INVESTIGATE_TIMEOUT_MS = 900_000;
// The legacy single-hub variables describe one hub; this names its environment.
const DEFAULT_SINGLE_HUB_ENVIRONMENT: PiComsEnvironment = "dev";

const HubsJsonSchema = z.partialRecord(
	PiComsEnvironmentSchema,
	z.object({
		serverUrl: z.string().url(),
		authToken: z.string().min(1),
		project: z.string().min(1).optional(),
		fallbackTarget: z.string().min(1).optional(),
	}),
);

function nonEmpty(value: string | undefined): string | undefined {
	return value && value !== "" ? value : undefined;
}

function readHubs(env: NodeJS.ProcessEnv): Partial<Record<PiComsEnvironment, PiComsHubConfig>> {
	const raw = nonEmpty(env.PI_COMS_HUBS);
	if (raw !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(`PI_COMS_HUBS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const result = HubsJsonSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(`PI_COMS_HUBS is not a valid hubs map: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
		}
		const hubs: Partial<Record<PiComsEnvironment, PiComsHubConfig>> = {};
		for (const [environment, hub] of Object.entries(result.data)) {
			if (!hub) continue;
			hubs[environment as PiComsEnvironment] = {
				serverUrl: hub.serverUrl,
				authToken: hub.authToken,
				project: hub.project ?? PI_COMS_DEFAULT_PROJECT,
				fallbackTarget: hub.fallbackTarget ?? PI_COMS_DEFAULT_FALLBACK_TARGET,
			};
		}
		return hubs;
	}
	const serverUrl = nonEmpty(env.PI_COMS_NET_SERVER_URL);
	const authToken = nonEmpty(env.PI_COMS_NET_AUTH_TOKEN);
	if (!serverUrl || !authToken) return {};
	const environment = PiComsEnvironmentSchema.parse(nonEmpty(env.PI_COMS_NET_ENVIRONMENT) ?? DEFAULT_SINGLE_HUB_ENVIRONMENT);
	return {
		[environment]: {
			serverUrl,
			authToken,
			project: nonEmpty(env.PI_COMS_NET_PROJECT) ?? PI_COMS_DEFAULT_PROJECT,
			fallbackTarget: nonEmpty(env.PI_COMS_FALLBACK_TARGET) ?? PI_COMS_DEFAULT_FALLBACK_TARGET,
		},
	};
}

export function isPiComsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = nonEmpty(env.PI_COMS_HUBS);
	if (raw !== undefined) {
		try {
			const parsed: unknown = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
		} catch {
			return false;
		}
	}
	return !!nonEmpty(env.PI_COMS_NET_SERVER_URL) && !!nonEmpty(env.PI_COMS_NET_AUTH_TOKEN);
}
```

Then move `readPositiveInt` and `readEstateAgentMap` verbatim (they log through the module logger) and `resolvePiComsConfig` becomes:

```ts
// Defaults live here, not in the schema (project rule: no .default() in config schemas).
export function resolvePiComsConfig(env: NodeJS.ProcessEnv = process.env): PiComsConfig {
	return PiComsConfigSchema.parse({
		hubs: readHubs(env),
		estateAgentMap: readEstateAgentMap(env.PI_COMS_ESTATE_AGENT_MAP),
		verifyTimeoutMs: readPositiveInt(env.PI_COMS_VERIFY_TIMEOUT_MS, DEFAULT_VERIFY_TIMEOUT_MS, "PI_COMS_VERIFY_TIMEOUT_MS"),
		investigateTimeoutMs: readPositiveInt(env.PI_COMS_INVESTIGATE_TIMEOUT_MS, DEFAULT_INVESTIGATE_TIMEOUT_MS, "PI_COMS_INVESTIGATE_TIMEOUT_MS"),
	});
}
```

The `isPiComsConfigured` + `PI_COMS_HUBS: "{}"` case returns false, and `resolvePiComsConfig` on `{}` throws via the schema refine; `proposePiVerification` (Task 0.5) guards with `isPiComsConfigured` first and catches resolver errors.

- [ ] **Step 6: `.env.example`**

Replace the block at lines 428-444 with:

```
# === pi-coms hub (SIO-1635) ===
# One hub per environment; no cross-environment access. The estate name suffix
# (-dev, -stg, -prd) picks the hub. Preferred form: a JSON map keyed by
# environment (project defaults to "default", fallbackTarget to "ops"):
# PI_COMS_HUBS='{"dev":{"serverUrl":"http://127.0.0.1:8787","authToken":"<dev token>"},"prd":{"serverUrl":"http://127.0.0.1:8788","authToken":"<prd token>"}}'
PI_COMS_HUBS=
# Single-hub form (kept for one-hub setups): the same hub, and the environment it
# serves (default dev). A prd estate then gets a readable "no hub" error, never the dev hub.
PI_COMS_NET_SERVER_URL=
# Bearer token. In directory mode the token's principal must allow the name
# pattern "incident-analyzer-*" (each action registers a fresh suffixed name).
PI_COMS_NET_AUTH_TOKEN=
PI_COMS_NET_ENVIRONMENT=
# Hub project the agents registered under (default: default)
PI_COMS_NET_PROJECT=
# Durable inbox used when the estate agent is offline (default: ops)
PI_COMS_FALLBACK_TARGET=
# Optional JSON map from estate id to agent name when they differ, e.g.
# {"<estate-id>":"<agent-name>"}. Unmapped estates use the estate id as the name.
PI_COMS_ESTATE_AGENT_MAP=
# Wait budgets for the agent reply, in milliseconds (defaults: 300000 and 900000).
# The hub is polled in 25 s slices with a heartbeat between slices.
PI_COMS_VERIFY_TIMEOUT_MS=
PI_COMS_INVESTIGATE_TIMEOUT_MS=
```

- [ ] **Step 7: Run and commit**

```bash
cd packages/shared && bun test; cd -
cd packages/agent && bun test --isolate src/action-tools/pi-coms-client.test.ts; cd -
bun run typecheck
```

Expected: the four new client tests pass; typecheck fails inside `pi-verifier.ts` and the client (they still read `config.serverUrl`); Task 0.4 and 0.5 fix that. Commit only after Task 0.5 makes typecheck green (one commit per task is fine, but never commit a red typecheck).

### Task 0.4: Client: hub-scoped, sender prefix, public heartbeat, mailbox, contract import

**Files:**
- Modify: `packages/agent/src/action-tools/pi-coms-client.ts`, `packages/agent/package.json` (one dependency, asks first)
- Test: `packages/agent/src/action-tools/pi-coms-client.test.ts`

**Interfaces:**
- Produces: `new PiComsClient(hub: PiComsHubConfig, deps?: { fetchImpl?; now?; sessionId?; senderPrefix? })`; `senderNameFor(sessionId, prefix = PI_COMS_SENDER_NAME_PREFIX)`; `heartbeat()` public; `mailbox(name, { limit?, since? }): Promise<InboxMessage[]>`; types `PiAgentCard`, `PiMessageStatus`, `PiSendResult`, `PiReply`, `PiSendOptions` unchanged in shape for callers.

- [ ] **Step 1: Ask about the dependency, then add it**

Ask the user: "Task 0.4 adds `"@devops-agent/pi-coms": "workspace:*"` to `packages/agent/package.json` dependencies so the hub client imports the wire types from `@devops-agent/pi-coms/contracts`. OK?" On yes: add it alphabetically after `@devops-agent/observability`, run `bun install`, check `git diff --stat package.json bun.lock` (root manifest unchanged), and confirm `ls packages/agent/node_modules/@devops-agent/pi-coms/contracts`. On no: keep the local mirror types and record the decision on SIO-1635.

- [ ] **Step 2: Failing tests**

Update the existing `config` constant in `pi-coms-client.test.ts` to a hub:

```ts
const hub: PiComsHubConfig = { serverUrl: "http://hub.test", authToken: "tok", project: "default", fallbackTarget: "ops" };
```

(rename every `new PiComsClient(config, ...)` to `new PiComsClient(hub, ...)` and `config.serverUrl` to `hub.serverUrl`), then add:

```ts
	test("senderNameFor accepts a prefix and the client registers with it", async () => {
		expect(senderNameFor("abcd1234-x", "fleet-inbox")).toBe("fleet-inbox-abcd1234");
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true } })]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1", senderPrefix: "fleet-inbox" });
		await client.register();
		expect((calls[0]?.body as Record<string, unknown>).name).toBe("fleet-inbox-sid1");
	});

	test("heartbeat is public and posts the online status", async () => {
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true } })]);
		const client = new PiComsClient(hub, { fetchImpl, sessionId: "sid-1" });
		await client.heartbeat();
		expect(calls[0]?.path).toBe("/v1/agents/sid-1/heartbeat");
		expect((calls[0]?.body as Record<string, unknown>).status).toBe("online");
	});

	test("mailbox reads the durable inbox with project, name, limit and since", async () => {
		const message = { msg_id: "01H", sender_name: "monitor-aws-1", target_name: "ops", prompt: "p", status: "queued", error: null, response: null, created_at: "t", delivered_at: null, completed_at: null };
		const { calls, fetchImpl } = scripted([() => ({ body: { ok: true, name: "ops", messages: [message] } })]);
		const client = new PiComsClient(hub, { fetchImpl });
		const messages = await client.mailbox("ops", { limit: 5, since: "01G" });
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.path).toBe("/v1/mailbox?project=default&name=ops&limit=5&since=01G");
		expect(messages).toEqual([message]);
	});
```

Run: `cd packages/agent && bun test --isolate src/action-tools/pi-coms-client.test.ts` -> FAIL.

- [ ] **Step 3: Implement**

In `pi-coms-client.ts`:

```ts
import type { AgentCard, InboxListing, InboxMessage, MessageStatus, SendResponse } from "@devops-agent/pi-coms/contracts";
import type { PiComsConfig, PiComsEnvironment, PiComsHubConfig } from "@devops-agent/shared";

export type PiMessageStatus = MessageStatus;
// The subset of the hub's agent card the verifier routes on.
export type PiAgentCard = Pick<AgentCard, "session_id" | "name" | "status"> & Partial<Pick<AgentCard, "purpose">>;
export type PiSendResult = Pick<SendResponse, "msg_id" | "status" | "target_session">;
export type { InboxMessage };
```

(If a field name in `contracts/wire.ts` differs from these, change the Pick to the contract's name and update the one test literal; never re-declare the shape locally.)

```ts
export function senderNameFor(sessionId: string, prefix: string = PI_COMS_SENDER_NAME_PREFIX): string {
	return `${prefix}-${sessionId.replace(/-/g, "").slice(0, 8)}`;
}

export type PiComsClientDeps = { fetchImpl?: FetchLike; now?: () => number; sessionId?: string; senderPrefix?: string };

export class PiComsClient {
	readonly sessionId: string;
	private readonly hub: PiComsHubConfig;
	private readonly senderPrefix: string;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private registered = false;

	constructor(hub: PiComsHubConfig, deps: PiComsClientDeps = {}) {
		this.hub = hub;
		this.senderPrefix = deps.senderPrefix ?? PI_COMS_SENDER_NAME_PREFIX;
		this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
		this.now = deps.now ?? (() => Date.now());
		this.sessionId = deps.sessionId ?? crypto.randomUUID();
	}
```

(The `http`, `listAgents`, `send`, `awaitReply` and `deregister` bodies stay as they are on the #682 branch apart from the `this.config` to `this.hub` rename.)

Replace every `this.config.` with `this.hub.`; `register()` uses `senderNameFor(this.sessionId, this.senderPrefix)`; change `private async heartbeat()` to `async heartbeat()`; add:

```ts
	// The durable inbox: read-many, non-destructive, open to every authenticated
	// peer. `since` is the hub's ULID cursor; `limit` is capped at 100 by the hub.
	async mailbox(name: string, opts: { limit?: number; since?: string } = {}): Promise<InboxMessage[]> {
		const params = new URLSearchParams({ project: this.hub.project, name });
		if (opts.limit !== undefined) params.set("limit", String(opts.limit));
		if (opts.since !== undefined) params.set("since", opts.since);
		const reply = await this.http<InboxListing>("GET", `/v1/mailbox?${params.toString()}`);
		return reply.messages ?? [];
	}
```

- [ ] **Step 4: Run**

```bash
cd packages/agent && bun test --isolate src/action-tools/pi-coms-client.test.ts; cd -
```

Expected: 16 pass. Typecheck still red in `pi-verifier.ts` until Task 0.5.

### Task 0.5: Verifier: environment resolution and per-hub routing

**Files:**
- Modify: `packages/agent/src/action-tools/pi-verifier.ts`
- Test: `packages/agent/src/action-tools/pi-verifier.test.ts`, `packages/agent/src/mitigation.pi.test.ts` (no change expected; confirm)

**Interfaces:**
- Produces: `environmentForEstate(estate): PiComsEnvironment | undefined`, `selectHubForEstate(estate, config): { ok: true; environment; hub } | { ok: false; error }`; card params gain `environment: PiComsEnvironment`.

- [ ] **Step 1: Failing tests**

In `pi-verifier.test.ts`, change `scriptedHub` to record absolute URLs (`calls.push({ method, path, url: input })` with `url: string` in `Call`) and route on `new URL(input).pathname + search`. Replace the `env` constant with a two-hub map and add tests:

```ts
const env: NodeJS.ProcessEnv = {
	PI_COMS_HUBS: JSON.stringify({
		dev: { serverUrl: "http://dev.hub.test", authToken: "d" },
		prd: { serverUrl: "http://prd.hub.test", authToken: "p" },
	}),
};

describe("environment routing (no cross-environment access)", () => {
	test("environmentForEstate reads the suffix and treats -prod as prd", () => {
		expect(environmentForEstate("eu-oit-dev")).toBe("dev");
		expect(environmentForEstate("eu-b2b-stg")).toBe("stg");
		expect(environmentForEstate("eu-oit-prd")).toBe("prd");
		expect(environmentForEstate("eu-b2b-prod")).toBe("prd");
		expect(environmentForEstate("eu-oit")).toBeUndefined();
	});

	test("selectHubForEstate refuses unknown suffixes and unconfigured environments", () => {
		const config = resolvePiComsConfig(env);
		expect(selectHubForEstate("eu-oit-prd", config)).toEqual({ ok: true, environment: "prd", hub: config.hubs.prd });
		expect(selectHubForEstate("eu-b2b-stg", config)).toMatchObject({ ok: false, error: expect.stringContaining('no pi-coms hub configured for environment "stg"') });
		expect(selectHubForEstate("eu-oit", config)).toMatchObject({ ok: false, error: expect.stringContaining("no recognised environment suffix") });
	});

	test("a prd estate only ever talks to the prd hub", async () => {
		const { calls, fetchImpl } = scriptedHub({ agents: online, reply: confirmedVerdict });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { fetchImpl, env });
		expect(out.status).toBe("success");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.url.startsWith("http://prd.hub.test/"))).toBe(true);
	});

	test("a dev estate only ever talks to the dev hub", async () => {
		const { calls, fetchImpl } = scriptedHub({ agents: [{ session_id: "s1", name: "eu-oit-dev", status: "online" }], reply: confirmedVerdict });
		await executePiVerify({ estate: "eu-oit-dev" }, report, { fetchImpl, env });
		expect(calls.every((c) => c.url.startsWith("http://dev.hub.test/"))).toBe(true);
	});

	test("an estate with no hub is a readable error and makes no hub call", async () => {
		const { calls, fetchImpl } = scriptedHub({ agents: online });
		const out = await executePiVerify({ estate: "eu-b2b-stg" }, report, { fetchImpl, env });
		expect(out).toMatchObject({ status: "error", error: expect.stringContaining('environment "stg"') });
		expect(calls).toEqual([]);
	});

	test("proposePiVerification skips estates without a hub and orders cards by environment", () => {
		const cards = proposePiVerification({ ...baseState, awsTargetEstates: ["eu-oit-prd", "eu-b2b-stg", "eu-oit-dev"] }, env);
		expect(cards.map((c) => [c.params.environment, c.params.estate])).toEqual([["dev", "eu-oit-dev"], ["prd", "eu-oit-prd"]]);
	});

	test("proposePiVerification yields no cards on a malformed hubs map", () => {
		expect(proposePiVerification(baseState, { PI_COMS_HUBS: "{oops" })).toEqual([]);
	});
});
```

Move `baseState` to file scope (it is currently inside `describe("proposePiVerification")`). Existing tests that used the single-hub `env` keep working because the single-hub form maps to `dev` and their estate fixtures are `eu-oit-prd`: change those fixtures' expectation where needed by giving the old `env` a `PI_COMS_NET_ENVIRONMENT: "prd"` entry in a second constant `singleHubPrdEnv` used by the pre-existing execute tests. Run -> FAIL.

- [ ] **Step 2: Implement**

In `pi-verifier.ts`:

```ts
import type { PiComsEnvironment, PiComsHubConfig } from "@devops-agent/shared";

// Environment from the estate name suffix. Estate ids are free-form (keys of
// AWS_ESTATES), so this is the only convention the router relies on; anything
// else is refused rather than guessed (no cross-environment access).
const ESTATE_ENVIRONMENT_SUFFIXES: ReadonlyArray<readonly [suffix: string, environment: PiComsEnvironment]> = [
	["-dev", "dev"],
	["-stg", "stg"],
	["-prd", "prd"],
	["-prod", "prd"],
];

export function environmentForEstate(estate: string): PiComsEnvironment | undefined {
	return ESTATE_ENVIRONMENT_SUFFIXES.find(([suffix]) => estate.endsWith(suffix))?.[1];
}

export type HubSelection =
	| { ok: true; environment: PiComsEnvironment; hub: PiComsHubConfig }
	| { ok: false; error: string };

export function selectHubForEstate(estate: string, config: Pick<PiComsConfig, "hubs">): HubSelection {
	const environment = environmentForEstate(estate);
	if (!environment) {
		return { ok: false, error: `estate "${estate}" has no recognised environment suffix (-dev, -stg, -prd); refusing to pick a hub` };
	}
	const hub = config.hubs[environment];
	if (!hub) {
		return { ok: false, error: `no pi-coms hub configured for environment "${environment}" (estate "${estate}"); set PI_COMS_HUBS` };
	}
	return { ok: true, environment, hub };
}
```

`PiVerifyParamsSchema` and `PiInvestigateParamsSchema` gain `environment: PiComsEnvironmentSchema.optional()` (informational on the card). `resolvePiTarget` takes `config: Pick<PiComsConfig, "estateAgentMap"> & Pick<PiComsHubConfig, "fallbackTarget">` and the call site passes `{ estateAgentMap: input.config.estateAgentMap, fallbackTarget: hub.fallbackTarget }`.

`runHubTask`:

```ts
	const selection = selectHubForEstate(input.estate, input.config);
	if (!selection.ok) return { kind: "failed", error: selection.error };
	const client = new PiComsClient(selection.hub, { fetchImpl: input.deps.fetchImpl, now: input.deps.now });
```

`proposePiVerification`:

```ts
	if (!isPiComsConfigured(env)) return [];
	...
	let config: PiComsConfig;
	try {
		config = resolvePiComsConfig(env);
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "pi-coms config invalid; no verification cards");
		return [];
	}
	const routed = estates.flatMap((estate) => {
		const selection = selectHubForEstate(estate, config);
		if (!selection.ok) {
			logger.warn({ estate, reason: selection.error }, "Skipping verify card: no hub for estate");
			return [];
		}
		return [{ estate, environment: selection.environment }];
	});
	routed.sort((a, b) => a.environment.localeCompare(b.environment) || a.estate.localeCompare(b.estate));
	return routed.slice(0, MAX_VERIFY_CARDS).map(({ estate, environment }) => {
		const params: PiVerifyParams = { estate, environment, target: preferredTargetForEstate(estate, config), ... };
		...
	});
```

(In the `params` literal above, the `severity`, `confidence`, `summary`, `rootCauseDataSources` and `caveats` fields stay exactly as on the #682 branch; only `environment` is new.) `buildInvestigateFollowUp` copies `environment` from the verify params into the investigate params.

- [ ] **Step 3: Run everything**

```bash
bun run typecheck && bun run lint
cd packages/agent && bun test --isolate src/action-tools src/mitigation.pi.test.ts && bun test --isolate; cd -
cd packages/shared && bun test; cd -
cd apps/web && bun run test -- src/lib/components/ActionConfirmationCard.test.ts src/lib/stores/agent.handleEvent.test.ts src/routes/api/agent; cd -
```

Expected: all green. `mitigation.pi.test.ts` still passes because its fixtures use the single-hub variables (mapped to `dev`) with estates `eu-oit-prd` and `eu-shared-services-prd`: it will now produce zero cards. Update that test's setup to `process.env.PI_COMS_NET_ENVIRONMENT = "prd"` and keep its assertions.

- [ ] **Step 4: Commit Tasks 0.3 to 0.5 together (typecheck is green only now)**

```bash
git add packages/shared/src/config.ts packages/shared/src/index.ts packages/shared/src/pi-coms-config.test.ts packages/agent/src/action-tools packages/agent/package.json bun.lock .env.example
git commit -F - <<'MSG'
SIO-1635: per-environment pi-coms hubs (PI_COMS_HUBS), hub chosen by estate suffix, never across environments

The client is scoped to one hub, takes a sender prefix, exposes heartbeat and
reads the durable mailbox; the config resolver moves next to it; the wire
types come from @devops-agent/pi-coms/contracts. Unknown suffixes and
unconfigured environments are readable card errors, never a send to the wrong
hub. Single-hub variables remain a one-entry map for PI_COMS_NET_ENVIRONMENT.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 0.6: Two-hub isolation smoke test (real hub code, no mocks)

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/peer.ts`, `<scratchpad>/drive.ts`

- [ ] **Step 1: Start two hubs from the package**

```bash
cd packages/pi-coms
S=<scratchpad>; mkdir -p $S/home-dev $S/home-prd
HOME=$S/home-dev PI_COMS_NET_HOST=127.0.0.1 PI_COMS_NET_PORT=52970 PI_COMS_NET_AUTH_TOKEN=devtok PI_COMS_NET_PROJECT=default bun scripts/coms-net-server.ts > $S/hub-dev.log 2>&1 &
DEV_PID=$!
HOME=$S/home-prd PI_COMS_NET_HOST=127.0.0.1 PI_COMS_NET_PORT=52971 PI_COMS_NET_AUTH_TOKEN=prdtok PI_COMS_NET_PROJECT=default bun scripts/coms-net-server.ts > $S/hub-prd.log 2>&1 &
PRD_PID=$!
sleep 1; curl -s -H "Authorization: Bearer prdtok" http://127.0.0.1:52971/v1/agents?project=default
```

- [ ] **Step 2: Throwaway peer on the prd hub**

`peer.ts` registers as `eu-oit-prd`, listens on the SSE stream and answers every `prompt` with a canned verdict object (an object, not a JSON string). The SSE path and event names are the ones `packages/pi-coms/tests/harness.ts` uses; copy them from there if the hub rejects the route below.

```ts
// <scratchpad>/peer.ts  -- throwaway prd-hub peer for the SIO-1635 isolation smoke
const HUB = "http://127.0.0.1:52971";
const TOKEN = "prdtok";
const session = crypto.randomUUID();
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (path: string, body: unknown) => fetch(HUB + path, { method: "POST", headers, body: JSON.stringify(body) });

await post("/v1/agents/register", { project: "default", session_id: session, name: "eu-oit-prd", purpose: "smoke peer", model: "none", color: "#000", cwd: "/tmp" });
const stream = await fetch(`${HUB}/v1/agents/${session}/events?project=default`, { headers: { authorization: `Bearer ${TOKEN}` } });
if (!stream.ok || !stream.body) throw new Error(`sse ${stream.status}`);
const verdict = { verdict: "confirmed", summary: "all good", claims: [{ claim: "c", status: "confirmed", evidence: "e" }] };
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
setInterval(() => post(`/v1/agents/${session}/heartbeat`, { project: "default", context_used_pct: 0, queue_depth: 0, status: "online" }), 10_000);
while (true) {
	const { value, done } = await reader.read();
	if (done) break;
	buffer += decoder.decode(value, { stream: true });
	let idx: number;
	while ((idx = buffer.indexOf("\n\n")) >= 0) {
		const frame = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 2);
		const event = /^event: (.*)$/m.exec(frame)?.[1];
		const data = /^data: (.*)$/m.exec(frame)?.[1];
		if (event !== "prompt" || !data) continue;
		const prompt = JSON.parse(data) as { msg_id: string };
		await post(`/v1/messages/${prompt.msg_id}/response`, { project: "default", session_id: session, response: verdict, error: null });
		console.log("answered", prompt.msg_id);
	}
}
```

Run `bun <scratchpad>/peer.ts & PEER_PID=$!` and confirm with `curl -s -H "Authorization: Bearer prdtok" "http://127.0.0.1:52971/v1/agents?project=default"` that `eu-oit-prd` is `online`.

- [ ] **Step 3: Drive the analyzer**

`drive.ts` in `packages/agent` context (`cd packages/agent && bun <scratchpad>/drive.ts`):

```ts
import { executePiVerify } from "./src/action-tools/pi-verifier.ts";
const env = { PI_COMS_HUBS: JSON.stringify({ dev: { serverUrl: "http://127.0.0.1:52970", authToken: "devtok" }, prd: { serverUrl: "http://127.0.0.1:52971", authToken: "prdtok" } }), PI_COMS_VERIFY_TIMEOUT_MS: "20000" };
console.log(JSON.stringify(await executePiVerify({ estate: "eu-oit-prd" }, "## Summary\n\n" + "x".repeat(200), { env }), null, 2));
console.log(JSON.stringify(await executePiVerify({ estate: "eu-oit-dev" }, "## Summary\n\n" + "x".repeat(200), { env }), null, 2));
console.log(JSON.stringify(await executePiVerify({ estate: "eu-oit" }, "## Summary\n\n" + "x".repeat(200), { env }), null, 2));
```

Expected: first call `status: success`, `result.kind: "verdict"`; second `kind: "queued"` to `ops` on the dev hub (no peer there); third `status: error` mentioning the suffix. Then:

```bash
grep -c "incident-analyzer-" $S/hub-prd.log; grep -c "incident-analyzer-" $S/hub-dev.log
grep -n "eu-oit-prd" $S/hub-dev.log ; echo "(must be empty)"
curl -s -H "Authorization: Bearer devtok" "http://127.0.0.1:52970/v1/mailbox?project=default&name=ops&limit=5"
```

Expected: the prd log has the prd registration and message, the dev log has only the dev registration and its queued message, and never the prd estate.

- [ ] **Step 4: Kill and prove**

```bash
kill $PEER_PID $DEV_PID $PRD_PID; sleep 1
lsof -nP -iTCP:52970 -sTCP:LISTEN; lsof -nP -iTCP:52971 -sTCP:LISTEN; echo "(both empty)"
```

Record the observed output in the PR body.

### Task 0.7: Docs and PR

**Files:**
- Modify: `docs/architecture/pi-coms-verification.md` (Configuration and Routing rule sections), `CLAUDE.md` (the SIO-1635 line), `experiments/HANDOFF-2026-09-06-pi-fleet-program.md` (status line), `docs/architecture/pi-fleet-gitagent-feasibility.md` (tracking row Phase 0)

- [ ] **Step 1: Docs**

`pi-coms-verification.md` Configuration: describe `PI_COMS_HUBS` (JSON keyed by `dev`, `stg`, `prd`, per-hub `serverUrl`, `authToken`, optional `project` and `fallbackTarget`), the single-hub fallback with `PI_COMS_NET_ENVIRONMENT`, and that one `incident-analyzer` principal is minted per hub. Routing rule: add the paragraph "The estate name suffix (`-dev`, `-stg`, `-prd`; `-prod` is read as prd) selects the hub before any online check. An unknown suffix or an environment without a hub is a readable error on the card; the analyzer never falls back to another environment's hub." CLAUDE.md: extend the SIO-1635 mention with "hubs are per environment (`PI_COMS_HUBS`); the Agent Memory identity map in `memory-backend.ts` throws for unregistered agents". Handover: "Status: Phase 0 implemented on PR #NNN." Tracking row: Phase 0 "In Review (PR #NNN)".

- [ ] **Step 2: Gate, push, PR**

```bash
bun run typecheck && bun run lint
cd packages/agent && bun test --isolate; cd -
cd packages/shared && bun test; cd -
cd apps/web && bun run test; cd -
git diff origin/main..HEAD | grep -nE '[0-9]{12}|simon|pvhcorp|tommy\.com' ; echo "(empty)"
git push -u origin claude/sio-1635-phase0-hub-map
gh api repos/zx8086/devops-incident-analyzer/pulls -f title="SIO-1635: per-environment pi-coms hubs, hub client mailbox and sender prefix, explicit Agent Memory identity map" -f head=claude/sio-1635-phase0-hub-map -f base=<main or the #682 branch> -F draft=false -F body=@<scratchpad>/pr-1635.md --jq .number
```

Then: SIO-1635 stays In Progress until #682 merges, then In Review with this PR; `list_code_reviews` once; report the gate; STOP for the user's merge go-ahead; ledger row after the decision.

---

## Verification (whole plan)

```bash
bun run typecheck && bun run lint && bun run test
cd packages/pi-coms && bun test                 # 32 files after 0b (30 imported + parity + publish-stage)
cd packages/agent && bun test --isolate
cd packages/shared && bun test
cd apps/web && bun run test
just --list                                     # root delegation present
git check-ignore -v packages/pi-coms/deploy/accounts/eu-oit-dev/terraform.tfvars
bash packages/pi-coms/deploy/publish-fleet.sh --stage-only && ls "$(bash packages/pi-coms/deploy/publish-fleet.sh --stage-only)"
```

Manual: Task 0.6 two-hub smoke (dev 52970, prd 52971) with the log assertions; after Phase 0b merges and only on the user's instruction: `./packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-<hub-account-id> eu-shared-services-dev`, converge a dev host, check the digest's bundle SHA.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `bun install --frozen-lockfile --production --omit=peer` rejects the freshly generated stage lockfile | Low | Task 0b.6 Step 4 fallback: one non-frozen production install; the test still asserts `bun.lock` exists |
| Root `biome check .` flags pi-coms sources under the root preset | Medium | Fix real findings in Task 0b.2; none are silenced without a ticket |
| pi-coms tests behave differently on Bun 1.3.14 than on 1.4.0 | Low | Report failures with output before changing anything |
| `bun install --cwd scripts` inside the workspace mutates the root lockfile | Low | Task 0b.2 Step 2 checks `git status` after the nested install |
| A test elsewhere feeds an unregistered agent name into the agent-memory backend after Task 0.2 | Medium | Change the fixture to a registered agent; never widen the map |
| `mitigation.pi.test.ts` and the web card tests assume the single-hub env means prd | Certain | Task 0.5 Step 3 sets `PI_COMS_NET_ENVIRONMENT=prd` in those fixtures |
| PR #682 not merged when Phase 0 starts | Likely | Stack the branch on the rebased #682 branch, retarget the PR later |
| Greptile skips both PRs | Certain (SIO-1642) | Merge only on explicit per-PR go-ahead; ledger rows after the decision |
| Publishing from the monorepo resolves deps differently on a host | Medium | Dev bucket first, one host, digest SHA check before prd; user-run |

## Out of scope

Phase 1 exporter (SIO-1649), fleet CLI (SIO-1653), hub pane (SIO-1650), inbox node (SIO-1652), skillflow handlers (SIO-1651); bumping pi-coms to TypeScript 6; the git-clone host path; hub protocol changes; archiving the pi-coms repo (user, after the dev publish converges); minting tokens; the corp-hub smoke test (user).
