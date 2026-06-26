# Ingest-pipeline simulate validation (SIO-1020)

## Context

SIO-1019 added the `ingest-pipeline-create` elastic-iac workflow: the agent writes a NEW
`@custom` ingest-pipeline JSON file (body committed verbatim) and opens an MR. Today the only
pre-MR check is structural (the body must be a JSON object). A malformed pipeline — a bad
processor config, an uncompilable grok pattern — is only caught later by CI's terraform
plan/apply.

We want to **simulate the pipeline against Elasticsearch before opening the MR**, so a genuinely
invalid pipeline is blocked at propose-time with the real ES error, not at apply-time.

The capability exists (`elasticsearch_simulate_ingest_pipeline` on the elastic-mcp server, and
the `_ingest/pipeline/_simulate` API accepts an inline `pipeline` + `docs`), but the elastic-iac
agent is wired ONLY to the `elastic-iac-mcp` server (9086), not elastic-mcp (9080). So we add the
simulate as a NEW tool on the elastic-iac-mcp server, reusing its existing per-deployment
data-plane connection.

## Approach

Two parts: a new MCP tool on the iac server, and a best-effort validation step in the proposer.

### Part 1 — `elastic_simulate_ingest_pipeline` tool (mcp-server-elastic-iac)

New tool in `packages/mcp-server-elastic-iac/src/tools/elastic.ts`, registered in
`registerElasticTools`. It POSTs the inline pipeline + sample docs to the deployment's data-plane
`_ingest/pipeline/_simulate` endpoint and returns the raw `[<status>] <body>` string.

- **Connection**: reuse the existing per-deployment cluster connection. Add a `clusterPost`
  sibling to the existing GET-only `clusterFetch` (same `resolveCluster` URL+auth resolution, same
  `[<status>] <body>` result convention). **Security**: the tool takes a `deployment` NAME only
  (never a model-supplied URL) — identical to the existing read tools, so it is not an SSRF
  primitive.
- **Input schema** (zod): `pipeline: z.record(z.string(), z.unknown())` (the inline body),
  `docs: z.array(z.record(z.string(), z.unknown()))` (sample docs), `deployment: z.string().optional()`,
  `verbose: z.boolean().optional()`.
- **Result**: `text("[200] {...}")` on success / `text("[400] {...}")` on an ES rejection /
  the `clusterFetch` "not configured" / "request failed" placeholders. Read-only — `_simulate`
  never mutates the cluster.
- Auto-binds to the agent via the `elastic_*` glob in `agents/elastic-iac/tools/elastic-iac.yaml`;
  also list it under the `read_state` action_tool_map for the action-driven facade.

### Part 2 — best-effort simulate in `proposeIngestPipelineCreate`

After the per-entry structural validation and BEFORE creating the branch, simulate each entry's
body. Behavior:

- **Sample docs**: synthesize a minimal doc per entry — `[{ _source: {} }]`. This validates what
  matters at propose-time: that every processor *compiles* (a bad grok regex, an unknown processor,
  a malformed `set`/`drop` config fails to compile regardless of the doc). It does NOT assert the
  pipeline transforms real data a certain way (that needs representative docs the user did not
  provide). A `drop`/`set`/`rename` pipeline simulates cleanly against an empty doc; a structurally
  broken one does not.
- **Block on a real rejection**: if simulate returns an ES `[4xx]` (a compile/parse error), BLOCK
  with `blockedReason` quoting the ES error and the offending pipeline name. The body is genuinely
  invalid — no MR.
- **Warn-and-proceed on unavailability**: if the deployment is not configured, the cluster is
  unreachable, the request times out, or the tool is absent, do NOT block. Simulate is a
  best-effort guard; a working feature must not hard-depend on optional cluster connectivity
  (consistent with how `clusterFetch` degrades and how the agent treats the iac server). Record the
  skip so the MR description can note "simulate skipped (cluster unreachable)".
- The result interpretation is a PURE exported helper `interpretSimulateResult(raw)` →
  `{ ok: true } | { ok: false; reason: string } | { skipped: true; note: string }`, unit-tested
  directly (the existing elastic.test.ts style — pure helpers, no fetch mock).

### Wiring points

| # | File | Change |
|---|---|---|
| 1 | `mcp-server-elastic-iac/src/tools/elastic.ts` | `clusterPost` helper (POST + JSON body); `elastic_simulate_ingest_pipeline` tool in `registerElasticTools` |
| 2 | `agents/elastic-iac/tools/elastic-iac.yaml` | add `elastic_simulate_ingest_pipeline` under `read_state` action_tool_map (glob already covers binding) |
| 3 | `agent/src/iac/nodes.ts` | `interpretSimulateResult()` pure helper; call simulate in `proposeIngestPipelineCreate` (block on reject / warn on unavailable); thread a `simulateSkipped` note into the MR description |
| 4 | tests | `elastic.test.ts`: assert simulate result shape is parsed (pure helper); `ingest-pipeline-create.test.ts`: simulate-passes-creates, simulate-rejects-blocks, simulate-unavailable-warns-and-proceeds (mock the `elastic_simulate_ingest_pipeline` tool via the existing `mockTools` map) |

### Risk / non-goals

- Empty-doc simulate catches processor-compile errors, NOT data-shape correctness. Documented as a
  known limit; representative-doc simulate is a future opt-in (`docs` could come from the user).
- `script` processors with `lang: painless` compile during simulate — a benefit (catches script
  compile errors) at no extra cost.
- No new package dependency (HTTP POST, not the ES SDK).

## Verification

```bash
bun run typecheck && bun run lint
bun run --filter @devops-agent/agent test
bun run --filter @devops-agent/mcp-server-elastic-iac test
```

Plus a live probe once a cluster is configured: call `elastic_simulate_ingest_pipeline` with a
known-bad grok pattern and confirm a `[400]` with the ES compile error; call with the Cisco
`drop` body and confirm `[200]`.
