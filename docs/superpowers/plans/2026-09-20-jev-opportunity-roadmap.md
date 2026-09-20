# Roadmap: where Jev (TypeSafe System One) fits in this system

Date: 2026-09-20. This is the index of every opportunity found in the feasibility sweep, corrected
against the live TypeSafe docs. It is not an implementation plan. Each item gets its own plan file
and its own Linear issue when it is picked up; item 1 already has one.

Epic: https://linear.app/siobytes/issue/SIO-1836. Sub-issues follow the item numbers below:
item 1 = SIO-1837, 2 = SIO-1838, 3 = SIO-1839, 4 = SIO-1840, 5 = SIO-1841, 6 = SIO-1842,
7 = SIO-1843, 8 = SIO-1844, 9 = SIO-1845, 10 = SIO-1846, 11 = SIO-1847, 12 = SIO-1848,
13 = SIO-1849, 14 = SIO-1850, 15 = SIO-1851, 16 = SIO-1852, 17 = SIO-1853.

Scope of the sweep: all 28 `createLlm` sites in `packages/agent`, the guardrail and retrieval
layers, the sub-agent tool-calling path, the seven MCP servers, `packages/pi-coms` including the
monitor, and the pi-fleet personas.

## Ground rules that apply to every item

- Jev classifies; it does not generate, count, do arithmetic, or compare dates. Keep those in code.
- Pin `jev-1.13.0`. Thresholds are tuned against a version and the `jev-latest` alias moves.
- Limits: 64k tokens per request, 32k for state plus the longest question, 255 options per Choice,
  10 levels per Score, 1,200 requests per minute, $0.042 per million input tokens, output free.
- Every integration follows the `gaps-judge.ts` safety shape: kill-switch defaulting ON, self-skip
  without `TYPESAFE_API_KEY`, short deadline, and any failure returns today's deterministic result.
- Adversarial text in the state can move Jev's answer (vendor-documented). Jev is a signal, never a
  security boundary.
- All items share one client: `packages/agent/src/typesafe-client.ts`, introduced by item 1. pi-coms
  cannot import from `packages/agent` and deliberately has no Zod (SIO-1632), so item 2 needs its
  own small fetch helper.
- Data leaves the account on every call. Items are marked by how sensitive the payload is.

## Measurement (SIO-1858, do it alongside item 1)

Every item below promises measured latency, tokens, cost and agreement. Those numbers need somewhere
to live, and the existing counters cannot hold them.

`mcp_tool_call_counts` (`packages/shared/src/tool-call-metrics.ts`, SIO-1400 and SIO-1402) is an
upsert counter: one row per `(server, tool)` with lifetime `calls` / `failures` / three failure-class
columns and first/last timestamps. Read live on 2026-09-20: 204 rows, 19,233 calls, 543 failures,
2026-08-06 to 2026-09-20, nine servers. It cannot serve this epic because it has no per-event rows
(so no before/after in either direction), it counts MCP tool calls only (Jev is not one; the re-rank
runs inside `extractFindings`), and it measures success rather than quality. The clearest case:
`findLinkedIncidents` reads 98 calls and 0 failures. The tool never errors, it returns the wrong
tickets, which is exactly what item 1 fixes and what this metric is blind to.

**Do not wipe it.** Clearing a nine-month multi-server baseline buys nothing, since lifetime counters
cannot be sliced by date either way. A verified pre-Jev snapshot (`.backup`, `integrity_check` ok,
totals identical to live) is at `data/mcp-tool-metrics-pre-jev-2026-09-20.sqlite`; the Atlassian
baseline inside it is `findLinkedIncidents` 98/0, `getRunbookForAlert` 83/0, `getIncidentHistory` 92/0.

SIO-1858 adds a separate per-decision table: `at`, `seam`, `request_id`, `model`, `latency_ms`,
`input_tokens`, `outcome` (applied / skipped / failed), `items_in`, `items_dropped`, score range, and
deterministic-versus-Jev rank. Same load-bearing rule as the existing module: opt-in by env var,
soft-fail everywhere, skip under `NODE_ENV=test`, never break a request.

## Tier 1

