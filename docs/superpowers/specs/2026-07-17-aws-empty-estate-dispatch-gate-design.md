# AWS empty-estate dispatch gate

## Problem

When the AWS MCP server is connected (tools present) but `awsTargetEstates` is empty, the supervisor still dispatches the AWS sub-agent. `queryDataSource` then takes the non-fan-out fallback path (`packages/agent/src/sub-agent.ts:956`) which never enters `withAwsEstate`, so every AWS tool throws the scope guard (`packages/agent/src/aws-tool-estate-wrapper.ts:28`): `AWS tool "<name>" invoked outside withAwsEstate scope`.

Confirmed against the failing styles-v3 throughput-spike run (LangSmith trace `019f7114`): `awsEstateRouter` returned `awsTargetEstates: []` (in ~3 ms, 0 child runs -- it bailed at the pre-reconcile early exit `aws-estate-router.ts:240`, i.e. `AWS_ESTATES` unset). AWS was still in scope (`targetDataSources` included `aws`) and AWS tools were connected, so both the initial (8 tools) and alignment-retry (5 tools) AWS dispatches ran the fallback path and failed 8/8 + 5/5 = 13/13. Impact: AWS datasource lost entirely, the report sourced AWS "evidence" from prior tickets via Atlassian, and the tool-error rate capped confidence at 0.59.

This is NOT an AsyncLocalStorage context-loss bug. Three isolation reproductions confirmed the ALS context survives `withAwsEstate -> createReactAgent.stream({streamMode:"values"}) -> wrapped tool` in plain Bun, under the real Vite SSR module runner, and under concurrent multi-estate `Promise.all` fan-out with the instrumentation Proxy. The trigger is empty estates reaching a dispatch path that requires a scope.

## Goal

When AWS is dispatched with no resolved estates, skip it cleanly with an explanatory "unavailable datasource" reason -- no sub-agent invocation, no tool errors, no confidence cap -- so the report states "AWS: no estates resolved" in its Gaps section instead of surfacing 13 scope-guard errors.

## Approach

Gate at the supervisor (`packages/agent/src/supervisor.ts`, `supervise()`), reusing the existing skip channel.

Rationale for supervisor over `queryDataSource`:
- The supervisor already skips datasources it cannot meaningfully query (`skipped`/`skipReasons` -> `skippedDataSources`, `supervisor.ts:68-93`), currently for "MCP server not connected" and "unknown datasource". Empty-estate AWS is the same class and belongs in the same list.
- `skippedDataSources` feeds the aggregator's existing "UNAVAILABLE DATASOURCES -> Gaps section" prompt (`aggregator.ts:102-106`), giving a clean report signal for free.
- No sub-agent runs, so no tool errors and no tool-error-driven confidence cap.

The `queryDataSource` fallback path (`sub-agent.ts:956`) is left unchanged as defense-in-depth: if AWS ever reaches it with empty estates, the scope guard still fires. The supervisor gate makes that unreachable in the normal flow.

## The change

In `supervise()` (`packages/agent/src/supervisor.ts`), after `validSources`/`skipped` are computed (currently around `:71-79`), reclassify AWS-with-empty-estates:

- Condition: `id === "aws" && (state.awsTargetEstates?.length ?? 0) === 0`.
- Effect: move `aws` out of `validSources` and into `skipped` with reason `aws: no estates resolved (AWS_ESTATES unset or no configured estate known to the server)`.
- Only `aws` is affected; the estate check is never applied to any other datasource.

Implementation note: fold the estate check into the existing `skipped`/`validSources` partition rather than adding a second pass, so there is one source of truth for what gets dispatched and one `skipReasons` builder. Extend the `skipReasons` map (`:75-79`) with the AWS-estate reason.

## Testing (TDD, write tests first)

`packages/agent/src/supervisor-router.test.ts` (existing suite for `supervise()`):

1. AWS in scope + `awsTargetEstates: []` + AWS tools present -> no `Send` with `currentDataSource: "aws"` is emitted, AND the returned state's `skippedDataSources` contains a reason matching `/aws: no estates resolved/`.
2. Regression: AWS in scope + `awsTargetEstates: ["eu-oit-prd"]` + AWS tools present -> a `Send` with `currentDataSource: "aws"` IS emitted and AWS is not in `skippedDataSources`.
3. Non-AWS unaffected: a non-AWS datasource with empty estates (estates are AWS-only anyway) still dispatches normally -- covered implicitly by existing tests; add an explicit assertion only if the existing suite doesn't already cover a multi-source dispatch.

Follow the existing test's mocking pattern for `getToolsForDataSource` (it stubs tool counts per datasource). Match casing/shape of the existing `skipReasons` strings.

## Verification

- `bun run typecheck && bun run lint`
- `bun run --filter '@devops-agent/agent' test` (or the targeted `bun test packages/agent/src/supervisor-router.test.ts`)
- Manual: not required for this change (pure routing logic, fully unit-testable). Optionally, a worktree replay with `AWS_ESTATES` deliberately unset should now show AWS in the report's Gaps section rather than 13 scope-guard tool errors.

## Out of scope

- The worktree `.env` resolution gap (`apps/web/vite.config.ts:9` `loadEnv(__dirname, "../..")` resolves to the worktree root, which has no `.env`). That is an environment/tooling issue, tracked separately if desired.
- Changing the fail-hard AWS estate wrapper (`aws-tool-estate-wrapper.ts`) -- the fail-hard guard is correct by design (no default estate per SIO-828/854).
- Aggregator prose changes.
- `awsEstateRouter`'s own bail-out logic -- returning `[]` when no estates are configured is correct; the defect is only that the empty result is not honored at dispatch.
