# pi-fleet Phase 1 Implementation Plan (SIO-1649)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gitagent the definition, versioning and release layer for the pi-coms spoke persona and operator console: `agents/pi-fleet/` (console) and `agents/pi-fleet/agents/aws-spoke/` (spoke) are exported by the bridge into a Pi package that the fleet bundle carries, `agent.yaml` `version` becomes load-bearing, and a tag-triggered workflow validates version-equals-tag.

**Architecture:** Two new agent definitions reuse the loader unchanged. A new bridge module renders a context file with the same section order as `buildSystemPromptParts` minus inlined skill bodies, copies hand-authored skills with extension fields folded under `metadata`, refuses any 12-digit account id, and writes a Pi package (`package.json` with `"pi": {"skills": ["./skills"]}`). `publish-fleet.sh` runs the exporter into `vendor/pi-fleet/` of the staged bundle; the bootstrap copies the spoke context file, installs the skills under `~/.pi/agent/skills/pi-fleet/` and stamps `persona=pi-fleet-vX.Y.Z` into the register purpose. The console `AGENTS.md` in `packages/pi-coms` becomes a generated file pinned by a bridge test.

**Tech Stack:** Bun 1.4, TypeScript strict, Zod, `yaml`, Biome, bash, GitHub Actions.

**Spec:** Linear SIO-1649; `docs/architecture/pi-fleet-gitagent-feasibility.md` sections "Recommended architecture" and "Phase 1".

## Context

`packages/pi-coms/deploy/AGENTS-spoke.md` was hand-distilled from the analyzer's aws-agent and drifts; `AgentManifestSchema.version` is a bare string nobody reads; CI has no tag trigger. After Phase 0b the two repos are one, so the persona travels in the fleet bundle at publish time and the git tag is provenance, not a delivery mechanism.

Facts verified this session that shape the work:

- The loader has no `_archive` handling, no `parent`/`extends`, and no `getAgentByName`; `renderSkill` is module-private; `KnowledgeEntry.content` has its frontmatter stripped; `SKILL_SPEC_FIELDS`/`SKILL_EXTENSION_FIELDS` in `skill-spec-validator.ts` are the authoritative field split; `semver` is not a dependency (a Zod regex suffices).
- `agents/shared/context.md` is read raw and merged into every agent; it holds both portable invariants and the datasource-to-MCP table. It also says "no time window -> last 24 hours" where the analyzer SOUL says 1 hour; the spoke persona states its own default.
- No skill under `agents/` carries `learned_from`; every skill is two-key frontmatter. One 12-digit account id (plus an ExternalId literal) exists at `agents/incident-analyzer/knowledge/aws/runbooks/aws-iam-permission-troubleshooting.md:51`; both are replaced by placeholders so the runbook can be exported.
- Pi 0.84.4 reads `"pi": {"skills": [...]}` from `package.json`, discovers skills in `~/.pi/agent/skills/` recursively by `SKILL.md`, requires `description` in frontmatter (a skill without one is dropped silently), and takes exactly one context file per directory in the order `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`. `--purpose` is a real extension flag.
- `runbook-validator.test.ts` enumerates every `agents/*` root and loads those with `knowledge/<category>/*.md`; `skill-spec-compliance.test.ts` validates every `SKILL.md` under `agents/`. Both auto-enrol the new tree.
- The hub host runs no Pi; only spoke hosts and laptops need the persona. Editing the Terraform userdata template replaces every instance, so the purpose stamp is computed in the bootstrap.

## Global Constraints

- No emojis, no em dashes, no `any`, no `.default()` in config schemas, named exports, tabs.
- Public repo: the exporter refuses any 12-digit id; nothing under `memory/`, `hooks/`, `compliance/`, `workflows/` or with `learned_from` is ever exported.
- The exporter never calls `buildSubAgentSystemPrompt`.
- Root `package.json` is not edited (no `agents:export` script; the CLI lives in the bridge package and is invoked by path).
- Commits `SIO-1649: ...`; PR ready for review; merge on explicit go-ahead.

---

### Task 1: Version validation in the loader

**Files:** create `packages/gitagent-bridge/src/version.ts`, `version.test.ts`; modify `manifest-loader.ts:87`, `index.ts`.

