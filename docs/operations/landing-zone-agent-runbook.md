# Landing Zone Agent Runbook

This runbook operates the `landing-zone-terraform` graph and its `landing-zone-iac` MCP server. It does not authorize Terraform apply, state mutation, default-branch writes, or a production AWS change.

## Safe bring-up

1. Start with write mode disabled. Configure `LANDING_ZONE_IAC_MCP_URL`, `GITLAB_BASE_URL`, and a least-privilege read token for the approved Landing Zone repositories.
2. Start `packages/mcp-server-landing-zone-iac/src/index.ts` and the web application.
3. Check MCP identity/readiness and inspect `tools/list`. The ten `lz_*` evidence/topology tools should be present. `lz_create_branch`, `lz_commit_allowed_files`, and `lz_open_merge_request` must be absent.
4. In the UI, switch to **PVH Landing Zone Terraform** and ask a read-only repository question. Confirm the answer states unavailable evidence instead of filling gaps from memory.
5. Inspect the `agent.landing-zone.turn` log. It should contain categorical telemetry only. Reject a release if prompts, account IDs, ARNs, evidence text, paths, or credentials appear.

Local connection example:

```bash
LANDING_ZONE_IAC_MCP_URL=http://localhost:9088
LANDING_ZONE_IAC_MCP_PORT=9088
GITLAB_BASE_URL=https://gitlab.com
LANDING_ZONE_WRITE_ENABLED=false
```

Keep tokens in the deployment secret store, never in `.env.example`, committed manifests, logs, LangSmith metadata, Agent Memory, or the knowledge graph.

## Capability checks

| Check | Expected result |
|---|---|
| Read-only question with healthy GitLab | GitLab and OKF show `collected`; answer cites current repository evidence. |
| GitLab unavailable | Learning may degrade with an explicit limitation; review/change requests stop when current repository evidence is required. |
| Terraform/AWS documentation | `unavailable` until their collector adapters are installed; do not advertise these as active integrations. |
| AWS live-state question | `skipped` or `unavailable` in the current production graph; no deployed-state claim is presented as verified. |
| Memory enabled | Recall is advisory and appears only after live claim revalidation. |
| Knowledge graph disabled | Knowledge-graph evidence is unavailable and topology cards are absent; the text answer still completes when its required evidence exists. |
| Unauthorized account topology | No topology card and no account data in completion telemetry. |

## Enabling governed proposal mode

Do this only after security review and a read-only soak period.

1. Create a dedicated GitLab write credential. It must not be the read token and must not be able to merge, approve, run pipelines, or modify repositories outside the approved list.
2. Generate an independent review-signing secret of at least 32 bytes.
3. Set exact project paths in `LANDING_ZONE_WRITE_PROJECTS`.
4. Set `LANDING_ZONE_WRITE_PATHS` to a JSON object whose keys exactly match those project paths and whose values are the narrowest allowed repository-relative prefixes.
5. Leave `LANDING_ZONE_WRITE_BACKEND_PROJECTS` empty unless backend changes have a separately approved governance path.
6. Set `LANDING_ZONE_WRITE_ENABLED=true`, restart only the Landing Zone MCP, and inspect `tools/list` again.
7. Exercise a disposable test proposal. Confirm that the graph pauses on `landing_zone_plan_review`, rejection performs no write, amendment invalidates the prior review, and approval can open only an MR on an `agent/landing-zone/` branch.
8. Confirm the agent neither merges nor applies after a green pipeline.

Required settings:

```bash
LANDING_ZONE_WRITE_ENABLED=true
LANDING_ZONE_GITLAB_WRITE_TOKEN=<secret-store-reference>
LANDING_ZONE_WRITE_REVIEW_SECRET=<secret-store-reference>
LANDING_ZONE_WRITE_PROJECTS=pvhcorp/dhco/aws/aws-landing-zone/<approved-project>
LANDING_ZONE_WRITE_PATHS={"pvhcorp/dhco/aws/aws-landing-zone/<approved-project>":["<approved-prefix>/"]}
LANDING_ZONE_WRITE_BACKEND_PROJECTS=
```

Configuration fails closed when a credential is missing, read and write tokens match, the signing secret matches the write token, a project lacks a path allowlist, or a backend project is not also write-allowlisted.

