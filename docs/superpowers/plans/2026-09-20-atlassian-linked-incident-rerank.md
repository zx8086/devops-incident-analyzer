# Plan: rank and re-rank Atlassian linked incidents for the findings card with Jev

Date: 2026-09-20. Ticket: https://linear.app/siobytes/issue/SIO-1837 (Todo; claim it before the first edit).
Parent epic: https://linear.app/siobytes/issue/SIO-1836.

## Context

The Atlassian findings card shows tickets returned by `findLinkedIncidents`. Relevance today is
decided twice, both times by keyword arithmetic:

1. In the MCP tool: additive integer score (label or component 3, service in text 2, each keyword 1),
   two-tier sort, `slice(0, limit)` (`packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts:181-240, 387-402`).
2. In the agent: `isWeakHit` drops a ticket with no structural hit and fewer than two keyword hits
   (`packages/agent/src/correlation/extractors/atlassian.ts:57-64`).

Neither step knows what the incident is about. The code comments record the result: all 15 linked
issues unrelated on one run ("styles scope" matched a ticket saying "Style" and "out of scope",
SIO-1802), all 10 findings dropped on another while Atlassian was the most load-bearing source
(SIO-1244), generic keywords filling every slot (1,043 matches).

The fix is the re-ranking pattern from the TypeSafe cookbook: keep the cheap retrieval, then ask
Jev one question per (incident, ticket) pair and order by the answer.

## Probe results (2026-09-20, synthetic tickets, real API, `jev-1.13.0`)