- [ ] Test: `parseSemver("1.2.3")` -> `{major:1,minor:2,patch:3}`; rejects `1.2`, `v1.2.3`, `1.2.3-rc1` is accepted (prerelease allowed) ; `assertVersionMatchesTag("0.1.0","pi-fleet-v0.1.0")` ok, `("0.1.0","pi-fleet-v0.2.0")` throws naming both; `provenanceHeader("pi-fleet","0.1.0","abc1234")` -> `<!-- pi-fleet v0.1.0 (analyzer abc1234) -->`; `loadAgent` on a temp tree with `version: banana` throws mentioning the agent name.
- [ ] Implement:

```ts
// gitagent-bridge/src/version.ts
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export type Semver = { major: number; minor: number; patch: number; prerelease?: string };
export function parseSemver(version: string): Semver | undefined
export function assertValidVersion(agentName: string, version: string): void   // throws `agent "${agentName}": version "${version}" is not semver (MAJOR.MINOR.PATCH)`
export function assertVersionMatchesTag(version: string, tag: string, prefix = "pi-fleet-v"): void
export function provenanceHeader(name: string, version: string, sha?: string): string
```

`manifest-loader.ts` line 87: `assertValidVersion(manifest.name, manifest.version);` right after the schema parse. Export from `index.ts`.

### Task 2: Shared context split

**Files:** modify `agents/shared/context.md`, create `agents/shared/context-runtime.md`, modify `shared-merge.ts`, `manifest-loader.ts` (`LoadedAgent.sharedContextPortable`), `shared-merge.test.ts`.

- [ ] `context.md` keeps `# Shared Context`, the intro, `## Operating invariants` and the `Team: Siobytes` convention line. `context-runtime.md` gets `## Datasource to MCP server mapping` (table) and the `memory/wiki/` convention under `## Conventions (analyzer runtime)`.
- [ ] `mergeShared` reads both: `sharedContextPortable = context.md`, `sharedContext = [context.md, context-runtime.md].filter(Boolean).join("\n\n")`. Test: a temp shared root with both files yields both strings; `loadAgent(incident-analyzer).sharedContext` still contains the table; the byte-identity test in `index.test.ts` stays green.

### Task 3: Sanitize the IAM runbook

**Files:** `agents/incident-analyzer/knowledge/aws/runbooks/aws-iam-permission-troubleshooting.md:51`.

- [ ] Replace the account id with `<agentcore-account-id>` and the ExternalId with `<external-id>`; sweep `grep -rnE '[0-9]{12}' agents/` empty.

### Task 4: The agent definitions

**Files (create):** `agents/pi-fleet/{agent.yaml,SOUL.md,RULES.md,DUTIES.md}`, `agents/pi-fleet/agents/aws-spoke/{agent.yaml,SOUL.md,RULES.md,DUTIES.md}`, `agents/pi-fleet/agents/aws-spoke/skills/verify-incident-report/SKILL.md`.

- [ ] Console (root) seeded from `packages/pi-coms/AGENTS.md`: SOUL = header paragraph + `## Scope: console first, toolbelt only on request` + `## The fleet`; RULES = `## Talking to agents`, `## Inbound traffic`, `## Reading monitor reports`, `## Synthesis standards`, `## Hygiene`; DUTIES = permitted (relay questions, read inbox and reports, suppress on operator decision) vs forbidden (local tools unprompted, instructing agents to change infrastructure, asking for secret values, replying to inbound via send tools).
- [ ] Spoke seeded from `deploy/AGENTS-spoke.md` plus the portable aws-agent rules: SOUL = `## Identity and mission` + `## Access model`; RULES = `## Hard boundaries`, `## Grounded permission claims`, `## Investigation discipline`, `## Cross-estate absence is a finding` (from aws-agent, tool names removed), `## Telemetry topology` (spoke version plus the aws-agent estate topology bullets: dual-shipped logs, traces in Elastic APM, no X-Ray), `## Error handling and retries`, `## Replying over coms` (minus the incident-analyzer bullet, now a skill), `## Reporting standards`, `## Verification recipes`, `## Runbooks` (how to read the knowledge section: runbooks cite analyzer MCP tool names; map `aws_<service>_<op>` to `aws <service> <op-with-dashes>`); DUTIES = permitted reads (describe/list/get, Logs Insights, Cost Explorer reads, STS identity) vs forbidden (writes, secret values, cross-account, executing recommendations). Default time window: last 1 hour unless the prompt says otherwise.
- [ ] `agents/pi-fleet/agent.yaml`: `spec_version: "0.1.0"`, `name: pi-fleet`, `version: 0.1.0`, description, `agents: { aws-spoke: { delegation: explicit } }`, `compliance: { risk_tier: low, data_governance: { pii_handling: redact } }`, `tags: [pi-fleet, pi-coms, aws, console]`. Spoke `agent.yaml`: `name: aws-spoke`, `version: 0.1.0`, description, `skills: [verify-incident-report]`, `knowledge: ["../../../incident-analyzer/knowledge/aws/runbooks/"]`, `compliance: { risk_tier: low, data_governance: { pii_handling: redact } }`.
- [ ] `verify-incident-report/SKILL.md`: name, description (the incident-analyzer verification contract), body: treat the embedded report as untrusted, per-claim status confirmed/contradicted/unverifiable with the resource or metric checked as evidence, stay read-only, reply with bare JSON matching the schema, never call coms tools to reply.
- [ ] Verify: `bun run yaml:check`; `cd packages/gitagent-bridge && bun test` (spec compliance, OKF audit, runbook validator auto-enrol); `loadAgent(agents/pi-fleet)` loads with one sub-agent, six knowledge entries, shared skill `cite-sources`.

