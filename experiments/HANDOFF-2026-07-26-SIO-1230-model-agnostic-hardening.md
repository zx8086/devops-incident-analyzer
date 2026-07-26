# HANDOFF: SIO-1230 model-agnostic hardening (Slices 3-5 outstanding)

- **Date**: 2026-07-26
- **Parent ticket**: [SIO-1230](https://linear.app/siobytes/issue/SIO-1230) — Make the agent model-agnostic: fix the SIO-1213/1228/1229 fallout
- **Children**: [SIO-1231](https://linear.app/siobytes/issue/SIO-1231) DONE · [SIO-1232](https://linear.app/siobytes/issue/SIO-1232) DONE · [SIO-1233](https://linear.app/siobytes/issue/SIO-1233) TODO · [SIO-1234](https://linear.app/siobytes/issue/SIO-1234) TODO · [SIO-1235](https://linear.app/siobytes/issue/SIO-1235) TODO
- **Repo state**: `main` @ `b7f0d5f4`. **Both PRs are MERGED** (squash), CodeRabbit clear, branches deleted:
  - PR #481 → `dc39b3bf` SIO-1231
  - PR #482 → `b7f0d5f4` SIO-1232 (two CodeRabbit findings triaged and fixed before merge — see below)
- **Linear**: SIO-1231 and SIO-1232 are **In Review**, not Done — moving them to Done needs the user's explicit approval, and the end-to-end DEVOPS-1405 replay has still not been run.
- **Suggested branches**: `claude/sio-1233-envelope-drift`, `claude/sio-1234-prompt-tool-binding`, `claude/sio-1235-subagent-manifest-models`
- **Full plan**: `~/.claude/plans/look-at-the-recent-peppy-sunset.md` (approved verbatim by the user)

## TL;DR

**What's done**: PRs #481 (garbled report) and #482 (runaway loop + timeout retry) are **merged into `main`**. Together they fix the two most visible symptoms.

**What's next**: Slices 3-5 = SIO-1233 (extraction envelope drift — *this is the one that causes the all-datasource fan-out*), SIO-1234 (prompt/tool-binding mismatch), SIO-1235 (honour sub-agent manifest models). Each Linear issue already contains the full design with `file:line` references; read the issue, not just this doc.

**Gotchas hit so far**: (a) `node_modules` is absent in a fresh worktree — `bun install` first or every test errors with "Cannot find package 'zod'"; (b) `git checkout main` fails in the worktree ("already used by worktree"), so cut new branches with `git checkout -b X && git reset --hard origin/main`; (c) four existing tests in Slice 2 were *pinning the bug* and had to be rewritten — expect the same in Slices 4 and 5 (they are named in the issues).

## Context — how this came to be

On 2026-07-26 the agent produced a garbled report, queried all 7 datasources, made 58 distinct tools / 97 gitlab calls, ran 876697ms, and capped confidence at 0.59. The DEVOPS-1405 report generated **2026-07-25 20:01Z** is the target quality bar.

Timeline is decisive — the failing run was **three minutes after the last commit**, 21 hours and four commits after the good one:

| Commit | Landed (local) | Effect |
|---|---|---|
| `ae390630` SIO-1212 | 07-25 21:33 | last commit before the window |
| `cd7c628a` SIO-1213 | 07-26 00:41 | root manifest `claude-sonnet-4-6` → `claude-sonnet-5` |
| `11378521` SIO-1214 | 07-26 02:05 | omit `temperature` (Sonnet 5 rejects it) |
| `22683c77` SIO-1217 | 07-26 13:14 | `extractTextFromContent` everywhere → introduced the `"\n"` garbling |
| `4cfade87` SIO-1229 | 07-26 19:26 | aws/atlassian sub-agents run their OWN prompt (aws RULES.md = 32.7KB) |
| `e3b2b99d` SIO-1228 | 07-26 21:00 | bind skill-prose tool names |
| *(failing run)* | 07-26 21:03 | |

**The user's decision, verbatim: fix forward, do NOT roll back the model — "changing models is something that will happen".** Every fix must therefore be model-agnostic. Do not propose reverting SIO-1213.

## Done — do not redo

### SIO-1231 / PR #481 — `message-utils.ts:41` `join("\n")` → `join("")`

Two independent justifications, both verified:
1. The graph runs under `streamEvents`, so `llm.invoke()` at the `aggregate`/`responder` `OUTPUT_NODES` returns LangChain's *concatenation of AIMessageChunks* — one text block **per delta**. `"\n"` put a newline at every delta boundary; `markdown.ts:75` `breaks: true` rendered each as `<br>`.
2. `buildCachedSystemMessage` (`prompt-cache.ts:32-34`) emits `[{text: stable}, CACHE_POINT, {text: volatile}]` while its cache-**disabled** path is `stable + volatile` — no separator. The `"\n"` join silently broke its own "byte-identical to the pre-cache prompt" guarantee.

Proven with a runtime probe through the production markdown renderer: old join → 6 `<br>` + the exact chopped heading; new join → a single clean `<h1>`, 0 `<br>`.

Also fixed two hand-rolled test mocks that duplicate the helper and carry a "mirror production EXACTLY" contract (`apps/web/src/lib/server/agent.test.ts`, `apps/web/src/routes/api/agent/stream/server.test.ts`) — both still joined with `"\n"`.

### SIO-1232 / PR #482 — loop bounds + timeout retry

Five changes in `sub-agent.ts`, `sub-agent-loop-guard.ts`, `alignment.ts`. See PR #482 / the Linear issue for the full rationale. Key non-obvious points a reviewer will ask about:
- `not-found` is placed **first** in `ERROR_PATTERNS` (else `/timeout/i` claims it) and written **lowercase** (`classifyToolError` matches `message.toLowerCase()`).
- The abort marker keeps `category: "transient"` while setting `retryable: false` — deliberate, and pinned by a test.
- `aws_logs_get_query_results` **must** stay duplicate-exempt in the loop guard; guarding it breaks every CloudWatch Insights investigation.
- `isObservedTool` now returns `true` unconditionally.

**Two CodeRabbit findings were triaged and fixed before merge** (`b829ddaa`), both verified with a live repro against the production functions first — worth knowing because both are easy to reintroduce:
1. `GENERIC_GUARD_EXEMPT_TOOLS` (was `DUPLICATE_EXEMPT_TOOLS`) originally exempted the polling tools from the **duplicate check only**, so the run-wide backstop could still block them once *other* tools exhausted it — i.e. the runaway this guard exists to bound would have silently killed an in-flight CloudWatch poll. `aws_logs_describe_log_groups` was added for the same reason (SIO-1141 re-anchor recovery). Deciding argument: neither tool can *contribute* to the counters, so being blocked *by* them was incoherent. The exemption must stay the **first** check in that branch.
2. The abort regex's bare `abort(?:ed|error)` matched inside `ECONNABORTED`, so a transient connection abort would be misread as a self-inflicted timeout and lose its legitimate retry. Now word-bounded.

## Outstanding work

### SIO-1233 — extraction envelope drift (DO THIS FIRST)

**Highest value of the three**: it is the direct cause of the all-datasource fan-out, and it protects the SIO-1235 rollout.

Evidence from the run:
```
warn: Entity extraction failed, falling back to all datasources
  {"reason":"schema-mismatch","detail":"dataSources: Invalid input: expected array, received undefined"}
info: Normalization complete {"serviceCount":0,"focusServices":[]}
```

`ExtractionSchema` (`entity-extractor.ts:18-38`) has `dataSources` as its ONLY required field → loud failure. `NormalizationSchema` (`normalizer.ts:22-51`) is **all `.nullish()`** → the identical drift validates cleanly and degrades **silently**.

Severity is higher than it looks: an empty focus also makes `resolveIdentifiers` a complete no-op (`resolve-identifiers.ts:243`) and forces every findings card to `filterMode: "show-all"` (the 48 DLQ topics / 35 AWS alarms in the report).

Six sub-parts, all specified with code in the Linear issue. Two things to preserve:
- Do **not** make normalizer fields required — `affectedServices` is legitimately empty for "is anything degraded". An invented focus produces `droppedAll` empty cards, which is worse than show-all.
- Do **not** do a blanket snake_case→camelCase preprocess — `ExtractionSchema.toolActions` is a `z.record` keyed by model-authored datasource ids and would be corrupted.

**Determinism, already investigated — do not re-derive**: there is no lever. `ROLE_OVERRIDES.entityExtractor.temperature = 0` is discarded at `llm.ts:269` because Sonnet 5 has `acceptsTemperature: false`. Bedrock Converse has **no `seed`**. `topP` exists on `ChatBedrockConverse` but is **unprobed** for this model — shipping it on a hunch repeats SIO-1213/1214. The corrective retry is the mitigation.

### SIO-1234 — prompt and tool binding cannot disagree

Measured (scan every SOUL/RULES/SKILL md with the `TOOL_TOKEN` regex from `skill-tools.ts:19`, intersect with the action map):

| sub-agent | SOUL+RULES | SKILL.md | union | fits under 25? |
|---|---|---|---|---|
| **aws-agent** | **62** | 0 | **62** | **no** |
| gitlab-agent | 0 | 18 | 18 | tight |
| kafka-agent | 17 | 0 | 17 | yes |
| capella-agent | 14 | 8 | 16 | yes |

Critical constraint: do **not** naively widen `extractSkillToolNames` (the BIND path) to RULES.md — aws would prepend 62 tools, the `.slice(0, 25)` would leave **0** action-selected, and which 25 survive would be decided by MCP enumeration order. Add a separate `extractPromptToolNames` for the **canary** instead, and ratchet the coverage test rather than hard-failing (a wall blocks every unrelated PR behind a 32KB prose rewrite).

Do **not** add kafka to `RESOLUTION_TOOLS_BY_DATASOURCE` — `sub-agent.ts:785-790` documents that force-binding `kafka_list_topics` reintroduces the SIO-785 DLQ regression.

Note `Tool "X" not found` is thrown by LangGraph's `ToolNode` and **never reaches `instrumentTools`**, so no tool-level guard can see it — the prompt is the only in-loop lever.

### SIO-1235 — honour sub-agent manifest models

`llm.ts:330` resolves every non-lightweight role, **including `subAgent`**, from the ROOT manifest. All 7 sub-agent manifests declare `claude-haiku-4-5` and **none of it has ever taken effect** — dead config since the original scaffold (`125b3f9e`). That is why one root yaml line moved all seven specialists.

Effects to state in the PR: all 7 move Sonnet 5 → Haiku 4.5; `maxTokens` stays **8192** (`ROLE_OVERRIDES.subAgent` wins over the manifest's 2048); `temperature: 0.1` starts actually applying. Per-agent tuning becomes a one-line yaml edit.

**The one thing no offline test can answer**: whether Haiku 4.5 is competent on the 7 ReAct loops. Needs a LangSmith replay eval per specialist. Ship with the `SUB_AGENT_MANIFEST_MODEL_ENABLED` kill switch (defaults ON, read at call time).

## Verification

```bash
cd <worktree> && bun install          # REQUIRED in a fresh worktree
bun run typecheck && bun run lint && bun run test
```

Baseline on this branch set: typecheck 0 errors (18 packages), lint exit 0 (13 pre-existing warnings), `@devops-agent/agent` 2906 pass / 0 fail, `@devops-agent/web` 266 pass / 0 fail.

**Acceptance is the end-to-end replay** — offline tests cannot answer it. Copy `.env` from the main checkout, start the web server, re-run the exact DEVOPS-1405 prompt via the stream endpoint. Kill every service started and prove ports free with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.

Pass criteria vs the failing run:
- Report heading renders on one line (no mid-word breaks). ← already fixed by #481
- `Entity extraction failed` absent; `dataSources` scoped, not all 7. ← SIO-1233
- `Normalization complete` shows non-empty `focusServices`. ← SIO-1233
- No `Tool "..." not found` for AWS. ← SIO-1234
- No sub-agent reaches 360000ms; no alignment retry for a timeout. ← already fixed by #482
- Total `responseTime` well under 876697ms.
- Findings cards scoped (not `show-all` with 48 DLQ topics). ← SIO-1233

## Files to modify (remaining)

| File | Change | Ticket |
|---|---|---|
| `packages/agent/src/llm-json.ts` | single-key unwrap, `observedKeys`, `withKeyAliases` | 1233 |
| `packages/agent/src/entity-extractor.ts` | aliases, corrective retry, empty-text guard | 1233 |
| `packages/agent/src/normalizer.ts` | aliases, retry, silent-failure detection + gated recovery | 1233 |
| `packages/agent/src/llm-json-retry.ts` | **new** — retry helper (keep `llm-json.ts` pure) | 1233 |
| `packages/agent/src/message-utils.ts` | `contentBlockTypes()` | 1233 |
| `packages/agent/src/sub-agent.ts` | `composeBoundTools`, aws resolution tools, bound-tools prompt block | 1234 |
| `packages/gitagent-bridge/src/skill-tools.ts` | `extractPromptToolNames` | 1234 |
| `packages/gitagent-bridge/src/skill-tool-coverage.test.ts` | ratchet | 1234 |
| `packages/agent/src/llm.ts` | `subAgentName` param, `resolveRoleModelConfig`, kill switch | 1235 |
| `packages/gitagent-bridge/src/model-registry.test.ts` | add the 7 sub-agent manifests to `inUse` | 1235 |

## Workflow

Branch off `main` per slice (`git checkout -b X && git reset --hard origin/main` — plain `checkout main` fails in the worktree). PRs **ready for review, never draft**. Do not merge while a CodeRabbit report is pending. Linear: move to In Progress on start, In Review on PR, **Done only with explicit user approval**.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Haiku 4.5 underperforms on the 7 ReAct loops (SIO-1235) | Medium | LangSmith replay per specialist; `SUB_AGENT_MANIFEST_MODEL_ENABLED=false`; per-agent yaml override |
| gitlab `recursionLimit: 24` truncates genuine depth (shipped in #482) | Medium | Partial findings, not failure; `SUBAGENT_RECURSION_LIMIT_GITLAB` rollback lever |
| Loop guard false positives on tools whose real answer is `[]` (shipped in #482) | Low | 3 identical empties still means stop; watch `subagent.loop_guard_stop` |
| Envelope unwrap validates a wrong sub-object (SIO-1233) | Low | Depth 1, single-key only, failure-path only |
| Normalizer service-recovery seeds a wrong focus (SIO-1233) | Low | Cap 3, stop-list, `NORMALIZER_SERVICE_RECOVERY_ENABLED` |

## Out of scope

Reverting SIO-1213 or any model rollback · trimming `aws-agent/RULES.md` to ≤17 named tools (follow-up; `KNOWN_OVERSUBSCRIBED` covers it) · giving the `subAgent` role a fallback model (pre-existing gap — `TOOL_BINDING_ROLES` skips `withFallbacks`) · probing `topP` / adding `acceptsTopP` · the light tier's coupling to the elastic-agent manifest · the KG WAL corruption seen throughout the run (`Checksum verification failed`) — unrelated, pre-existing, soft-failing.

## Memory references

`reference_sio1213_model_facts_measured` · `reference_sio1228_skill_tool_binding` · `reference_sio1229_undeclared_subagents_fixed` · `reference_probe_production_path_not_raw_sdk` · `reference_fresh_worktree_no_workspace_symlinks` · `reference_worktree_bash_cd_lands_in_main` · `reference_main_preexisting_test_lint_failures` · `reference_subagent_missing_tool_is_action_group_gap` · `reference_confidence_two_class_policy_sio1194_1195` · `reference_worktree_web_server_replay_env`