## Historical import

The `gitlab-import-sweep` workflow is manual. Before its first run:

1. Enable and migrate the knowledge graph.
2. Verify the five required historical read tools are connected: repository list, historical MR list, MR read, MR pipelines, and deployments.
3. Choose an explicit UTC backfill start and fixed upper bound.
4. Run a bounded page and retain the returned checkpoint.
5. Verify imported records contain repository/MR/pipeline/deployment metadata and summarized outcomes only. Stop if plan content, state, variables, or secrets appear.
6. Resume from the checkpoint until the bounded window completes. Do not enable a schedule until this controlled backfill is reviewed.

Authentication failures back off for 15 minutes per rejected token value. Rotate the secret and restart the process rather than retrying the same rejected value.

## Observability

Search structured logs for `agent.landing-zone.turn`. Required fields are:

```text
agent, intent, repositories, evidenceAvailability,
riskTier, outcome, graphUsed, memoryUsed, knowledgeGraphUsed, responseTime
```

LangSmith runs should have the `agent:landing-zone-terraform` tag and invocation metadata `agent_id=landing-zone-terraform`, `graph_used=true`. Completion telemetry is deliberately kept in the local structured log/SSE event; do not copy evidence, prompts, account scope, or generated content into trace metadata.

Alert on sustained changes in categorical outcomes, not high-cardinality values:

- rising `failed` or `blocked` outcomes;
- GitLab availability changing from `collected` to `unavailable`;
- memory or knowledge-graph usage unexpectedly dropping after enablement;
- any write tool appearing while write mode is intended to be off;
- any attempted write before the human review interrupt.

## Troubleshooting

### Repository answer is generic or blocked

Check `LANDING_ZONE_IAC_MCP_URL`, MCP health, token access to the exact private project, the repository catalog entry, and the GitLab evidence status. A README alone is not enough: the collector also needs contract files, active examples, and relevant open changes. Do not work around an outage by relying on memory.

### Topology card is missing

Confirm `KNOWLEDGE_GRAPH_ENABLED`, graph health, an authorized UI estate whose account ID matches the request, current `TopologyFact` rows, and a request containing topology/DNS/path intent. Missing data is a valid empty result. Do not create synthetic nodes to force a diagram.

### Proposal stops before review

Inspect reconciliation conflicts, risk stop conditions, current default-branch SHA, candidate validation results, repository/path allowlists, and backend-change approval. The safe recovery is to correct evidence or configuration and start a new proposal, not to bypass the gate.

### Approval does not open an MR

Confirm the review ID is still pending, the signed capability has not expired, base and file SHAs still match, the target branch starts with `agent/landing-zone/`, and the dedicated write token retains only its intended permissions. A stale capability must be regenerated through review.

## Kill switches and rollback

1. Set `LANDING_ZONE_WRITE_ENABLED=false` and restart the Landing Zone MCP. Confirm the three write tools disappear from `tools/list`.
2. If reads are unsafe, unset `LANDING_ZONE_IAC_MCP_URL` in the web runtime and restart it.
3. If graph data is suspect, set `KNOWLEDGE_GRAPH_ENABLED=false`; preserve the database for investigation rather than deleting it.
4. If memory data is suspect, disable live memory or switch away from the Agent Memory backend. Preserve audit records and rotate exposed credentials.
5. Revoke the affected GitLab token and review open `agent/landing-zone/` branches and MRs. The agent has no merge/apply authority, so containment should not require Terraform state operations.

## Release verification

Run the repository-configured gates:

```bash
bun run typecheck
bun run lint
bun run test
bun run yaml:check
bun run tools:verify
bun run eval:agent -- --agent landing-zone-terraform
```

The Landing Zone evaluation disables LangSmith tracing and keeps evaluator results local. It still invokes the configured model with evidence returned by the private Landing Zone MCP, so run it only in an environment where that model-provider data flow is authorized. If the MCP URL or authorization is unavailable, report the gate as not run instead of substituting fabricated evidence.

Before release, inspect the diff and verify no secrets, account IDs, ARNs, state files, plan content, default-branch writes, apply/state tools, or automatic historical backfill were introduced.
