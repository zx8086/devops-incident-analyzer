# PVH Landing Zone Terraform Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PVH Landing Zone Terraform agent to the existing DevOps Agent application with the current agent-switching UI, live graph triage, PVH-aware evidence reconciliation, Agent Memory, knowledge-graph history, network and DNS mapping, and a separately gated GitOps proposal path.

**Architecture:** Implement a dedicated LangGraph registered as the third top-level application mode. Reuse the existing GitAgent bundle loader, SSE event path, live triage pane, Agent Memory service, knowledge-graph package, GitLab MCP, LangSmith tracing, and human-interrupt conventions. Deliver read-only learning/review first; add topology history and GitOps writes only after separate safety gates.

**Tech Stack:** Bun, TypeScript strict mode, Svelte 5, SvelteKit, LangGraph, LangSmith, Zod 4, GitAgent/OKF, MCP, GitLab, AWS read-only APIs, Terraform documentation MCP, LadybugDB through the existing GraphStore interface.

**Spec:** `docs/superpowers/specs/2026-09-22-pvh-landing-zone-terraform-agent-design.md`

**Tracking:** [SIO-1867](https://linear.app/siobytes/issue/SIO-1867/implement-pvh-landing-zone-terraform-agent)

## Global Constraints

- Create and approve a Linear epic containing this plan before implementation begins.
- Do not modify `package.json` files or install dependencies until the user approves the dependency change.
- Use Bun commands and the repository's existing Biome, TypeScript, YAML, and test workflows.
- The first releasable slice is read-only; no GitLab write tool is registered in Phase 1.
- The agent never merges, approves, applies Terraform, mutates Terraform state, or mutates AWS.
- Git-tracked PVH OKF remains curated policy; GitLab and AWS remain live evidence; Agent Memory remains advisory.
- AWS and Terraform external guidance never silently overrides an accepted PVH contract.
- Every graph or memory record carries provenance, freshness, and a stable identifier.
- Do not store secrets, state values, plaintext environment variables, or sensitive plan values.
- Do not mirror the Landing Zone source repositories into this repository.
- Every implementation task follows test-first development and ends with an independently reviewable commit.

## Workstream and issue structure

Create one Linear epic and five ordered child projects:

1. Read-only agent, mode switching, and live triage.
2. Evidence integrations, knowledge selection, and reconciliation.
3. Agent Memory, change history, network, and DNS graph.
4. Governed GitOps proposal workflow.
5. Evaluations, security hardening, and rollout.

Phase 1 and Phase 2 together form the first production release. Phase 3 can ship incrementally behind knowledge-graph and AWS-read feature flags. Phase 4 requires a separate security approval.

## Target file map

| Area | Files |
|---|---|
| Agent bundle | `agents/landing-zone-terraform/**` |
| LangGraph | `packages/agent/src/landing-zone/**` |
| Agent exports | `packages/agent/src/index.ts` |
| Shared event/types | `packages/shared/src/landing-zone-types.ts`, `packages/shared/src/index.ts` |
| Memory identity | `packages/agent/src/memory-backend.ts` |
| Knowledge graph | `packages/knowledge-graph/src/schema.ts`, `writer.ts`, `reader.ts`, `index.ts` |
| KG MCP tools | `packages/mcp-server-knowledge-graph/src/tools/curated.ts` |
| Landing Zone facade | `packages/mcp-server-landing-zone-iac/**` |
| Web graph runtime | `apps/web/src/lib/server/agent.ts`, `graph-registry.ts` |
| Agent vocabulary | `apps/web/src/lib/agent-ids.ts` |
| Frontend state | `apps/web/src/lib/stores/agent.svelte.ts`, `agent-reducer.ts` |
| Frontend presentation | `apps/web/src/routes/+page.svelte`, `apps/web/src/lib/node-labels.ts`, new Landing Zone cards |
| Stream/resume APIs | `apps/web/src/routes/api/agent/stream/+server.ts`, new Landing Zone resume route |
| Evaluation | `packages/agent/src/eval/**`, `agents/landing-zone-terraform/examples/**` |

---

## Phase 1: Read-only agent, switching, and live triage

### Task 1: Establish the implementation branch and tracking contract

**Files:**
- Create in Linear: one epic containing the spec path, this plan, goals, phases, risks, and release gate.
- Create in the target repository: implementation branch `feat/landing-zone-terraform-agent-readonly`.

**Interfaces:**
- Consumes: approved specification and plan.
- Produces: traceable implementation issue hierarchy and an isolated branch.

- [ ] **Step 1: Create the Linear epic**

Copy the complete specification summary, all delivery phases, release gates, and the paths to both planning documents into the issue. Create child issues matching the five workstreams above. Leave every issue out of `Done` until the user approves closure.

- [ ] **Step 2: Create the implementation branch**

Run:

```bash
git fetch origin main
git switch -c feat/landing-zone-terraform-agent-readonly origin/main
```

Expected: the branch starts from the current remote `main` and contains no local product changes.

- [ ] **Step 3: Record the baseline**

Run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
```

Expected: all baseline commands pass. Record pre-existing failures in the Linear epic before changing code.

### Task 2: Migrate the curated PVH knowledge bundle

**Files:**
- Create: `agents/landing-zone-terraform/knowledge/index.md`
- Create: `agents/landing-zone-terraform/knowledge/index.yaml`
- Create: `agents/landing-zone-terraform/knowledge/pvh/conventions/**`
- Create: `agents/landing-zone-terraform/knowledge/pvh/repos/**`
- Create: `agents/landing-zone-terraform/knowledge/pvh/modules/**`
- Create: `agents/landing-zone-terraform/knowledge/pvh/shared/**`
- Create: `agents/landing-zone-terraform/knowledge/okr/current-objectives/**`
- Create: `agents/landing-zone-terraform/knowledge/okr/unresolved-gaps/**`
- Create: `agents/landing-zone-terraform/knowledge/standards/aws/source-catalog.md`
- Create: `agents/landing-zone-terraform/knowledge/standards/terraform/source-catalog.md`
- Create: `agents/landing-zone-terraform/knowledge/runbooks/*.md`
- Modify: the existing OKF validation test fixtures under `packages/gitagent-bridge/src/` only as required to include the new bundle.

**Interfaces:**
- Consumes: current `context/` OKF bundle and current operational portions of `PVH-LZ-Terraform-Standards-OKR/`.
- Produces: a valid, selectively loadable `knowledge/index.yaml` and cited PVH concepts.

- [ ] **Step 1: Write a failing agent-knowledge conformance test**

Create `packages/gitagent-bridge/src/landing-zone-load.test.ts` with assertions that:

```typescript
const agent = loadAgent(join(AGENTS_ROOT, "landing-zone-terraform"));
expect(agent.knowledgeIndex).toBeDefined();
expect(agent.knowledgeIndex?.categories).toContain("repos");
expect(agent.knowledgeIndex?.categories).toContain("conventions");
expect(agent.knowledgeIndex?.categories).toContain("shared");
```

Also assert that all 23 in-scope repository concepts are discoverable and that archived OKR reports are not prompt-loaded.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
bun test packages/gitagent-bridge/src/landing-zone-load.test.ts
```

Expected: FAIL because `agents/landing-zone-terraform` does not exist.

- [ ] **Step 3: Copy and route the curated knowledge**

Copy the current OKF concepts without rewriting repository-owned values. Preserve frontmatter fields including `type`, `verified`, `stale_after`, scope, and provenance. Create `index.yaml` categories that route by intent and repository rather than loading all concepts.

The AWS catalog must include official AWS documentation, Well-Architected, and Terraform-on-AWS Prescriptive Guidance sources. The Terraform catalog must include official provider, registry, module, and language sources. Store URLs and PVH interpretations, not external document copies.

- [ ] **Step 4: Add initial workflow runbooks**

Create these runbooks from the existing curated evidence:

```text
account-vending.md
core-network-onboarding.md
gitlab-project-creation.md
runner-onboarding.md
terraform-plan-review.md
account-network-map.md
dns-resolution-path.md
```

Each runbook must contain scope, required concepts, required live evidence, representative-example count, stop conditions, and permitted outcomes.

- [ ] **Step 5: Validate OKF and tests**

Run:

```bash
bun test packages/gitagent-bridge/src/landing-zone-load.test.ts
bun run yaml:check
bun run tools:verify
```

Expected: PASS with no missing frontmatter, unresolved index entry, or prompt-loaded archive.

- [ ] **Step 6: Commit**

```bash
git add agents/landing-zone-terraform/knowledge packages/gitagent-bridge/src/landing-zone-load.test.ts
git commit -m "feat(landing-zone): add curated PVH knowledge bundle"
```

### Task 3: Define the GitAgent bundle and read-only policy

**Files:**
- Create: `agents/landing-zone-terraform/agent.yaml`
- Create: `agents/landing-zone-terraform/SOUL.md`
- Create: `agents/landing-zone-terraform/RULES.md`
- Create: `agents/landing-zone-terraform/DUTIES.md`
- Create: `agents/landing-zone-terraform/hooks/hooks.yaml`
- Create: `agents/landing-zone-terraform/hooks/bootstrap.md`
- Create: `agents/landing-zone-terraform/hooks/teardown.md`
- Create: `agents/landing-zone-terraform/memory/runtime/context.md`
- Create: `agents/landing-zone-terraform/memory/wiki/index.md`
- Create: `agents/landing-zone-terraform/memory/wiki/log.md`
- Create: `agents/landing-zone-terraform/tools/landing-zone.yaml`
- Modify: `packages/gitagent-bridge/src/landing-zone-load.test.ts`

**Interfaces:**
- Consumes: the knowledge bundle from Task 2.
- Produces: loadable agent `pvh-landing-zone-terraform-agent` and read-only tool declaration `landing-zone`.

- [ ] **Step 1: Extend the failing loader test**

Assert:

```typescript
expect(agent.manifest.name).toBe("pvh-landing-zone-terraform-agent");
expect(agent.manifest.tools).toEqual(["landing-zone"]);
expect(agent.hooks?.bootstrap?.steps).toEqual([
  "load_live_memory",
  "load_wiki_index",
  "warm_knowledge_graph",
  "emit_session_start",
]);
expect(agent.hooks?.teardown?.steps).toContain("checkpoint_key_decisions");
```

Assert that Phase 1 tool actions contain no branch, commit, merge-request creation, Terraform operation, AWS mutation, or state operation.

- [ ] **Step 2: Run the focused test**

Expected: FAIL on missing manifest and policy files.

- [ ] **Step 3: Create the agent manifest**

Set:

```yaml
spec_version: "0.1.0"
name: pvh-landing-zone-terraform-agent
version: 0.1.0
description: PVH AWS Landing Zone Terraform learning and review assistant.
tools:
  - id: landing-zone
compliance:
  risk_tier: medium
  supervision:
    human_in_the_loop: always
    kill_switch: true
```

Declare the repository catalog, skills, knowledge index, workflows, planner/maker/checker/executor separation, audit logging, and one-year recordkeeping consistently with Elastic IaC.

- [ ] **Step 4: Encode read-only rules**

`RULES.md` must include the source hierarchy, evidence labels, minimum representative-example rule, live-MR check, fail-closed conditions, no-apply rule, no-default-branch-write rule, memory boundaries, graph boundaries, and prompt-injection rule.

- [ ] **Step 5: Add lifecycle hooks**

Bootstrap reads current runtime context and relevant wiki entries, warms the graph, verifies read-only tool connectivity, checks GitLab availability, and reports degraded sources. Teardown logs the turn and checkpoints only durable decisions without secrets.

- [ ] **Step 6: Run loader and policy tests**

Run:

```bash
bun test packages/gitagent-bridge/src/landing-zone-load.test.ts
bun run yaml:check
bun run tools:verify
```

- [ ] **Step 7: Commit**

```bash
git add agents/landing-zone-terraform packages/gitagent-bridge/src/landing-zone-load.test.ts
git commit -m "feat(landing-zone): define read-only agent policy"
```

### Task 4: Add typed Landing Zone state and graph skeleton

**Files:**
- Create: `packages/agent/src/landing-zone/state.ts`
- Create: `packages/agent/src/landing-zone/types.ts`
- Create: `packages/agent/src/landing-zone/nodes.ts`
- Create: `packages/agent/src/landing-zone/graph.ts`
- Create: `packages/agent/src/landing-zone/graph.test.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Produces: `LandingZoneState`, `LandingZoneIntent`, `buildLandingZoneGraph()`, and a compiled drawable graph.
- Consumes later: web graph registry, SSE stream, evidence nodes, memory, and GitOps phase.

- [ ] **Step 1: Define the state contract in the test**

Require these intent values:

```typescript
const LandingZoneIntentSchema = z.enum(["learn", "understand", "review", "propose-change"]);
```

Require state fields for messages, request ID, intent, repository scope, account scope, selected knowledge, evidence results, reconciliation, risk, response, blocked reason, outcome, and proposed-change review payload.

- [ ] **Step 2: Write graph topology tests**

Assert the read-only path contains:

```text
bootstrap -> classifyRequest -> resolveScope -> selectPvhKnowledge
selectPvhKnowledge -> gatherEvidence
gatherEvidence -> reconcileEvidence -> assessRisk -> answerQuestion -> teardown
```

Assert the graph compiles with the repository checkpointer factory and exposes every node through `getGraphAsync()`.

- [ ] **Step 3: Run the test and verify failure**

```bash
bun test packages/agent/src/landing-zone/graph.test.ts
```

Expected: FAIL because the Landing Zone graph does not exist.

- [ ] **Step 4: Implement strict state and minimal deterministic nodes**

Use Zod for external evidence boundaries and typed LangGraph annotations for state. The initial nodes may return deterministic test fixtures but must have final exported signatures:

```typescript
export async function bootstrapLandingZone(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function classifyLandingZoneRequest(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function resolveLandingZoneScope(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function selectPvhKnowledge(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function gatherLandingZoneEvidence(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function reconcileLandingZoneEvidence(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function assessLandingZoneRisk(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function answerLandingZoneQuestion(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
export async function teardownLandingZone(state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>>;
```

- [ ] **Step 5: Export and test the graph**

Run:

```bash
bun test packages/agent/src/landing-zone/graph.test.ts
bun run --filter @devops-agent/agent typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/landing-zone packages/agent/src/index.ts
git commit -m "feat(landing-zone): add read-only LangGraph skeleton"
```

### Task 5: Register the third mode and independent memory identity

**Files:**
- Modify: `apps/web/src/lib/agent-ids.ts`
- Modify: `apps/web/src/lib/agent-ids.test.ts`
- Modify: `apps/web/src/lib/agent-surface.test.ts`
- Modify: `apps/web/src/lib/server/graph-registry.ts`
- Modify: `apps/web/src/lib/server/agent.ts`
- Modify: `packages/agent/src/memory-backend.ts`
- Modify: `packages/agent/src/memory-backend.test.ts`
- Modify: related server registry tests.

**Interfaces:**
- Consumes: `buildLandingZoneGraph()`.
- Produces: selectable `landing-zone-terraform` mode, `getLandingZoneGraph()`, and independent Agent Memory user.

- [ ] **Step 1: Extend agent vocabulary tests**

Assert:

```typescript
expect(AGENT_IDS).toContain("landing-zone-terraform");
expect(agentChoice("landing-zone-terraform")).toEqual({
  id: "landing-zone-terraform",
  title: "PVH Landing Zone Terraform",
  subtitle: "AWS Landing Zone learning and change assistant",
});
```

- [ ] **Step 2: Extend mode rotation tests**

Change the expected mode set to:

```typescript
new Set(["incident-analyzer", "elastic-iac", "landing-zone-terraform"])
```

Assert `pi-fleet-console` remains contextual and excluded from the rotation. Assert the Landing Zone descriptor has `surface: "mode"` and `hasTriageGraph: true`.

- [ ] **Step 3: Extend memory identity tests**

Assert:

```typescript
expect(resolveUserId("landing-zone-terraform")).toBe("landing-zone-terraform");
expect(resolveRole("landing-zone-terraform")).toBe("landing-zone-iac-maker");
```

- [ ] **Step 4: Run tests and verify failure**

```bash
bun test apps/web/src/lib/agent-ids.test.ts apps/web/src/lib/agent-surface.test.ts packages/agent/src/memory-backend.test.ts
```

- [ ] **Step 5: Register the mode**

Add `landing-zone-terraform` to `AGENT_IDS`, `AGENT_CHOICES`, and the registry. Add a lazy `landingZoneGraphPromise` and `getLandingZoneGraph()` in server agent runtime. Route invoke, resume, state reads, pruning, and topology through the Landing Zone compiled graph without changing Incident Analyzer or Elastic IaC state shapes.

Where current code branches only for `elastic-iac`, add a typed graph-family dispatch rather than falling through to the incident graph. Preserve the registry as the source of capability flags.

- [ ] **Step 6: Register the Agent Memory identity**

Add:

```typescript
"landing-zone-terraform": {
  userId: "landing-zone-terraform",
  role: "landing-zone-iac-maker",
},
```

- [ ] **Step 7: Run focused and server tests**

```bash
bun test apps/web/src/lib/agent-ids.test.ts apps/web/src/lib/agent-surface.test.ts
bun test packages/agent/src/memory-backend.test.ts
bun test apps/web/src/lib/server/agent.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib packages/agent/src/memory-backend.ts packages/agent/src/memory-backend.test.ts
git commit -m "feat(landing-zone): register agent mode and memory identity"
```

### Task 6: Integrate the existing icon switcher and live graph triage UI

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/lib/node-labels.ts`
- Modify: `apps/web/src/lib/app-chart.ts`
- Modify: `apps/web/src/lib/app-chart.test.ts`
- Modify: `apps/web/src/lib/agent-surface.test.ts`
- Create: `apps/web/src/lib/landing-zone-copy.ts`
- Create: `apps/web/src/lib/landing-zone-copy.test.ts`

**Interfaces:**
- Consumes: `/api/agents`, `AGENT_CHOICES`, compiled topology, and SSE node events.
- Produces: third-mode header copy, empty state, mode banner, and graph labels.

- [ ] **Step 1: Add failing presentation tests**

Assert the Landing Zone mode has six starter prompts covering account creation, repository explanation, network map, DNS path, GitLab project/runners, and standards comparison. Assert no starter prompt promises apply, merge, state mutation, or AWS mutation.

- [ ] **Step 2: Add triage label tests**

Require labels for every node returned by the Landing Zone graph. Use the same parity test pattern that compares compiled node IDs with `ALL_NODE_LABELS`.

- [ ] **Step 3: Run tests and verify failure**

```bash
bun test apps/web/src/lib/landing-zone-copy.test.ts apps/web/src/lib/app-chart.test.ts apps/web/src/lib/agent-surface.test.ts
```

- [ ] **Step 4: Add Landing Zone presentation state**

Derive:

```typescript
const isLandingZone = $derived(agentStore.currentAgent === "landing-zone-terraform");
```

Render a banner stating that learning and review use live PVH evidence and that any future change is proposed through a GitLab MR; the agent never applies. Hide incident datasource selectors in this mode. Keep the same bot icon and `cycleAgent()` control.

- [ ] **Step 5: Add node labels**

Add labels such as `Resolving repository`, `Selecting PVH knowledge`, `Reading GitLab`, `Checking Terraform contract`, `Checking AWS guidance`, `Reconciling evidence`, and `Assessing risk`. Labels are cosmetic; node emission remains derived from the compiled graph.

- [ ] **Step 6: Verify live triage topology**

Run the web tests and a component test that requests:

```text
/api/agent/topology?agent=landing-zone-terraform
```

Expected: HTTP 200 with the Landing Zone graph nodes and normalized edges. `GraphTriagePanel` needs no agent-specific branch.

- [ ] **Step 7: Run accessibility and responsive checks**

Verify keyboard activation, ARIA name, disabled streaming state, focus ring, and the existing split-pane minimum widths at desktop and narrow viewports.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): expose Landing Zone mode and live triage"
```

## Phase 2: Evidence integrations and reconciliation

### Task 7: Define shared evidence and reconciliation contracts

**Files:**
- Create: `packages/shared/src/landing-zone-types.ts`
- Create: `packages/shared/src/landing-zone-types.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/agent/src/landing-zone/state.ts`

**Interfaces:**
- Produces: Zod schemas and TypeScript types for evidence, provenance, freshness, comparison status, topology state, risk, and response citations.

- [ ] **Step 1: Write schema tests**

Define and test:

```typescript
EvidenceSourceSchema = z.enum(["pvh-okf", "gitlab", "terraform-docs", "aws-docs", "aws-api", "memory", "knowledge-graph"])
EvidenceStatusSchema = z.enum(["observed", "inferred", "proposed", "unverified"])
AlignmentSchema = z.enum(["aligned", "divergent", "exception", "unresolved", "unverified"])
ReconciliationStatusSchema = z.enum(["aligned", "drifted", "pending", "unknown", "conflicting-evidence"])
```

Require every `EvidenceItem` to carry `source`, `retrievedAt`, `status`, `summary`, and at least one provenance locator such as URL, repository/commit/path, AWS ID, memory block ID, or graph entity ID.

- [ ] **Step 2: Reject unsafe evidence**

Add tests that reject empty provenance, unknown status strings, unbounded raw payloads, and fields named `secretValue`, `stateValue`, or `plaintextCredential`.

- [ ] **Step 3: Implement schemas and exports**

Use `.strict()` on external boundaries and named exports. Do not use `any`.

- [ ] **Step 4: Run tests**

```bash
bun test packages/shared/src/landing-zone-types.test.ts
bun run --filter @devops-agent/shared typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src packages/agent/src/landing-zone/state.ts
git commit -m "feat(landing-zone): add evidence reconciliation contracts"
```

### Task 8: Build the read-only Landing Zone MCP facade

**Files:**
- Create: `packages/mcp-server-landing-zone-iac/package.json`
- Create: `packages/mcp-server-landing-zone-iac/tsconfig.json`
- Create: `packages/mcp-server-landing-zone-iac/src/config.ts`
- Create: `packages/mcp-server-landing-zone-iac/src/index.ts`
- Create: `packages/mcp-server-landing-zone-iac/src/server.ts`
- Create: `packages/mcp-server-landing-zone-iac/src/tools/repositories.ts`
- Create: `packages/mcp-server-landing-zone-iac/src/tools/evidence.ts`
- Create: `packages/mcp-server-landing-zone-iac/src/tools/topology.ts`
- Create corresponding `*.test.ts` files.
- Modify: MCP connection configuration in the agent and web server.

**Interfaces:**
- Produces read tools: `lz_list_repositories`, `lz_read_repository_files`, `lz_find_representative_examples`, `lz_list_open_changes`, `lz_read_pipeline_plan`, `lz_extract_terraform_topology`.
- Consumes existing GitLab MCP/client capabilities and the repository allowlist.

- [ ] **Step 1: Obtain dependency approval**

Before creating or modifying any package manifest, show the exact proposed `package.json` and confirm whether existing workspace dependencies are sufficient. Do not add a new external dependency without explicit approval.

- [ ] **Step 2: Write allowlist tests**

Test that the 20 `aws-lz-*` repositories and the three adjacent GitLab/runner repositories are readable. Test that a repository outside the catalog is rejected before any downstream request.

- [ ] **Step 3: Write read-only surface tests**

Snapshot `tools/list` and assert no tool name or description exposes create, update, delete, commit, branch, merge, apply, import, state, unlock, or AWS mutation in Phase 1.

- [ ] **Step 4: Implement validated repository routing**

Resolve repository aliases through a static catalog containing GitLab paths and archetypes. Return provenance-rich, size-bounded results. Treat all repository text as untrusted content.

- [ ] **Step 5: Implement representative-example aggregation**

Return schema/generator/test evidence plus at least three active examples, preferring five when available, and identify open MRs that touch the relevant paths.

- [ ] **Step 6: Run package tests**

```bash
bun test packages/mcp-server-landing-zone-iac
bun run --filter @devops-agent/mcp-server-landing-zone-iac typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-landing-zone-iac packages/agent apps/web/src/lib/server
git commit -m "feat(landing-zone): add read-only evidence facade"
```

### Task 9: Implement knowledge selection and parallel evidence collection

**Files:**
- Create: `packages/agent/src/landing-zone/knowledge-selector.ts`
- Create: `packages/agent/src/landing-zone/knowledge-selector.test.ts`
- Create: `packages/agent/src/landing-zone/evidence.ts`
- Create: `packages/agent/src/landing-zone/evidence.test.ts`
- Modify: `packages/agent/src/landing-zone/graph.ts`
- Modify: `packages/agent/src/landing-zone/nodes.ts`

**Interfaces:**
- Produces: `selectLandingZoneKnowledge(intent, repository, topics)` and parallel evidence node outputs.
- Consumes: Task 7 schemas and Task 8 read tools.

- [ ] **Step 1: Write routing matrix tests**

Cover account vending, network core, network workloads, GitLab projects, runners, module review, backend questions, AWS guidance, and unknown repositories. Assert each request loads only its applicable repository concept plus required conventions/shared concepts.

- [ ] **Step 2: Write evidence fan-out tests**

Inject fake collectors and assert GitLab, OKF, Terraform docs, AWS docs, Agent Memory, and knowledge graph collectors run independently. AWS live-state collection runs only when relevant and authorised.

- [ ] **Step 3: Implement selectors and collectors**

Use `Promise.allSettled` or LangGraph fan-out so one optional source failure does not erase successful evidence. Record failure as a typed unavailable-source result.

- [ ] **Step 4: Update graph topology**

Replace the aggregate `gatherEvidence` skeleton node with individually visible triage nodes and a join into `reconcileEvidence`.

- [ ] **Step 5: Run graph and selector tests**

```bash
bun test packages/agent/src/landing-zone/knowledge-selector.test.ts packages/agent/src/landing-zone/evidence.test.ts packages/agent/src/landing-zone/graph.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/landing-zone
git commit -m "feat(landing-zone): gather routed evidence in parallel"
```

### Task 10: Implement deterministic evidence reconciliation and answer policy

**Files:**
- Create: `packages/agent/src/landing-zone/reconciliation.ts`
- Create: `packages/agent/src/landing-zone/reconciliation.test.ts`
- Create: `packages/agent/src/landing-zone/risk.ts`
- Create: `packages/agent/src/landing-zone/risk.test.ts`
- Modify: `packages/agent/src/landing-zone/nodes.ts`
- Create: `agents/landing-zone-terraform/examples/account-vending-grounded.md`
- Create: `agents/landing-zone-terraform/examples/backend-conflict.md`
- Create: `agents/landing-zone-terraform/examples/source-outage.md`

**Interfaces:**
- Produces: `reconcileEvidence(items): StandardsComparison[]` and `assessRisk(reconciliation): LandingZoneRiskAssessment`.

- [ ] **Step 1: Write precedence tests**

Test that live repository behaviour outranks historical guidance, accepted PVH policy outranks generic AWS guidance, and external recommendations remain advisory. Test that conflicting accepted policy and live production behaviour returns `divergent` or `exception`, never an automatic rewrite.

- [ ] **Step 2: Write outage and confidence tests**

Test that GitLab outage allows a clearly marked general learning response but blocks a repository change. Test that missing AWS live evidence marks topology unverified. Test that empty memory or graph results mean `not recorded`, not `never happened`.

- [ ] **Step 3: Implement deterministic reconciliation**

Group evidence by claim key, sort by authority and freshness, retain disagreement, and produce:

```typescript
type StandardsComparison = {
  claim: string;
  pvhStandard?: EvidenceItem;
  liveImplementation?: EvidenceItem;
  terraformContract?: EvidenceItem;
  awsRecommendation?: EvidenceItem;
  alignment: Alignment;
  action: "explain" | "monitor" | "propose" | "escalate";
};
```

- [ ] **Step 4: Implement risk and stop gates**

Block proposed changes on unresolved repository, backend contract, shared-module version, destructive plan, state operation, public access, broad IAM expansion, secrets, or missing required live evidence.

- [ ] **Step 5: Add regression conversations**

Pin the expected account-vending behaviour: YAML/generator first, multiple current examples, no generic root resource as the answer of record.

- [ ] **Step 6: Run tests and eval fixtures**

```bash
bun test packages/agent/src/landing-zone/reconciliation.test.ts packages/agent/src/landing-zone/risk.test.ts
bun run eval:agent -- --agent landing-zone-terraform
```

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/landing-zone agents/landing-zone-terraform/examples
git commit -m "feat(landing-zone): reconcile PVH AWS and Terraform evidence"
```

## Phase 3: Agent Memory and knowledge graph

### Task 11: Add cross-session memory enrichment and outcome recording

**Files:**
- Create: `packages/agent/src/landing-zone/memory.ts`
- Create: `packages/agent/src/landing-zone/memory.test.ts`
- Modify: `packages/agent/src/landing-zone/graph.ts`
- Modify: `packages/agent/src/landing-zone/nodes.ts`
- Create: `agents/landing-zone-terraform/skills/search-memory/SKILL.md`

**Interfaces:**
- Produces: `memoryEnrichLandingZone`, `recordLandingZoneDecision`, `recordLandingZoneOutcome`.
- Consumes: existing `searchAgentMemory`, queued memory writer, and lifecycle flush.

- [ ] **Step 1: Write memory isolation tests**

Assert Landing Zone searches use `userId=landing-zone-terraform`, never `elastic-iac` or `incident-analyzer`. Assert repository, account, workflow, kind, MR URL, and config-change ID are stored as annotations.

- [ ] **Step 2: Write redaction and durability tests**

Assert secrets, state values, plan-sensitive values, and credentials are rejected or redacted. Assert durable decisions have no TTL and daily breadcrumbs use the configured daily-log TTL.

- [ ] **Step 3: Implement memory enrichment**

Retrieve specific semantic memory using repository/account/kind filters when known. Place results in a separate state field and label them as prior experience requiring live revalidation.

- [ ] **Step 4: Implement outcome recording**

Record reviewed outcomes with kinds defined in the specification. Proposed MR facts may expire after terminal reconciliation; final outcomes and key decisions remain durable.

- [ ] **Step 5: Run tests**

```bash
bun test packages/agent/src/landing-zone/memory.test.ts packages/agent/src/memory-backend.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/landing-zone agents/landing-zone-terraform/skills/search-memory
git commit -m "feat(landing-zone): add isolated cross-session memory"
```

### Task 12: Extend the knowledge graph for Landing Zone repositories and changes

**Files:**
- Modify: `packages/knowledge-graph/src/schema.ts`
- Modify: `packages/knowledge-graph/src/writer.ts`
- Modify: `packages/knowledge-graph/src/reader.ts`
- Modify: `packages/knowledge-graph/src/index.ts`
- Modify: `packages/knowledge-graph/src/knowledge-graph.test.ts`
- Modify: `packages/knowledge-graph/src/ladybug.integration.test.ts`
- Modify: `packages/mcp-server-knowledge-graph/src/tools/curated.ts`
- Create: `agents/landing-zone-terraform/skills/query-knowledge-graph/SKILL.md`

**Interfaces:**
- Produces: repository/module/root/change/MR/pipeline/plan graph writers and curated read tools.

- [ ] **Step 1: Write schema migration tests**

Add typed nodes for `GitLabGroup`, `Repository`, `TerraformRoot`, `TerraformModule`, `SharedModule`, `TerraformPlan`, `Standard`, and `ADR`. Reuse existing `ConfigChange`, `MergeRequest`, `Pipeline`, `Workflow`, `Session`, and `Prompt` where their semantics match.

Add relationships `CONTAINS`, `USES_MODULE`, `GOVERNED_BY`, `IMPLEMENTS`, `PRODUCED`, and compatible `TARGETS` tables for the new endpoint types.

- [ ] **Step 2: Write idempotent writer tests**

Test repeated imports merge the same stable entity, update freshness, and never create duplicate MRs, pipelines, or Terraform addresses.

- [ ] **Step 3: Implement writer contracts**

Export:

```typescript
recordLandingZoneRepository(store, record)
recordTerraformRoot(store, record)
recordModuleUsage(store, record)
recordLandingZoneChange(store, record)
recordTerraformPlan(store, record)
recordGovernanceBinding(store, record)
```

- [ ] **Step 4: Implement curated readers**

Add read-only tools for repository change history, module consumers, account-managing roots, MR/pipeline outcome, and standards governing a repository. Empty results must document graph incompleteness.

- [ ] **Step 5: Run unit and real-engine tests**

```bash
bun test packages/knowledge-graph/src/knowledge-graph.test.ts
bun test packages/mcp-server-knowledge-graph
```

When the native test environment is available:

```bash
bun test packages/knowledge-graph/src/ladybug.integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/knowledge-graph packages/mcp-server-knowledge-graph agents/landing-zone-terraform/skills/query-knowledge-graph
git commit -m "feat(knowledge-graph): model Landing Zone change history"
```

### Task 13: Import historical GitLab changes and reconcile outcomes

**Files:**
- Create: `packages/agent/src/landing-zone/gitlab-import.ts`
- Create: `packages/agent/src/landing-zone/gitlab-import.test.ts`
- Create: `agents/landing-zone-terraform/workflows/gitlab-import-sweep.yaml`
- Create: scheduler handler registration following the existing declarative schedule pattern.

**Interfaces:**
- Produces: idempotent historical import and scheduled incremental reconciliation.
- Consumes: GitLab read facade and Task 12 graph writers.

- [ ] **Step 1: Write fixture-based import tests**

Cover merged MR with successful plan only, merged MR with verified deployment, open MR, failed pipeline, closed MR, renamed project path, and missing artifacts.

- [ ] **Step 2: Define outcome rules**

Map outcomes as:

```text
open MR -> proposed
closed unmerged -> declined
pipeline failed -> pipeline-failed
merged without deployment evidence -> merged-unverified
deployment pipeline success or verified live state -> applied
```

- [ ] **Step 3: Implement paginated import**

Checkpoint by project and update timestamp. Use stable GitLab IDs and commit SHAs. Bound each run and resume without duplicating entities.

- [ ] **Step 4: Add the scheduled workflow**

Declare cadence and enablement in YAML. Keep it disabled by default until a controlled initial backfill completes.

- [ ] **Step 5: Run tests**

```bash
bun test packages/agent/src/landing-zone/gitlab-import.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/landing-zone agents/landing-zone-terraform/workflows
git commit -m "feat(landing-zone): import GitLab change history"
```

### Task 14: Add account, network, routing, and DNS graph model

**Files:**
- Modify: `packages/knowledge-graph/src/schema.ts`
- Modify: `packages/knowledge-graph/src/writer.ts`
- Modify: `packages/knowledge-graph/src/reader.ts`
- Create: `packages/agent/src/landing-zone/topology-extractor.ts`
- Create: `packages/agent/src/landing-zone/topology-extractor.test.ts`
- Create: `packages/agent/src/landing-zone/topology-reconcile.ts`
- Create: `packages/agent/src/landing-zone/topology-reconcile.test.ts`
- Modify: `packages/mcp-server-knowledge-graph/src/tools/curated.ts`

**Interfaces:**
- Produces desired, observed, and proposed topology with provenance and reconciliation status.

- [ ] **Step 1: Add network and DNS schema tests**

Add the account, OU, region, AZ, VPC, subnet, route table, route, gateway, central-network attachment, endpoint, hosted-zone, record, Resolver, ACL, IP, and CIDR entities from the specification.

- [ ] **Step 2: Test route-derived subnet classification**

Fixtures must prove that subnet names do not determine public/private classification. Classification uses associated route-table targets and explicit validated metadata.

- [ ] **Step 3: Test DNS/routing separation**

Create fixtures where DNS resolves but no route exists, route exists but the VPC lacks hosted-zone association, Resolver forwarding targets are unreachable, and PrivateLink private DNS is disabled.

- [ ] **Step 4: Implement Terraform desired-state extraction**

Extract only approved resource and configuration fields. Record repository, path, commit SHA, Terraform address, region, account, and source timestamp. Do not ingest Terraform state.

- [ ] **Step 5: Implement AWS observed-state adapters**

Consume read-only, allowlisted AWS evidence. Store identifiers and topology metadata only. Redact tags or fields classified as sensitive.

- [ ] **Step 6: Implement temporal reconciliation**

Use `validFrom`, `validTo`, `observedAt`, and source-specific ownership. Invalidate stale observations after configured misses; do not delete historical edges.

- [ ] **Step 7: Add curated topology reads**

Expose account network map, hostname resolution path, VPC route path, subnet route association, central-network attachment, and desired/observed drift queries.

- [ ] **Step 8: Run tests**

```bash
bun test packages/agent/src/landing-zone/topology-extractor.test.ts packages/agent/src/landing-zone/topology-reconcile.test.ts
bun test packages/knowledge-graph/src/knowledge-graph.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add packages/knowledge-graph packages/agent/src/landing-zone packages/mcp-server-knowledge-graph
git commit -m "feat(landing-zone): model account network and DNS topology"
```

### Task 15: Add network and DNS diagram projections

**Files:**
- Create: `packages/shared/src/landing-zone-topology.ts`
- Create: `packages/shared/src/landing-zone-topology.test.ts`
- Create: `packages/agent/src/landing-zone/topology-projection.ts`
- Create: `packages/agent/src/landing-zone/topology-projection.test.ts`
- Create: `apps/web/src/lib/components/LandingZoneTopologyCard.svelte`
- Create: `apps/web/src/lib/components/LandingZoneTopologyCard.test.ts`
- Modify: `apps/web/src/lib/stores/agent-reducer.ts`
- Modify: `apps/web/src/lib/stores/agent.svelte.ts`
- Modify: `apps/web/src/routes/+page.svelte`

**Interfaces:**
- Produces: account-network, DNS-resolution, and combined path projections.
- Consumes: reconciled graph topology from Task 14.

- [ ] **Step 1: Write projection tests**

Assert stable node IDs, cycle handling, account/VPC filters, proposed-edge styling, drift styling, unverified styling, and maximum-node limits.

- [ ] **Step 2: Define the SSE event**

Add a strict event carrying:

```typescript
type LandingZoneTopologyEvent = {
  type: "landing_zone_topology";
  view: "network" | "dns" | "path";
  topology: LandingZoneTopology;
};
```

- [ ] **Step 3: Implement text and Mermaid projection**

Keep the projection deterministic and escape all external labels. Include a compact legend and source summary.

- [ ] **Step 4: Implement the Svelte card**

Use existing design tokens, responsive card patterns, accessible text alternatives, and source links. Do not overload the live LangGraph triage pane; operational topology belongs in the answer card.

- [ ] **Step 5: Run tests**

```bash
bun test packages/shared/src/landing-zone-topology.test.ts packages/agent/src/landing-zone/topology-projection.test.ts apps/web/src/lib/components/LandingZoneTopologyCard.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared packages/agent/src/landing-zone apps/web/src
git commit -m "feat(web): show Landing Zone network and DNS maps"
```

## Phase 4: Governed GitOps proposals

### Task 16: Add write-disabled-by-default GitOps tools

**Files:**
- Create: `packages/mcp-server-landing-zone-iac/src/tools/write.ts`
- Create: `packages/mcp-server-landing-zone-iac/src/tools/write.test.ts`
- Modify: `packages/mcp-server-landing-zone-iac/src/config.ts`
- Modify: `packages/mcp-server-landing-zone-iac/src/server.ts`
- Modify: `agents/landing-zone-terraform/tools/landing-zone.yaml`
- Create: `agents/landing-zone-terraform/skills/open-mr/SKILL.md`

**Interfaces:**
- Produces gated tools `lz_create_branch`, `lz_commit_allowed_files`, `lz_open_merge_request`, and `lz_watch_pipeline`.

- [ ] **Step 1: Write disabled-mode tests**

Without `LANDING_ZONE_WRITE_ENABLED=true`, assert write tools are absent from `tools/list`, not merely rejected at execution time.

- [ ] **Step 2: Write repository and path guard tests**

Reject non-allowlisted projects, default-branch targets, stale base SHAs, generated sections, backend changes outside explicit scope, secrets, state files, and disallowed paths.

- [ ] **Step 3: Implement exact-SHA branch creation and commits**

Every write request includes project ID, base branch, base SHA, target branch, expected file SHA, change summary, and approved review token. Detect concurrent changes and stop instead of overwriting.

- [ ] **Step 4: Implement MR and pipeline observation**

Create an MR with evidence, validation results, risk summary, and expected plan shape. Read pipeline status and plan artifact; never trigger apply.

- [ ] **Step 5: Run package tests**

```bash
bun test packages/mcp-server-landing-zone-iac/src/tools/write.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-landing-zone-iac agents/landing-zone-terraform
git commit -m "feat(landing-zone): add gated GitOps write facade"
```

### Task 17: Add proposal graph, review interrupt, and resume API

**Files:**
- Modify: `packages/agent/src/landing-zone/state.ts`
- Modify: `packages/agent/src/landing-zone/graph.ts`
- Create: `packages/agent/src/landing-zone/change-nodes.ts`
- Create: `packages/agent/src/landing-zone/change-nodes.test.ts`
- Create: `apps/web/src/routes/api/agent/landing-zone/resume/+server.ts`
- Create: `apps/web/src/lib/components/LandingZonePlanReviewCard.svelte`
- Modify: `apps/web/src/lib/stores/agent-reducer.ts`
- Modify: `apps/web/src/lib/stores/agent.svelte.ts`
- Modify: `apps/web/src/routes/+page.svelte`

**Interfaces:**
- Produces: draft, validate, review, approve/reject/amend, MR, and pipeline flow.

- [ ] **Step 1: Write graph route tests**

Assert `learn`, `understand`, and `review` never enter write nodes. Assert `propose-change` cannot reach `openMergeRequest` without a successful risk gate, validation result, and human approval interrupt.

- [ ] **Step 2: Define review payload**

Include repository, base SHA, files, diff summary, standards comparison, validations, expected plan, stop conditions, destructive flags, and unresolved evidence. Validate with Zod before emitting the UI event.

- [ ] **Step 3: Implement candidate validation**

Run repository-configured formatting, validation, tests, and optional backend-disabled plan checks in an isolated environment. Mark unavailable commands accurately. The GitLab CI plan remains authoritative.

- [ ] **Step 4: Implement human interrupt and resume**

Accept only:

```typescript
z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("reject"), reason: z.string().min(1) }),
  z.object({ decision: z.literal("amend"), instructions: z.string().min(1) }),
]);
```

- [ ] **Step 5: Implement the review card**

Reuse Elastic IaC interaction patterns but use Landing Zone-specific evidence, risk, and plan sections. Clearly state that approval opens or updates an MR; it does not apply.

- [ ] **Step 6: Run graph, API, reducer, and component tests**

```bash
bun test packages/agent/src/landing-zone/change-nodes.test.ts
bun test apps/web/src/routes/api/agent/landing-zone/resume
bun test apps/web/src/lib/stores/agent.handleEvent.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/landing-zone apps/web/src
git commit -m "feat(landing-zone): add human-reviewed GitOps proposals"
```

## Phase 5: Evaluation, hardening, and rollout

### Task 18: Add evaluations and adversarial safety cases

**Files:**
- Create: `packages/agent/src/eval/landing-zone-dataset.ts`
- Create: `packages/agent/src/eval/landing-zone-evaluators.ts`
- Create: `packages/agent/src/eval/landing-zone-evaluators.test.ts`
- Add example cases under `agents/landing-zone-terraform/examples/`.

**Interfaces:**
- Produces repeatable LangSmith-compatible evaluation cases and CI thresholds.

- [ ] **Step 1: Create the benchmark set**

Include account creation, network core onboarding, workload network configuration, GitLab project creation, runner selection, provider version, backend conflict, module upgrade blast radius, DNS resolution, source outage, in-flight MR, malicious repository instruction, destructive request, and state-mutation request.

- [ ] **Step 2: Add evaluators**

Score repository routing, citation coverage, source hierarchy, representative-example count, correct uncertainty, no-apply compliance, no-default-branch-write compliance, and change-gate presence.

- [ ] **Step 3: Set CI gates**

Require 100% safety compliance and at least 90% correct repository/workflow routing before release. Store failed examples as regression fixtures.

- [ ] **Step 4: Run evaluations**

```bash
bun test packages/agent/src/eval/landing-zone-evaluators.test.ts
bun run eval:agent -- --agent landing-zone-terraform
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/eval agents/landing-zone-terraform/examples
git commit -m "test(landing-zone): add groundedness and safety evaluations"
```

### Task 19: Complete observability, security review, and documentation

**Files:**
- Create: `docs/architecture/landing-zone-terraform-agent.md`
- Create: `docs/operations/landing-zone-agent-runbook.md`
- Modify: deployment configuration and example environment documentation.
- Modify: root or application README agent list.

**Interfaces:**
- Produces operating documentation, alertable metrics, rollout controls, and recovery steps.

- [ ] **Step 1: Add LangSmith and metrics assertions**

Verify every turn carries agent, intent, repository, evidence-source availability, risk tier, outcome, and graph/memory usage metadata without sensitive values.

- [ ] **Step 2: Document feature flags**

Document read-only availability, knowledge graph, Agent Memory, AWS live reads, historical import, topology cards, and write-mode flags. State safe defaults and degraded behaviour.

- [ ] **Step 3: Perform security review**

Review OAuth/IAM scopes, repository allowlist, tool descriptions, Zod boundaries, prompt-injection resistance, redaction, log payloads, memory annotations, graph properties, and branch protections.

- [ ] **Step 4: Run the full completion gate**

```bash
bun run typecheck
bun run lint
bun test
bun run yaml:check
bun run tools:verify
bun run eval:agent -- --agent landing-zone-terraform
```

Expected: all commands pass. Report any environment-gated integration checks separately with their reason.

- [ ] **Step 5: Inspect the final diff**

Confirm:

- no direct apply or AWS mutation capability;
- no default-branch write path;
- no secret or state ingestion;
- no unrelated dependency or lockfile changes;
- no duplicated repository mirrors;
- every mode and graph topology test includes the third agent;
- every proposed-change route passes through human review;
- live triage node IDs come from the compiled graph;
- memory and graph results cannot override live evidence.

- [ ] **Step 6: Commit documentation**

```bash
git add docs README.md
git commit -m "docs(landing-zone): add architecture and operations guide"
```

### Task 20: Open the review merge request and stage rollout

**Files:**
- No additional product files unless review finds a defect.

**Interfaces:**
- Produces: reviewed MR and staged enablement plan.

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin feat/landing-zone-terraform-agent-readonly
```

- [ ] **Step 2: Open the merge request**

Include the specification, implementation plan, Linear epic, architecture summary, security boundaries, screenshots of all three modes and live triage, test results, evaluation results, and explicit deferred phases.

- [ ] **Step 3: Roll out read-only first**

Enable the agent for a small Platform Engineering cohort with write mode absent. Monitor source failures, incorrect routing, confidence, latency, and user feedback.

- [ ] **Step 4: Promote later phases separately**

Enable Agent Memory, knowledge graph, AWS reads, topology diagrams, and GitOps writes as separate reviewed changes. Do not combine write enablement with the initial read-only launch.

## Self-review results

- Spec coverage: every functional requirement maps to at least one task.
- UI parity: agent rotation and live triage use the current registry and compiled graph mechanisms.
- Memory separation: LangGraph checkpointer, Agent Memory, curated knowledge, live evidence, and knowledge graph remain distinct.
- Network coverage: VPC, subnet, routing, central-network, DNS, desired/observed/proposed state, and diagram projection are covered.
- Safety coverage: read-only first, write tool absence, allowlists, exact SHA, human interrupt, no apply, and outcome verification are explicit.
- Placeholder scan: implementation actions, interfaces, tests, and commands are specified without deferred implementation placeholders.
- Type consistency: `landing-zone-terraform`, `buildLandingZoneGraph`, evidence status values, reconciliation states, and review decisions are consistent throughout.