| # | Opportunity | Today | Jev pattern (cookbook) | Main files | Documented pain | Ground truth available | Payload sensitivity | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Re-rank Atlassian linked incidents for the findings card | Additive keyword score in the tool, `isWeakHit` drop in the agent | One Score per (incident, ticket) pair (`rerank_typesafe`, `entity_alignment`) | `correlation/extractors/atlassian.ts`, `extract-findings.ts`, `find-linked-incidents.ts`, `AtlassianFindingsCard.svelte` | SIO-1802 (15 of 15 unrelated), SIO-1244 (10 of 10 dropped) | Known incidents named in those tickets; live capture in the plan | High: ticket text | Planned: `2026-09-20-atlassian-linked-incident-rerank.md`. Probe done. |
| 2 | Gate which monitor findings get a full agent investigation | One line: `severity !== "info" && family !== "spoke-health"` (`coms-net-monitor.ts:270`); only counting budgets after that | Nouls per finding (routine deployment event? duplicate of a diagnosed finding?), optionally as features into a small classical model (`autoresearch_feature_discovery`) | `packages/pi-coms/scripts/coms-net-monitor.ts`, `scripts/monitor/budget.ts`, `state.ts` | SIO-1673 (72 findings in a day on one log group, agent at 98% context), SIO-1752 (about 14 a day fleet-wide), SIO-1739 | Journal rows: investigation outcome and confidence, plus operator-written suppressions with reasons (a human-labelled "not actionable" set) | Low: AWS metadata | Not started. Must run in shadow first: SIO-1748 to 1752 held real incidents out of the inbox. "Already recovered?" is a time comparison and stays in code. |
| 3 | Tool and action selection for sub-agents | YAML `action_keywords` regex, a six-regex kafka-only patch for its misses (SIO-742), a hardcoded drop-table (`narrowOnHighPrecisionIntent`) | One Choice ranking all actions plus a "needs any?" Noul, multi-label via one Noul per action (`skill_suggestion`: 182 skills in one request, wrong loads 16.8% to 7.3%) | `gitagent-bridge/src/tool-mapping.ts`, `agent/src/sub-agent.ts:1447-1618`, `agents/incident-analyzer/tools/*.yaml` | SIO-742, SIO-1398 (dual-intent query dropped `describe_topic`, scored 0.5 twice) | `mcp-tool-eval` dataset (25 examples) with `expectedToolsFired` | Low: the user query only | Not started |
| 4 | Replace the `entityExtractor` LLM call | Standard-tier LLM on every complex turn, no fast path, no cache | Datasources and actions as Nouls, severity as Choice, time window as date components with arithmetic in code, service names picked from known candidates (`function_calling`, `date_extraction_cookbook`, `pre_parsed_value_extraction_cookbook`); dispatch-all fallback on low confidence (`classification_using_confidence`) | `agent/src/entity-extractor.ts`, `normalizer.ts` | SIO-1233 (silent empty extraction) | Synthetic `devops-incident-eval` with `datasourcesCovered` and `datasourcesPrecision` | Low to medium: user query, attachments | Not started. Try `AGENT_LLM_TIER_ENTITY_EXTRACTOR=light` first; it is a zero-code comparison point. Overlaps item 3 (the same call picks actions). |
| 5 | Relevance before truncation, and re-ranking the evidence index | Tool output cut positionally (`HITS_KEEP = 3`, rows 20); evidence recovery is plain BM25 | Choice over line or hit ids, up to 255 per request (`semantic_find`); relevance, usable and contradiction Nouls per passage (`classifying_rag_passages`); rerank BM25 hits (`rerank_typesafe`) | `agent/src/sub-agent-truncate-tool-output.ts`, `evidence-index.ts` | The elastic false negative behind SIO-1085 (agent fetched 91 hits, reported "absent") | None yet; needs recorded tool outputs | High: raw logs and hits | Not started. Filter in code first; a full 128 KB tool result sits at the 32k state limit. |
| 6 | Semantic second check for the confidence-cap guards | Six regex guards over LLM-written English; only two have an LLM veto (`gaps-judge.ts`, `absence-judge.ts`, both Haiku) | Noul per flagged bullet; claim-versus-evidence Choice (`citation_check`). First swap the two Haiku judges, then add the same veto to `PERMISSION_DENIAL_RE`, `IAM_PRESCRIPTION_RE`, `UNGROUNDED_MECHANISM_RE`, `NO_DATA_OR_SCHEMA_CLAIM_RE` | `agent/src/aggregator.ts:585-1442`, `gaps-judge.ts`, `absence-judge.ts`, `validator.ts` | SIO-1106, SIO-1149 (0.84 capped to 0.59), SIO-1031, SIO-1054, SIO-1120, SIO-1242 | Existing judge test fixtures; `aggregator.test.ts` | Medium: report bullets | Not started |
| 7 | Service identity across datasources | `matchesFocus`: suffix strip, substring, token overlap, accreting denylists | Three-level Score per candidate pair: same / different / ask (`entity_alignment`), run when a KG binding is written and cached, not per finding | `shared/src/focus-match.ts`, `agent/src/resolve-identifiers.ts`, KG bindings | SIO-1797 (25 of 26 alarms mis-scoped), SIO-1284 (GitLab card empty on every focused run), SIO-1103, SIO-1030, SIO-1210 | The cases in those tickets; KG bindings | Low: resource names | Not started. Highest blast radius of any single function in the sweep. |

