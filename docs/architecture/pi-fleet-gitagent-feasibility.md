# pi-fleet on the gitagent bridge: feasibility report

Feasibility assessment for onboarding the pi-coms hub, spoke agents and console onto the gitagent definition and release layer of this repo. Written 2026-09-06 from a read-only survey of both repos; nothing here is implemented yet. Phases are tracked in Linear (see the end of this document).

Date 2026-09-06. Repos: `devops-incident-analyzer` (this worktree, main at `f2a2c146`) and `pi-coms` (main at `275cf6d`). Related: SIO-1635 (In Progress, analyzer PR #682 open, pi-coms PR #91 merged), gitagent alignment epics SIO-843/845/846/847/849 (Done), SIO-848 SkillsFlow and SIO-850 Knowledge Tree (Backlog).

## Verdict

Feasible, with one boundary that decides everything: gitagent can own the **definition, versioning and release** of the pi agents and the console, but it cannot own their **execution**. The spokes are Pi Coding Agent processes on EC2 hosts inside other AWS accounts, authenticated by instance roles, reachable only through the hub's outbound SSE stream. Turning them into in-process LangGraph sub-agents of the bridge would be a rewrite that discards the reason the fleet exists. This is also exactly the split the gitagent spec itself draws: "what ports cleanly: prompts, rules, roles, tool schemas; what stays in the framework: runtime orchestration, tool execution, memory I/O".

So the recommended shape is:

- **Definition layer (gitagent, this repo)**: a new root agent `agents/pi-fleet/` (the operator console persona) with one sub-agent `agents/pi-fleet/agents/aws-spoke/` (the account-agnostic spoke persona). Both are authored once, share `agents/shared/`, and reuse analyzer skills and AWS runbooks.
- **Release layer (the unused gitagent capabilities)**: make `agent.yaml` `version` load-bearing, tag releases `pi-fleet-vX.Y.Z`, and have CI validate, export a Pi package (AGENTS.override.md + skills + package.json with a `pi` manifest) and publish it as a release asset. pi-coms pins the version and vendors it into the fleet bundle it already ships from S3.
- **Runtime layer (unchanged)**: spokes stay Pi + coms-net, the hub stays the transport, the analyzer stays a hub service principal (PR #682).
- **Side by side / in sequence / after each other**: a hub pane in the web app for live inspection; a deterministic node that reads the hub's `ops` and estate inboxes into the pipeline (the passive live signal, no spoke turn); the #682 verify and investigate cards for sequencing (the active live check); the existing `packages/skillflow` executor with two new handlers for chained workflows.
- **Shared memory**: knowledge and skills are shared by release; verdicts flow back into the analyzer's live memory and knowledge graph as structured fields only; live memory access from spokes is deferred as a separate design because it adds a cross-account trust edge.

Total effort roughly 10 to 17 days across both repos depending on the side-by-side choice in Phase 2.

## What exists today

### Analyzer side

- `agents/` holds three roots (`incident-analyzer` with 7 sub-agents, `elastic-iac`, `shared`). A definition is `agent.yaml` + SOUL/RULES/DUTIES + `tools/*.yaml` + `skills/` + `knowledge/` + root-only `memory/` and `hooks/`. `agents/shared/{context.md,skills/}` is merged into every agent (`packages/gitagent-bridge/src/shared-merge.ts:59`).
- Any `agents/<name>/` directory loads by name with no code change: `packages/agent/src/prompt-context.ts:31` `getAgentByName` and `packages/agent/src/paths.ts:53` `getAgentsDir`.
- Prompt assembly is pure over the loaded agent: `packages/gitagent-bridge/src/skill-loader.ts:75` `buildSystemPromptParts` (SOUL, shared context, RULES, DUTIES, skills catalog, skill bodies, knowledge). Runtime-only sections (live memory, wiki, compliance boundary, sub-agent preamble) are added by callers, not by this function.
- **Versioning is declared and never read.** `AgentManifestSchema.version` is required (`types.ts:86`) and `spec_version` optional; a grep over `packages/` and `apps/` finds zero readers of either. No tag trigger in CI (`.github/workflows/ci.yml` runs on push to main and pull requests only). No release, changelog or promotion concept in the bridge. This is why the user calls these capabilities "unused": in gitagent they are patterns (a `version` field, git tags like `v1.1.0`, `validate` in CI, branch promotion), not runtime code.
- Sub-agent dispatch is hard-coded twice (`packages/agent/src/supervisor.ts:13` and `sub-agent.ts:390` `AGENT_NAMES`) and gated on MCP tool counts (`supervisor.ts:77`). Sub-agents run in-process as `createReactAgent` (`sub-agent.ts:1599`) and get no memory, wiki or graph by design.
- Two graphs already run side by side: `apps/web/src/lib/server/agent.ts:161-165` keeps two singletons; the agent is chosen by a string branch in `invokeAgent` (:377) and about nine two-way `=== "elastic-iac"` ternaries in that file, plus ~12 outside it (stream route enum, topology route, `+page.svelte:145` binary toggle, `AgentId` union at `stores/agent.svelte.ts:46`, `schedules.ts`, `memory-backend.ts:80` `resolveUserId`).
- SIO-1635 (PR #682, not on main): `verify-with-pi` and `investigate-with-pi` action cards. `packages/agent/src/action-tools/pi-coms-client.ts` is a plain HTTP hub client (register, list, send, sliced await with heartbeat, deregister) with injectable fetch; `pi-verifier.ts` does per-estate routing and prompts; `packages/shared/src/pi-coms-types.ts` holds the Zod verdict and investigation contracts. Design rule from its architecture doc: hub replies are rendered as data and never fed back into an LLM call.
- `packages/skillflow/` already exists (dag, template, executor, resolvers, triggers). `skill` and `tool` step handlers are registered by `incident-close-workflow-handlers.ts:117` and `resolve-identifiers-workflow-handlers.ts:165`; `agent`, `node` and `graph` kinds throw `MissingHandlerError` (`resolvers.ts:59`). SIO-848 is Backlog in Linear but the executor is real; only handlers are missing.

### pi-coms side

- Not LangGraph and not a monorepo. A spoke is one EC2 host per AWS account running the Pi Coding Agent CLI (Bedrock through the instance role) with `extensions/coms-net.ts` and an independent monitor. No tools YAML, no skills, no agent memory. Its only typed tools are the five coms tools; AWS access is the `aws` CLI under the vendored read-only policies that mirror the analyzer's role.
- The spoke persona is `deploy/AGENTS-spoke.md`, copied to `AGENTS.override.md` by `deploy/bootstrap/agent-bootstrap.sh:170-175`. Its header says it was "distilled from the production DevOps Incident Analyzer agent" by hand. This is the drift the gitagent layer would remove.
- The console is not an application. It is a Pi TUI session with the same extension whose role is chosen by file precedence (`AGENTS.md` for operators, `AGENTS.override.md` for spokes), launched by `just coms <cname>`, with a peer-pool widget.
- The hub is `scripts/coms-net-server.ts`: HTTP + SSE + bearer (directory auth from SSM), sqlite mailbox, single instance, framework-agnostic. Its wire types are TypeScript `type`s at lines 139-239, duplicated by hand in the extension and again as Zod in the analyzer.
- Distribution: `deploy/publish-fleet.sh` git-archives HEAD into an S3 bundle plus a short-SHA version; hosts converge every 30 minutes via `pi-coms-update`. pi-coms is itself a Pi package (`package.json` `"pi": {"extensions": [...]}`) with tags `v0.1.0`, `v0.1.1`.
- Pi package format (upstream): `package.json` `pi` manifest with `extensions`, `skills`, `prompts`, `themes`; `pi install git:host/user/repo@v1.0.0` pins a tag; skills follow the same agentskills.io SKILL.md standard this repo enforces (SIO-1347); `defaultProjectTrust` in settings governs the trust prompt for project-local packages.

## What maps and what does not

| gitagent capability | Analyzer today | pi-coms today | Fit |
|---|---|---|---|
| `agent.yaml` + SOUL/RULES/DUTIES | full | bash-templated flags + one markdown file | Clean port of identity, invariants, investigation discipline, reporting standards (about 60 percent of the persona). Tool-mechanics rules do not port: aws-agent `RULES.md` names 41 distinct MCP tool tokens that do not exist on a Pi spoke. `aws-spoke/RULES.md` is authored fresh, seeded from the existing distilled text. |
| Shared context and skills (`agents/shared/`) | merged into every agent | none | Ports, but `agents/shared/context.md` carries a datasource-to-MCP table and wiki conventions that would mislead a spoke. Split it into portable invariants and analyzer runtime facts. |
| Skills (SKILL.md) | 31 files, strict validator | none | Same standard. Pi warns on non-spec top-level fields; fold the analyzer's extension fields (`confidence`, `learned_from`) under `metadata` at export, or exclude learned skills. |
| Knowledge / runbooks | `knowledge/aws/runbooks/` under the root agent, not under aws-agent | none | Export named categories only. One 12-digit account id sits in `aws-iam-permission-troubleshooting.md:51`; it is already public in pi-coms's bucket name, but the exporter must scan and block by default. |
| Memory (`memory/runtime`, wiki, Agent Memory REST) | root agents only | monitor sqlite journal, per-investigation prompt injection | Do not export `memory/` (incident-derived). Share by writing structured verdicts back into the analyzer, not by giving spokes the analyzer's memory. |
| `version`, tagged releases, CI validate | parsed, never read; no tag job | fleet bundle version is a git SHA; two repo tags for Pi installs | The genuinely unused part. Needs a small `version.ts`, a tag-triggered workflow and an exporter. |
| `dependencies` / `mount` / `extends` | not implemented in the bridge | not applicable | Not needed for this integration; the pi-fleet definitions live in this repo. |
| `config/<env>.yaml` | not read by the bridge | Terraform vars per account | Do not invent it. Per-estate variance stays in pi-coms Terraform; the persona is account-agnostic by design. |
| SkillsFlow workflows | executor exists, `agent`/`graph` handlers missing | none | Two handlers away from "analyzer then spoke" as a deterministic workflow. |
| Sub-agent dispatch in-process | 7 hard-coded datasources | remote processes | Does not apply. Spokes must never enter `AGENT_NAMES`. |

## Recommended architecture

```text
devops-incident-analyzer (definition + release)            pi-coms (runtime)
agents/pi-fleet/                                            hub  scripts/coms-net-server.ts  (unchanged)
  agent.yaml SOUL RULES DUTIES      -> operator console       |
  agents/aws-spoke/                                           |  SSE
    agent.yaml SOUL RULES DUTIES    -> spoke persona          v
  skills: shared + selected analyzer skills                 spoke host (EC2, Pi CLI + coms-net.ts)
  knowledge: aws runbooks (allowlisted)                       AGENTS.override.md   <- vendor/pi-fleet/aws-spoke/
                                                              ~/.pi/agent/skills/  <- vendor/pi-fleet/skills/
packages/gitagent-bridge/src/pi-package-export.ts
packages/gitagent-bridge/src/version.ts                     deploy/pi-fleet.version   (pinned tag)
.github/workflows/agent-release.yml  (on tag pi-fleet-v*)   deploy/publish-fleet.sh   (fetch + vendor)
  validate -> export -> version==tag gate -> release asset   agent-bootstrap.sh        (copy persona, install skills, stamp purpose)

web app: incident-analyzer graph (historical)  |  pi-fleet pane or graph (live via hub)  |  #682 cards (sequence)
packages/skillflow: graph: incident-analyzer -> agent: aws-spoke (after each other)
```

Design decisions and why:

1. **One `aws-spoke` definition, not one per estate.** `AGENTS-spoke.md` is deliberately account-agnostic ("everything account-specific is discovered at runtime"). Name, purpose and account are already Terraform variables and bootstrap placeholders; the estate-to-agent map already exists as `PI_COMS_ESTATE_AGENT_MAP`.
2. **The root `pi-fleet` agent is the console persona**, so the same SOUL and RULES serve the exported Pi console `AGENTS.md` and, if built, the web-app hub-client graph. One definition, two runtimes.
3. **Consume the package from S3 through the existing fleet bundle, with the git tag as provenance.** `pi install git:...@tag` on every spoke needs GitHub egress per account, writes Pi settings, and project-local skills trigger a trust prompt a headless Herdr session cannot answer. The tag job publishes `pi-fleet-<ver>.tgz` as a GitHub release asset; pi-coms pins it in `deploy/pi-fleet.version`, `publish-fleet.sh` vendors it under `vendor/pi-fleet/`, and bootstrap copies the persona and installs skills into the agent user's global `~/.pi/agent/skills/` (no trust prompt). The persona version is appended to the register `purpose` so `GET /v1/agents` shows which persona each spoke runs.
4. **Exporter is allowlist-only.** Export SOUL, RULES, DUTIES, hand-authored skills and named knowledge categories. Never export `memory/`, `hooks/`, `compliance/`, `workflows/`, learned skills, or any file containing a 12-digit account id. Both repos are public, so the exposure risk is scope creep, not the transfer itself.
5. **Render the context file without inlined skill bodies.** `buildSystemPromptParts` inlines every skill body; Pi discloses skills progressively (description in prompt, body on read). A small `renderContextFile(agent, { inlineSkills: false })` reuses the section order and `renderSkill` from `skill-loader.ts` and must never call `buildSubAgentSystemPrompt` (its non-interactive preamble would break a spoke that replies to coms turns).
6. **Verdicts back into memory as enumerated fields only.** Writing free-text `summary` or `evidence` through `recordKeyDecision` would put a remote LLM's output into the analyzer's next-turn prompt, breaking the #682 invariant. Write verdict enum, per-claim status enums, `msg_id`, target and timestamp. Same rule for knowledge-graph writes.
7. **Do not route spokes as a datasource.** Adding `pi` to `AGENT_NAMES` would hit the MCP tool-count gate, the 360 s fan-out budget, and would blend live findings into the historical report, defeating the two-inspectors goal.

## Phased plan

### Phase 0: land #682 and remove the two-agent assumptions (1 to 2 days)

- Merge PR #682 once the user's smoke test and the review gate are satisfied (Greptile still skips org-wide per SIO-1642; merges are on explicit per-PR go-ahead).
- `packages/agent/src/memory-backend.ts` `resolveUserId` / `resolveRole`: replace the two-branch ternaries with a name map and an explicit unknown-agent path, so a third agent cannot silently share the `incident-analyzer` memory user.
- `packages/agent/src/action-tools/pi-coms-client.ts`: add a sender-prefix option (today hard-wired to `incident-analyzer`), make `heartbeat` public, add `mailbox()` for `GET /v1/mailbox`, and move `resolvePiComsConfig` out of `pi-verifier.ts` next to the client.
- Per-environment hubs (user decision 2026-09-06, no cross-environment access): `PiComsConfigSchema` gains a `hubs` map keyed by environment, fed by `PI_COMS_HUBS` with the single-hub variables as a one-entry fallback; the estate name suffix (`-dev`, `-stg`, `-prd`) selects the hub; the verify and investigate cards, the pane (2a) and the inbox node (2b) all resolve the hub through this map, and one `incident-analyzer` principal is minted per hub.
- Verify: `bun test --isolate` in `packages/agent`; local hub via `just coms-net-server` and `just token-create incident-analyzer "incident-analyzer-*" service`; approve a verify card against a `just coms laptop` session.

### Phase 1: definition, export, versioned release (4 to 6 days)

Analyzer:
- `agents/pi-fleet/{agent.yaml,SOUL.md,RULES.md,DUTIES.md}` seeded from pi-coms `AGENTS.md`; `agents/pi-fleet/agents/aws-spoke/{agent.yaml,SOUL.md,RULES.md,DUTIES.md}` seeded from `deploy/AGENTS-spoke.md`; `skills:` lists `cite-sources` and portable analyzer skills; knowledge points at the AWS runbook category (relative paths resolve from the agent dir; run the yaml check and OKF audit over it).
- Split `agents/shared/context.md` into portable invariants and analyzer runtime facts.
- `packages/gitagent-bridge/src/pi-package-export.ts` (+ test): `renderContextFile`, skill directory copy with extension fields folded under `metadata`, `package.json` with `"keywords": ["pi-package"]`, `"pi": {"skills": ["./skills"]}`, `version = manifest.version`, allowlist/denylist and account-id scan.
- `packages/gitagent-bridge/src/version.ts`: semver validation wired into `loadAgent`, `assertVersionMatchesTag`, provenance header `<!-- pi-fleet vX.Y.Z (analyzer <sha>) -->`.
- `scripts/export-pi-package.ts` and a root `agents:export` script (needs the user's approval for the `package.json` edit).
- `.github/workflows/agent-release.yml` on `push: tags: ["pi-fleet-v*"]`: typecheck, bridge tests (skill spec and OKF audit included), export, version-equals-tag gate, `gh release upload`.
- `docs/architecture/gitagent-bridge.md`: release section.

pi-coms:
- `deploy/pi-fleet.version`; `deploy/publish-fleet.sh` fetches the release asset and vendors it; `deploy/bootstrap/agent-bootstrap.sh` copies `vendor/pi-fleet/aws-spoke/AGENTS.override.md` (replacing the line-173 copy), installs skills to `$AGENT_HOME/.pi/agent/skills/`, appends `persona=pi-fleet-vX.Y.Z` to `--purpose`; retire `deploy/AGENTS-spoke.md` and root `AGENTS.md` in favour of vendored copies, with a `just sync-persona` for laptop operators.

Verify: exporter test asserts section order equals `buildSystemPromptParts` minus skill bodies and that denylisted paths are absent; run the exported persona locally with `pi -e extensions/coms-net.ts --skill <exported skill>` from a cwd holding the exported `AGENTS.override.md` and confirm `/skill:cite-sources` resolves; after one `pi-coms-update` on a dev host, `curl $HUB/v1/agents` shows the persona version in `purpose`.

### Phase 1b: manifest-driven fleet deploy (5 to 8 days, pi-coms side)

Added 2026-09-06 after the user asked for a deploy mechanism that takes a list of accounts and does the bundling, token refresh and deployment through the existing pi-coms path plus the gitagent persona release. Target list: eu-oit-dev, eu-shared-services-dev, eu-shared-services-prd, eu-oit-prd, eu-ediservices-prd, eu-mendix-platform-prd, eu-b2b-ecom-prd, eu-b2becom-v2-prd, eu-b2bonboarding-prd. Two exist today; the seven new ones are all production accounts.

What exists in pi-coms (verified): one hand-written Terraform root per account under `deploy/accounts/<name>/` with gitignored tfvars and gitignored local state; `deploy/modules/agent` creates the host, the `/pi-agent/auth-token` parameter and, when asked, a role named `DevOpsAgentReadOnly`; one private hub in eu-shared-services-dev reached over the Transit Gateway and allow-listed by CIDR; `deploy/publish-fleet.sh` plus State Manager convergence for code; `deploy/token-admin.sh` for per-principal hub tokens. Local access to all nine accounts is by temporary portal credentials in `~/.aws/credentials`, which expire and cannot be refreshed by a script.

Design: a single `deploy/fleet.yaml` (hub block, pinned `persona` release tag from Phase 1, defaults, one `spokes` entry per account with profile, subnet, and `readonly_role: create | adopt`) and a Bun CLI `scripts/fleet.ts` behind `just fleet <cmd> [names]` with idempotent, per-account resumable steps: `preflight` (STS per profile, stopping with the expired list; hub principal present; TGW route and hub allow-list; org membership for the bucket policy; Bedrock inference-profile access; in adopt mode the existing role and trust policy), `tokens ensure|rotate` (per-spoke principal `<name>,monitor-<name>` minted in the hub SSM path and mirrored into the spoke account's parameter, bootstrap re-run over SSM), `render` (roots generated from a template), `plan` and `apply` (prd defaults to plan-only, apply needs `--yes`), `publish` (vendor the persona asset, publish the bundle), `rollout` (Run Command plus the agent restart dance, then poll `GET /v1/agents` for name, bundle SHA and persona version), `status`, and `deploy` as the composition.

Environment isolation (user decision 2026-09-06): there is no cross-environment access, dev talks to dev and production to production. The manifest therefore carries a `hubs` map (`dev` in eu-shared-services-dev, which exists; `prd` in eu-shared-services-prd, new) and every spoke declares its `env`. A spoke registers only with its own environment's hub, reads code only from its own environment's distribution bucket, and gets its token from its own hub's directory; `publish` uploads the same bundle to both buckets, and preflight refuses an `env` mismatch or a CIDR from the other environment in a hub allow-list.

The production-account work is the real cost: the prd hub root with its bucket and token directory; the seven prd accounts already carry `DevOpsAgentReadOnly` for the incident analyzer, so the module needs an adopt mode that adds the instance role to the existing trust policy without replacing the analyzer's statement and attaches a separate `pi-coms-extensions` policy; prd VPCs must route to the prd shared-services VPC over the TGW and be allow-listed on the prd hub; the roots should move to an S3 state backend before there are nine of them; Bedrock model access must be enabled per account.

### Phase 2: side by side (user decision 2026-09-06: 2a thin hub pane first, 2b inbox node added the same day, 2c third graph stays a later option)

- **2a Thin hub pane (1 to 2 days, chosen).** `apps/web/src/routes/api/pi/{agents,messages}/+server.ts` wrapping `PiComsClient` with sender prefix `pi-fleet`, a `PiFleetPane.svelte` and a `pi-fleet.svelte.ts` store. No `AgentId` change, no LangGraph. The human addresses a spoke directly next to the incident chat. Needs a `pi-fleet` hub principal (`just token-create pi-fleet "pi-fleet-*" service`).
- **2c Third graph (5 to 7 days, deferred).** `packages/agent/src/pi-fleet/{graph.ts,tools.ts,state.ts}`: a `createReactAgent` over five hub tools (list agents, send, await, inbox, status) with register/deregister pre and post nodes and the `pi-fleet` SOUL from `getAgentByName`. Web app: replace the nine two-way sites in `apps/web/src/lib/server/agent.ts` with a `graphFor(agentName)` registry, widen the stream route enum, topology route, `AgentId`, and turn the `+page.svelte:145` binary toggle into a selector. Worth it only when an LLM must choose which spokes to ask and synthesize replies.
- Zero-code fallback: the Pi TUI console (`just coms <cname>`) in a second window.

#### 2b Fleet inbox enrichment node (2 to 3 days)

Added 2026-09-06 after the user asked whether a small node could pull the hub's `ops` inbox into the analyzer. It gives the historical inspector the live inspector's recent notes without spending a spoke turn: the verify card stays the active check, this node is the passive one. Hub facts verified against pi-coms `scripts/coms-net-server.ts` and `docs/architecture/monitoring.md`:

- `GET /v1/mailbox?name=&limit=&since=` is a non-destructive, read-many listing open to every authenticated peer. No session registration and no name ownership are needed, the existing `incident-analyzer` token suffices, and the analyzer holds no SSE stream, so operators never see it. Operator access to the hub is unchanged: every reader sees the same list, and the console keeps working as today.
- `since` is a stateless cursor on ULID ids, which sort by time, so a cursor can be synthesized from the incident window start. `limit` caps at 100.
- The `ops` inbox holds monitor incident reports and digests (14-day TTL) plus the analyzer's own fallback sends. An estate inbox holds completed operator and analyzer conversations with that spoke for 14 days, replies included.
- Monitor reports travel as prose and their diagnoses come from the spoke's model; operator messages are free text. Inbox bodies are therefore untrusted input.

Design: a deterministic node `fetchFleetInbox`, registered always and edged only when `PI_COMS_INBOX_ENABLED=true` (the SIO-640 edge-gate idiom), placed after `aggregate` and before `extractFindings`, soft-failing with a short budget. It reads `ops` filtered by account alias and the incident window plus each assessed estate's inbox, drops senders matching `incident-analyzer-*` to avoid its own echo, and writes a typed `fleetInboxDigest` sidecar (message id, sender, target, kind, timestamp, severity, capped excerpt) rendered as a Fleet inbox card. Only structured facts (counts, alarm names, severities, timestamps) reach the prompt; bodies never do, matching the #682 invariant. A later step can feed alarm names and log groups into the resolve-identifiers presets as deterministic hints.

Open before building: the corp fleet's `PI_MONITOR_REPORT_TO` value (code default `laptop`, docs assume `ops`), and how much of a monitor report parses deterministically from the monitor's own report format.

### Phase 3: after each other, and memory (3 to 4 days)

- `packages/agent/src/pi-handoff-workflow-handlers.ts` registering `graph` (invoke the incident graph for a thread and read `finalAnswer`) and `agent` (hub send and await through `PiComsClient`) handlers for `runWorkflow`; `agents/incident-analyzer/workflows/pi-handoff.yaml` chaining `graph:` to `agent: aws-spoke` with the report passed by template. Trigger from incident close or manually.
- After `executePiVerify` success, `recordKeyDecision` with structured fields only; optional knowledge-graph write of the verdict against the incident entity.
- Verify: skillflow test with fake handlers; end to end, close an incident, the workflow sends the report to the estate spoke, the verdict lands in `memory/runtime/key-decisions.md` as enums, and the next turn's prompt shows the decision line with no free text.

Deferred, separate design: a Pi extension on spokes calling the Couchbase Agent Memory REST service. It needs an outbound network path from every account, a per-account bearer secret in SSM, and a trust decision about spokes reading analyzer memory.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Persona rules drift because tool vocabularies differ | Certain | Author `aws-spoke/RULES.md` fresh; keep shared invariants in `agents/shared/`; exporter test pins section order |
| Runtime facts leak into exported context | High without the split | Split `agents/shared/context.md`; exporter omits the MCP table |
| Public-repo exposure through export scope creep | Medium | Allowlist-only exporter, denylist `memory/` and learned skills, 12-digit account-id scan fails the build |
| Two version numbers (bundle SHA vs persona tag) confuse operators | Medium | Persona version stamped in `purpose` and in the context header |
| Prompt injection from spoke replies into analyzer memory | Medium | Structured-only writes; never `summary` or `evidence` free text |
| Third-graph tax spreads across ~21 sites | Certain if 2c | Registry refactor first; prefer 2a until synthesis is needed |
| Trust-policy edit on a prd `DevOpsAgentReadOnly` clobbers the analyzer's access | Medium | Adopt mode merges statements, never replaces; prd defaults to plan-only with per-account approval |
| Missing TGW route from a prd VPC to the dev hub | Medium | Preflight proves the route before apply; network team owns the attachment |
| Portal credentials expire mid-deploy | High | Idempotent, per-account resumable steps; preflight per step; the tool cannot refresh portal credentials |
| Environment bleed (a prd spoke or a prd estate request reaching the dev hub) | Medium | Mandatory `env` per spoke and hub; preflight refuses mismatches; the analyzer selects the hub from the estate suffix and errors on an unknown suffix |
| Inbox bodies reach the prompt | Medium | Structured-only summary into the prompt; bodies only on the card; test asserts the aggregator context carries no body text |
| Hub token minted in prd while the hub polls dev | High (open from SIO-1635) | Re-mint in dev; `just token-list eu-shared-services-dev` |
| Greptile skips reviews org-wide | High | Merges only on explicit per-PR go-ahead (SIO-1642) |

## Out of scope

Replacing Pi with LangGraph on the spokes; making spokes in-process sub-agents; any hub protocol change; implementing gitagent `dependencies`, `extends` or `config/<env>.yaml` in the bridge; live Agent Memory access from spokes; verification for non-AWS datasources.

## Tracking

| Phase | Linear | State |
|---|---|---|
| 0: land #682, widen the two-agent assumptions | [SIO-1635](https://linear.app/siobytes/issue/SIO-1635) (comment of 2026-09-06) | In Progress |
| 1: definitions, Pi package export, tagged release | [SIO-1649](https://linear.app/siobytes/issue/SIO-1649) | Backlog |
| 1b: manifest-driven fleet deploy | [SIO-1653](https://linear.app/siobytes/issue/SIO-1653) | Backlog |
| 2a: thin hub pane in the web app | [SIO-1650](https://linear.app/siobytes/issue/SIO-1650) | Backlog |
| 2b: fleet inbox enrichment node | [SIO-1652](https://linear.app/siobytes/issue/SIO-1652) | Backlog |
| 3: skillflow handlers, structured verdicts into memory | [SIO-1651](https://linear.app/siobytes/issue/SIO-1651) | Backlog |

No phase starts before its issue is approved. Phase 2 decision recorded 2026-09-06: the thin hub pane (2a) first, the fleet inbox node (2b) added the same day; the third graph (2c) stays a later option.

## Memory references

`reference_sio1635_pi_coms_hub_client_gotchas`, `reference_greptile_skips_docs_only_prs`, `feedback_repo_is_public_sanitize_before_commit`, `reference_agent_memory_backend_seam`, `reference_sio1346_new_skill_pr_seams`, `reference_sio1347_skill_spec_gate`, `feedback_never_create_linear_done`, `feedback_no_direct_push_to_main`.
