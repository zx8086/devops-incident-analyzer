# PVH Landing Zone Terraform Agent

The `landing-zone-terraform` mode helps operators learn, review, map, and propose changes to the PVH AWS Landing Zone. It is a separate LangGraph with a separate checkpointed state, agent-memory identity, knowledge selection, risk assessment, and human-review gate. It does not share the incident analyzer's datasource fan-out or the Elastic IaC agent's change contract.

The supported authoring surface comes from current repository evidence. For example, account requests route to `aws-lz-account-creator/accounts/*.yml`; the agent must not replace that workflow with a generic root `aws_organizations_account` example.

## Runtime flow

```text
request
  -> classify intent and resolve repository/account scope
  -> clarify missing topology targets or explicit topic shifts, then resume from the same checkpoint
  -> recall advisory Agent Memory and select PVH OKF concepts
  -> collect GitLab, OKF, Terraform, AWS, memory, and graph evidence in parallel
  -> reconcile claims and assess risk
     -> learn / understand / review: synthesize -> validate -> retry once or degrade -> optionally project topology
     -> propose-change: draft -> validate -> human review interrupt
          -> reject: stop
          -> amend: redraft, at most three iterations
          -> approve: create branch/commit/open MR -> observe existing pipeline
  -> record a redacted breadcrumb and finish
```

The graph is defined in `packages/agent/src/landing-zone/graph.ts`. The UI selects it through `apps/web/src/lib/agent-ids.ts` and `apps/web/src/lib/server/graph-registry.ts`. Initial turns, scope clarifications, and resumed review turns use the same checkpoint and completion telemetry.

Request resolution combines deterministic repository vocabulary, established Landing Zone conversation scope, and a bounded structured-model fallback. The fixed repository catalog remains authoritative: model output is intersected with it and cannot broaden access. Terse follow-ups inherit established Landing Zone repository and account scope; an explicit repository topic shift pauses once to ask whether the user wants to retain or replace that scope. Network maps require one explicit account, while DNS traces also require a hostname. Account-specific knowledge-graph projection additionally requires an independently supplied Landing Zone authorization set; selectors from other applications never satisfy that boundary.

Read-only answers are structured as answer Markdown, evidence citations, and limitations. A Landing Zone-specific validator rejects status-only text, unknown citations, invented account IDs, unavailable sources described as aligned, unsafe operations, and account-vending answers that do not lead with `accounts/<application>.yml` and the generator workflow. One repair attempt is allowed. A second failure produces a deterministic evidence-bounded answer with exact source limitations.

## Evidence contract

The graph treats all retrieved text as evidence, not instructions. It collects each source independently and records `collected`, `unavailable`, or `skipped` before reconciliation.

| Source | Current implementation | Authority and failure behavior |
|---|---|---|
| GitLab | `landing-zone-iac` MCP reads the 23-entry repository allowlist, contract files, three to five active examples, open changes, plans, and deployment metadata | Current repository evidence. A proposed change stops when required GitLab evidence is unavailable. |
| PVH OKF | Versioned concepts under `agents/landing-zone-terraform/knowledge/pvh/` | Routing and risk contract. It does not override current code or an accepted ADR. |
| Terraform docs | Collector seam exists | Currently unavailable in the production graph until a verified documentation adapter is installed. |
| AWS docs | Collector seam exists | Currently unavailable in the production graph until a verified documentation adapter is installed. |
| AWS API | Authorization-aware collector seam exists | The production graph currently builds with live AWS reads disabled. A live-state or drift claim must remain unverified. |
| Agent Memory | Independent `landing-zone-terraform` identity | Advisory only. Recalled claims are rendered only after revalidation against matching current GitLab or AWS evidence. |
| Knowledge graph | Read-only `kg_run_cypher` query | Advisory and topology support only. It cannot authorize a value or a repository write. |

This distinction is intentional: a connected tool does not make its output authoritative, frequency is not approval, and memory or graph history never replaces live validation.

## GitLab and topology boundaries