## Tier 2

| # | Opportunity | Note | Main files |
|---|---|---|---|
| 8 | Confluence runbook re-ranking | Same pattern as item 1 over `scorePage`. Not on the findings card today, so it changes what the sub-agent sees. | `mcp-server-atlassian/src/tools/custom/get-runbook-for-alert.ts` |
| 9 | Re-rank inside `findLinkedIncidents` so the report benefits too | Follow-up to item 1; needs the incident text passed into the tool. | `find-linked-incidents.ts` |
| 10 | Group log signatures that are the same failure; rank by severity, not only count | Classify each new signature once, never each line: a storm ran 4,832 matches per 10 s against a 1,200 requests per minute limit. | `pi-coms/scripts/monitor/checks/logs.ts` |
| 11 | ECS and RDS event classification | Replaces an ordered regex table that has three documented misfires. A labelled corpus already exists. | `pi-coms/scripts/monitor/checks/tasks.ts`, `db-events.ts`, `tests/aws-samples.ts` |
| 12 | Verify-card follow-up gate | `needsInvestigation` fires on any non-confirmed claim; SIO-1696 documents wasted investigations. One Noul: "is this claim checkable from this account?" | `agent/src/action-tools/pi-verifier.ts:328` |
| 13 | Inbox relevance to the current incident | Today: time window plus account match only, no service-level test. | `agent/src/fleet-inbox.ts:154-169` |
| 14 | Prompt-injection signal on untrusted text | No detection exists today, only fencing; Jira, Confluence and GitLab tool text is not even fenced. Demoted because the vendor lists adversarial content as a weakness. Flag and caveat, never block. | `agent/src/pi-fleet/tools.ts:57`, `sub-agent-truncate-tool-output.ts`, `pi-coms/scripts/monitor/state.ts:131` |
| 15 | Decompose the eval judges | `responseQualityJudge` is one broad 1 to 10 grade that needed a code cap. Narrow Nouls reduce variance across repetitions. Egress precedent exists (OpenAI). | `agent/src/eval/evaluators.ts`, `citation-grounding-evaluator.ts` |
| 16 | Second chance for the learning-lane quote verifier | Exact-substring match rejects honest paraphrase by design; an entailment check after a failed match (`citation_check`). | `agent/src/learn/distill.ts:126-185` |
| 17 | Smaller routers | `runbookSelector` (Score per catalog entry), `awsEstateRouter` (Choice, low confidence becomes "ask"), `iacClassifier` (8-way Choice), vacuous-answer detection in truncation synthesis, Konnect `MigrationAnalyzer`. | `runbook-selector.ts`, `aws-estate-router.ts`, `iac/nodes.ts:1800`, `sub-agent-truncation-synthesis.ts`, `mcp-server-konnect/src/operations/migration-analyzer.ts` |

## Not a fit (decided, with reasons)

| Candidate | Why not |
|---|---|
| SQL and command safety (Elastic `securityEnhancer.ts`, Couchbase read-only gate, spoke AWS CLI read-only judgment) | Needs a parser or structural rules, not a probability. IAM is the real boundary for spokes. |
| Tool error classification | The SIO-1087 structured error envelope is already the right fix; finish the migration. |
| PII detection | Sending text to a third party to learn whether it contains personal data defeats the purpose. |
| Simple/complex classifier, hub routing, KG typing, GitLab Orbit queries, Kafka DLQ name patterns, the enums-and-ids-only memory rule | Deterministic and good enough; no documented pain. |
| Sub-agents, aggregator, responder, mitigation bullets, follow-ups, distiller | Generative work. |

## Defects found during the sweep (not Jev work)

| Defect | State |
|---|---|
| Couchbase read-only gate bypass: `DELETE\nFROM b` is not detected as a write because the tokenizer splits on the space character only (`mcp-server-couchbase/src/lib/sqlppParser.ts`) | Confirmed by running it. Handed to a separate session. |
| `fleet-inbox.ts:105` captures the finding family with `([a-z]+)`, so `db-events` and `spoke-health` lines are dropped | Confirmed by reading the code. Handed to a separate session, which has ended. |
| `action-tools/executor.ts:33,54` coerces LLM-proposed severity with `String(... ?? "info")` and no enum check | Reported by the sweep, not verified by me. No ticket. |

## Suggested order

1. Item 1. It introduces the shared client, the safety shape and the live-verification routine that every later item reuses.
2. Item 2 in shadow mode. Least sensitive payload, best ground truth, and it is where money is being spent per finding.
3. Items 3 and 4 together, since one call makes both decisions today.
4. Item 6, starting with the two judges that already have fixtures.
5. Item 7, then item 5 once the egress question for raw logs is settled.