Ten tickets scored in parallel against one incident ("order-service consumers timing out on
Couchbase KV reads"): wall time 740 ms, 3,953 input tokens (about $0.00017).

| Score (0-3) | Ticket |
|---|---|
| 2.96, 2.94, 2.81 | the three tickets describing KV timeouts on the order consumers |
| 2.04 | same service, different failure (p99 regression after a deploy) |
| 1.66, 1.64 | same platform or same service, unrelated work |
| 0.17 | Kafka lag on another service |
| 0.03, 0.03, 0.01 | "Out of scope: style guide refresh", Jira access request, "Sprint 42 retrospective: styles, scope" |

The exact false-positive shapes from SIO-1802 land at the bottom. Real response shape captured:
`answers.<id> = { type: "score", score, confidence, legend, probabilities }`, plus `usage.input_tokens`.

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| Where | Agent side, in `extractFindings` (runs after `aggregate`) | Only the agent knows the incident. `state.finalAnswer` already exists there, so the query can be the report's own summary. The MCP tool only ever sees a service name and keywords. |
| What it affects | The card and everything reading `atlassianFindings` after `extractFindings`. Not the report text, which is written earlier. | This is what was asked for. Re-ranking what the sub-agent LLM sees is a separate change. |
| Question shape | One Score per pair, 4 levels (unrelated / generic overlap / same service, different failure / same service and same failure) | Matches the rerank and entity-alignment cookbooks. The level a ticket lands on is also a ready-made card label. |
| Request shape | One request per ticket, `Promise.all` | Vendor pattern for pairs; other tickets in the same state would be distractors (documented accuracy loss). Cost difference is negligible. |
| Client | Plain `fetch` to `POST https://api.typesafe.ai/v1/systemone`, response parsed with Zod | No `package.json` change. About 40 lines. Pin `jev-1.13.0`, not `jev-latest`, because the drop threshold is tuned against a version. |
| Failure mode | Any error, timeout (3 s total deadline), or missing key returns today's deterministic result unchanged | Same safety property as `gaps-judge.ts`: the new step can never make the card worse than it is now. |
| Gate | `ATLASSIAN_RERANK_ENABLED`, default ON, `false`/`0` disables; self-skips when `TYPESAFE_API_KEY` is unset | Repo rule: capability flags default ON, availability follows infrastructure. Mirrors `isGapsJudgeEnabled`. |
| Weak hits | With rerank active, weak hits are sent to Jev instead of being dropped by `isWeakHit`. With rerank off or failed, `isWeakHit` applies exactly as today. | A single-keyword ticket is precisely the case arithmetic cannot judge. This is how SIO-1244-style losses get rescued. |
| Drop rule | Drop when score < 1.0; keep order by score descending, ties by the tool's existing order | Level 1 is "generic overlap only". Threshold is a named constant, tuned in step 5 on real envelopes before merge. |
| Privacy | `redactPiiContent` over incident text and ticket text before sending | Existing utility in `packages/shared/src/pii-redactor.ts`. Ticket summaries and excerpts do leave the account; that is the accepted cost of this feature. |

## Steps

### 1. MCP tool: carry a description excerpt (`packages/mcp-server-atlassian`)

`ShapedIssue` has only key, summary, status, dates. The description is already fetched
(`LINKED_INCIDENT_FIELDS`, line 171) and used by `attributeMatch`, then thrown away. Add
`descriptionExcerpt: z.string().optional()` to `ShapedIssueSchema` and fill it in `shapeIssue`
(whitespace-collapsed, first 600 chars). Summary alone separated the probe set well, but real
incident summaries are written in business language (SIO-1244), so the excerpt is what makes the
judgment reliable. It also closes the SIO-1159 gap where the sub-agent saw a ticket with no body.

Validate by running the tool live, not only by typecheck.

### 2. Shared schema (`packages/shared/src/agent-state.ts:439`)

Add to `AtlassianLinkedIssueSchema`, all optional so recorded envelopes and old checkpoints parse:
`descriptionExcerpt`, `relevance` (number 0-3), `relevanceConfidence` (number 0-1).
Add `rerank: z.enum(["applied", "skipped", "failed"]).optional()` and `rerankDropped: z.number().optional()`
to `AtlassianFindingsSchema` so the card and logs can say what happened.

### 3. Jev client (`packages/agent/src/typesafe-client.ts`, new)

`askSystemOne(state, questions, { signal })`: fetch, bearer key from `process.env.TYPESAFE_API_KEY`
read at call time, Zod schema for the response built from the captured shape above, throws on
non-200. No retries in v1 (the caller has a 3 s budget and a deterministic fallback).

### 4. Rerank step (`packages/agent/src/atlassian-rerank.ts`, new)

- `isAtlassianRerankEnabled(env)`: kill-switch plus key presence.
- `buildIncidentQuery(state)`: focus services, `normalizedIncident` severity and services, the last
  user message, and the first paragraph of `state.finalAnswer` (reuse the `firstParagraph` idea from
  `action-tools/pi-verifier.ts:186`), capped at about 1,200 chars, PII-redacted.
- `rerankLinkedIssues(issues, query, deps)`: one Score request per issue in parallel under one
  `AbortSignal.timeout(3000)`; returns issues with `relevance` set, sorted, sub-threshold dropped.
  Returns `null` on any failure so the caller keeps the deterministic list.

Wire it in `extract-findings.ts:288` (the function is already `async`, currently with no awaits):
run the pure extractor as today; when rerank is enabled, run it a second time with a
`keepWeakHits` option, rerank that list, and use the result; otherwise use the first list.
Extend the `logCard` call with `rerank`, `rerankDropped`, top and bottom scores, and duration.

`extractAtlassianFindings` gains one optional parameter (`{ keepWeakHits?: boolean }`). Its default
behaviour and all existing tests stay untouched.

### 5. Tune the threshold on real data before merge

Memory rule: capture real API output first, never certify a fixture you imagined. Run
`findLinkedIncidents` live for three known cases (the SIO-1802 "styles scope" incident, the
SIO-1244 prana AFS incident with DEVOPS-1405, one clean recent incident), save the envelopes under
`packages/agent/src/__fixtures__/atlassian-rerank/`, and run a one-off script that prints the
ranked table per case. Success: the known-relevant tickets rank in the top 3 and the known junk
falls under the threshold. Adjust `RERANK_DROP_BELOW` from those numbers, not from the synthetic
probe.

### 6. Card (`apps/web/src/lib/components/AtlassianFindingsCard.svelte`)

Rows already render in array order, so ranking needs no change. Add one chip per row from
`relevance` ("same failure", "same service", "loose match") next to the existing `matchedBy` chip,
and a one-line note when `rerankDropped > 0` ("3 low-relevance tickets hidden"). Tailwind only.
Use the svelte-file-editor agent and the Svelte autofixer for this file.

### 7. Tests (no mocking of the network client beyond an injected function)

- `atlassian-rerank.test.ts`: `rerankLinkedIssues` takes the ask function as a dependency, so tests
  pass a plain function returning recorded real responses from step 5. Cases: ordering, threshold
  drop, tie order, one request failing returns `null`, timeout returns `null`, PII redacted in the
  outgoing state (plant an email and assert it is absent).
- `correlation/extractors/atlassian.test.ts`: `keepWeakHits` keeps weak hits; default unchanged.
- `extract-findings` test: rerank disabled produces byte-identical findings to today.
- `AtlassianFindingsCard.test.ts`: chip and hidden-count note.
- MCP tool test: `descriptionExcerpt` present, capped, absent when the ticket has no description.

## Files

| Package | File | Change |
|---|---|---|
| mcp-server-atlassian | `src/tools/custom/find-linked-incidents.ts` | `descriptionExcerpt` in schema and `shapeIssue` |
| shared | `src/agent-state.ts` | optional fields on the two Atlassian schemas |
| agent | `src/typesafe-client.ts` (new) | fetch client + response schema |
| agent | `src/atlassian-rerank.ts` (new) | gate, query builder, rerank |
| agent | `src/correlation/extractors/atlassian.ts` | optional `keepWeakHits` |
| agent | `src/extract-findings.ts` | await rerank in the atlassian branch, log fields |
| web | `src/lib/components/AtlassianFindingsCard.svelte` | relevance chip, hidden-count note |
| docs | `docs/configuration/` env reference, `.env.example` | `TYPESAFE_API_KEY`, `ATLASSIAN_RERANK_ENABLED` |

## Verification

```bash
bun run typecheck && bun run lint
cd packages/agent && bun run test src/atlassian-rerank src/correlation/extractors/atlassian src/extract-findings
cd packages/mcp-server-atlassian && bun run test
cd apps/web && bun run test src/lib/components/AtlassianFindingsCard
```

Live, before merge (features default ON must be verified live):

1. The worktree has no `.env`; the key lives in the main checkout. Run the isolated web replay on
   5174 per the `reference_isolated_web_replay_from_worktree` memory with
   `--env-file=<main checkout>/.env`.
2. Replay one incident with a known linked ticket. Expect in the dev log: `AtlassianFindingsCard`
   line with `rerank: "applied"`, a duration under 3 s, and the known ticket first on the card.
3. Set `ATLASSIAN_RERANK_ENABLED=false`, replay, expect the card identical to `main`.
4. Set a bad `TYPESAFE_API_KEY`, replay, expect `rerank: "failed"` and the deterministic card.
5. Kill the dev server by tracked PID; `lsof -nP -iTCP:5174 -sTCP:LISTEN` returns nothing.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Jev reads a ticket that argues for its own relevance (vendor-listed weakness: adversarial content) | Low, internal Jira | Rerank only orders and hides rows on a card; it grants nothing. Hidden count is shown. |
| Threshold hides a genuinely related ticket | Medium | Tuned on real envelopes in step 5; hidden count visible; kill-switch. |
| Added latency on every complex turn | Certain, about 0.7 to 1 s measured | Runs after the report is already streamed; 3 s hard deadline. |
| Rate limit (1,200 req/min) | Low, about 10 to 20 requests per turn | Failure falls back to deterministic. |
| `jev-latest` alias moves and shifts scores | n/a | Version pinned. |
| AgentCore or restricted-egress deployments cannot reach `api.typesafe.ai` | Medium | Self-skips on failure; document the egress requirement. |

## Out of scope

- Re-ranking inside the MCP tool so the sub-agent LLM and the report also benefit. Worth doing next
  if this proves out; needs the incident text passed into the tool.
- `getRunbookForAlert` / Confluence page ranking. Same pattern, but runbooks are not on this card.
- `getIncidentHistory` MTTR sampling (SIO-1336).
- Replacing the JQL retrieval. Rerank cannot recover a ticket the search never returned.
- Any other Jev seam from the feasibility assessment.