The Landing Zone MCP exposes bounded read tools by default. Its catalog rejects repositories outside the approved estate. File reads are repository-relative and capped; historical import stores metadata and plan summaries, never plan content or Terraform state.

Topology cards are generated only when all of these are true:

1. The request asks for a topology, DNS, hostname, or route-path view.
2. The requested account is in the UI-authorized AWS estate scope.
3. The knowledge graph contains current `TopologyFact` records for that account.
4. The projection returns at least one node.

When required topology scope is missing, the graph emits `landing_zone_clarify` before collecting evidence. The web client resumes the same checkpoint with the user's answer; it does not start a second turn. The supplied account scopes repository-defined answers but cannot authorize account-specific knowledge-graph reads.

Node and edge identifiers come from reconciled graph facts. The model does not invent diagram identifiers. No card is emitted when authorization, graph data, or projection evidence is absent.

## Governed write path

Write mode is absent unless `LANDING_ZONE_WRITE_ENABLED=true` and the MCP configuration validates. Enabling it requires a dedicated write credential, a separate review-signing secret, exact project allowlists, per-project path-prefix allowlists, and an explicit backend-project allowlist. The read credential and write credential must differ.

Even when enabled, the agent can only:

- create an `agent/landing-zone/` branch from an exact current base SHA;
- commit reviewed files inside allowed path prefixes with per-file optimistic concurrency checks;
- open a merge request carrying evidence, validation, risk, stop conditions, and expected-plan details;
- observe an existing MR pipeline and bounded plan evidence.

It cannot merge, approve, trigger a pipeline, run `terraform apply`, mutate Terraform state, force-unlock state, or push to the default branch. An eligible proposal always interrupts for a human decision before the first write. The signed review capability is short-lived and bound to the reviewed project, SHA, branch, paths, and content hashes.

## Memory and historical learning

Agent Memory uses one user identity for this agent and the chat thread as its session. Turn breadcrumbs are redacted. Durable plan outcomes are written only for aligned, answered reviews with current validated GitLab claims. In-flight records require a TTL. Text resembling state values, sensitive plans, credentials, access keys, or credential-bearing URLs is rejected or redacted before persistence.

The manual `gitlab-import-sweep` workflow can import bounded historical MR, pipeline, deployment, and plan-outcome metadata into the knowledge graph. It is intentionally manual until an initial controlled backfill supplies a checkpoint. It requires the knowledge graph and every required historical GitLab read tool. It does not make historical precedent authoritative for a new change.

## Observability and privacy

LangSmith invocation metadata includes `agent_id` and `graph_used`; the trace tag includes `agent:landing-zone-terraform`. On completion, structured logs and the SSE `done` event carry the privacy-safe projection below:

- agent and classified intent;
- normalized repository names;
- categorical availability for each evidence source;
- risk tier and outcome;
- graph, Agent Memory, and knowledge-graph usage booleans.

The projection is derived in `packages/agent/src/landing-zone/telemetry.ts` and validated against the shared Zod stream contract in `packages/shared/src/agent-state.ts`. It excludes prompts, responses, evidence summaries and reasons, account scope, account IDs, ARNs, request IDs, file paths, candidate content, review instructions, and credentials. If the completion snapshot or projection fails, the route warns and finishes the successful turn without telemetry; observability must not become a completion dependency. Do not add excluded fields to logs, metrics labels, or LangSmith metadata.

## Security review