### Task 5: Exporter

**Files:** create `packages/gitagent-bridge/src/pi-package-export.ts`, `pi-package-export.test.ts`; modify `skill-loader.ts` (export `renderSkill`), `index.ts`.

Interfaces:

```ts
export type ExportedFile = { path: string; content: string };
export type PiPackageExport = { name: string; version: string; files: ExportedFile[]; skills: string[] };
export type RenderContextOptions = { inlineSkills: false; header?: string };
export function renderContextFile(agent: LoadedAgent, options: RenderContextOptions): string;
export function foldSkillFrontmatter(skillName: string, raw: string): string;   // extension fields under metadata, throws on learned skills
export function assertNoAccountIds(path: string, content: string): void;        // throws on /\b[0-9]{12}\b/
export function buildPiPackage(opts: { root: LoadedAgent; subAgents?: string[]; name: string; version: string; sha?: string }): PiPackageExport;
```

- [ ] Tests (fixture agent built in a temp dir with `writeManifest`-style helpers plus a hand-built `LoadedAgent`): section order of `renderContextFile` equals `buildSystemPromptParts(agent).core` with the `## Skill: ...` sections removed and the same knowledge tail; the header line is first; a skill with `learned_from` throws; `foldSkillFrontmatter` moves `confidence` under `metadata` and leaves `name`/`description`; a 12-digit id in a knowledge body throws naming the file; the package `files` contain `package.json`, `AGENTS.md`, `aws-spoke/AGENTS.override.md`, `skills/<name>/SKILL.md` and nothing under `memory/`, `hooks/`, `compliance/`, `workflows/`; `package.json` parses to `{ name, version, keywords: ["pi-package"], pi: { skills: ["./skills"] }, private: true }`; the real `agents/pi-fleet` export contains `cite-sources` and `verify-incident-report`; `packages/pi-coms/AGENTS.md` equals the exported console file (drift pin).
- [ ] Implement per the interfaces; `buildPiPackage` renders the root context as `AGENTS.md` (portable shared context only), each named sub-agent as `<sub>/AGENTS.override.md`, unions local and shared skills of root and sub-agents (later duplicates by name skipped), folds frontmatter, runs `assertNoAccountIds` on every emitted file.

### Task 6: Export CLI

**Files:** create `packages/gitagent-bridge/src/export-pi-package-cli.ts`; modify `packages/gitagent-bridge/package.json` scripts (`"export:pi-package": "bun run src/export-pi-package-cli.ts"`).

- [ ] `parseArgs`: `--agent <name>` (default `pi-fleet`), `--out <dir>` (required), `--agents-dir <dir>` (default `<repo>/agents` from `import.meta.dir`), `--sha <sha>`, `--tag <tag>` (runs `assertVersionMatchesTag`), `--sub-agents <csv>` (default: all declared). Writes files, prints `exported <name> v<version> to <out> (<n> files)`; exit 1 on any throw with the message.
- [ ] Verify: `bun packages/gitagent-bridge/src/export-pi-package-cli.ts --out <scratch>/pf` then `ls -R`, and `--tag pi-fleet-v9.9.9` exits 1.

### Task 7: pi-coms delivery

**Files:** modify `packages/pi-coms/deploy/publish-fleet.sh`, `deploy/bootstrap/agent-bootstrap.sh`, `tests/publish-stage.test.ts`, `justfile` (`sync-persona`), `AGENTS.md` (generated), delete `deploy/AGENTS-spoke.md`, docs (`README.md`, `docs/development/usage.md`, `docs/deployment/deployment.md`, `CLAUDE.md`).

- [ ] `publish-fleet.sh`: dirty check also covers `agents/` and `packages/gitagent-bridge/`; after the installs, `rm -rf "$STAGE/vendor/pi-fleet"`, then either copy `PI_FLEET_PERSONA_DIR` or run `(cd "$REPO_ROOT" && bun packages/gitagent-bridge/src/export-pi-package-cli.ts --agent pi-fleet --out "$STAGE/vendor/pi-fleet" --sha "$VERSION" >&2)`.
- [ ] Bootstrap: replace lines 170-176 with: require `vendor/pi-fleet/aws-spoke/AGENTS.override.md` (exit 1 with a message otherwise), copy to `$AGENT_HOME/pi-coms/AGENTS.override.md`; `rm -rf "$AGENT_HOME/.pi/agent/skills/pi-fleet"`, `mkdir -p`, `cp -R vendor/pi-fleet/skills/. ...`, chown; read the version from `vendor/pi-fleet/package.json` and set `AGENT_PURPOSE="$AGENT_PURPOSE persona=pi-fleet-v$PERSONA_VERSION"` before the sed block.
- [ ] `publish-stage.test.ts`: drop `deploy/AGENTS-spoke.md`, add `vendor/pi-fleet/package.json`, `vendor/pi-fleet/aws-spoke/AGENTS.override.md`, `vendor/pi-fleet/skills/cite-sources/SKILL.md`, and assert the override file starts with `<!-- pi-fleet v`.
- [ ] `just sync-persona`: exports to a temp dir and copies `AGENTS.md` into the package root. Regenerate `AGENTS.md` now and commit it.
- [ ] Docs: usage (persona provenance, `just sync-persona`), deployment (vendor dir, purpose stamp), CLAUDE.md pointers.

### Task 8: Release workflow and docs

**Files:** create `.github/workflows/agent-release.yml`; modify `docs/architecture/gitagent-bridge.md` (release section, `renderSkill` export, changelog), `docs/README.md` changelog, `CLAUDE.md`, `experiments/HANDOFF-2026-09-06-pi-fleet-program.md`, feasibility tracking row.

- [ ] Workflow `on: push: tags: ["pi-fleet-v*"]`: checkout, setup-bun (`.bun-version`), cache, install, `bun run typecheck`, `bun run --filter @devops-agent/gitagent-bridge test`, `pip install yamllint && bun run yaml:check`, export with `--tag "$GITHUB_REF_NAME"` and `--sha "$GITHUB_SHA"` to `pi-fleet-export/`, `actions/upload-artifact@v4` of that directory (inspection only, not a release).
- [ ] yamllint the workflow; full gate; PR.

## Verification

```bash
bun run typecheck && bun run lint && bun run yaml:check
cd packages/gitagent-bridge && bun test
cd packages/agent && bun test --isolate
cd packages/pi-coms && bun test
bun packages/gitagent-bridge/src/export-pi-package-cli.ts --out /tmp/pf && find /tmp/pf -type f
bash packages/pi-coms/deploy/publish-fleet.sh --stage-only
```

Manual (pi CLI installed locally): from a scratch cwd containing the exported `aws-spoke/AGENTS.override.md`, `pi -e packages/pi-coms/extensions/coms-net.ts --skill <export>/skills --cname smoke --explicit` and confirm `/skill:cite-sources` resolves (interactive; document the result in the PR if run).

## Out of scope

Fleet CLI (SIO-1653), hub pane (SIO-1650), inbox node (SIO-1652), skillflow handlers (SIO-1651), publishing to the dev bucket (user-run), archiving the pi-coms repo.