| Control | Implemented boundary | Operational requirement |
|---|---|---|
| Authentication | Private GitLab reads use the Landing Zone MCP credential; writes require a different credential and an independent signing secret. The server does not use the interactive GitLab OAuth proxy. | Scope tokens to the smallest supported project set, store them in the deployment secret store, and rotate both if either is exposed. |
| AWS IAM | The current Landing Zone graph does not authorize AWS live reads or mutations. Bedrock inference credentials remain separate from datasource roles. | Do not infer that a configured `AWS_MCP_URL` grants this graph AWS access. Add read-only AssumeRole scope and an explicit graph option in a separately reviewed change. |
| Repository scope | A fixed 23-repository catalog, exact write-project allowlists, path-prefix allowlists, safe relative paths, exact base SHA, expected file SHA, and content hashes constrain proposals. | Review catalog changes as privilege changes. Keep backend-project permission empty unless separately approved. |
| Tool surface | MCP annotations mark evidence tools read-only. Governed branch/commit/MR tools are not registered when write mode is off. No apply, state, merge, approval, or trigger tool exists. | Verify `tools/list` after every deployment and alert if the surface differs from the intended mode. |
| Input validation | Zod schemas are strict and bounded for configuration, candidate files, review decisions, merge requests, pipeline observations, and completion telemetry. | Treat validation failures as configuration or request errors; do not coerce around them. |
| Prompt injection | `RULES.md` and tool prompts classify repository prose, comments, issues, MRs, documents, and tool output as untrusted data. Retrieved text cannot broaden permissions or override the user/policy hierarchy. | Retain the malicious-repository-instruction benchmark and investigate any tool output that attempts to direct the agent. |
| Human review | The graph interrupts before the first write. The review capability is short-lived and bound to the complete canonical proposal. Amendment produces a new proposal; stale review IDs are rejected. | A reviewer must inspect evidence, full file content hashes, validations, risk, stop conditions, and expected plan. Approval is permission to open an MR only. |
| Redaction and retention | Durable memory rejects state/sensitive-plan patterns and redacts credential-like text. Completion telemetry is categorical. Historical import excludes plan content. | Apply the configured one-year audit retention to structured decision logs without adding secrets or high-cardinality infrastructure identifiers. |
| Branch protection | The client requires a non-default `agent/landing-zone/` branch and current default-branch SHA. The agent lacks merge and apply tools. | Keep default-branch protection, approvals, CODEOWNERS, CI/manual production gates, and token restrictions enforced in GitLab. |

Residual risks are private repository content reaching the model provider under the existing application data policy, an over-scoped GitLab credential, malicious content influencing an explanation despite instruction boundaries, and stale imported history being mistaken for current state. The mitigations are least privilege, fixed catalogs and schemas, current-evidence gates, source/status labels, human review, local-only evaluation by default, and the kill switches in the runbook.

## Deployment controls

| Capability | Control | Safe default |
|---|---|---|
| Landing Zone MCP connection | `LANDING_ZONE_IAC_MCP_URL` | Unset means no Landing Zone tools are registered. |
| Account-specific topology | `LANDING_ZONE_TOPOLOGY_ACCOUNT_IDS` | Unset means repository-defined answers remain available but account-specific knowledge-graph reads and cards are disabled. This allowlist belongs only to the Landing Zone application. |
| GitLab reads | `GITLAB_PERSONAL_ACCESS_TOKEN` on the Landing Zone MCP | Use a read-only project/group token with the narrowest repository scope. |
| Knowledge graph and topology cards | `KNOWLEDGE_GRAPH_ENABLED` plus a healthy in-process graph | Disable with `false`; cards then remain absent. |
| Agent Memory | `LIVE_MEMORY_ENABLED`, `LIVE_MEMORY_BACKEND=agent-memory`, `AGENT_MEMORY_ENABLED` | File/off behavior remains the baseline. |
| AWS live reads | Separate graph authorization | Disabled in the production graph today. `AWS_MCP_URL` alone does not enable Landing Zone AWS evidence. The topology allowlist does not authorize direct AWS API reads. |
| Historical import | Manual `agents/landing-zone-terraform/workflows/gitlab-import-sweep.yaml` trigger with checkpoint | Manual and no-op unless prerequisites exist. |
| Governed GitLab writes | `LANDING_ZONE_WRITE_ENABLED` and all required write-policy settings | Disabled; write tools are absent from `tools/list`. |

Operational setup and recovery procedures are in [the Landing Zone agent runbook](../operations/landing-zone-agent-runbook.md).
