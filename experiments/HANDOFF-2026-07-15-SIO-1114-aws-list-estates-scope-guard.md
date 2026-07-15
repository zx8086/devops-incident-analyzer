# HANDOFF: aws_list_estates trips the estate-scope guard -- estate drift reconciliation silently skipped

- **Date**: 2026-07-15
- **Ticket**: [SIO-1114](https://linear.app/siobytes/issue/SIO-1114/aws-list-estates-trips-the-estate-scope-guard-estate-drift)
- **Parent/related**: [SIO-854](https://linear.app/siobytes/issue/SIO-854) (estate drift reconciliation -- the broken feature), SIO-828 (estate-scope wrapper origin), SIO-1104 5a (added the second entry point)
- **Repo state**: `main` @ `418bbca`
- **Suggested branch**: `simonowusupvh/sio-1114-aws_list_estates-trips-the-estate-scope-guard-estate-drift`

## TL;DR

The recurring WARN `aws_list_estates call failed; skipping estate drift reconciliation {"error":"AWS tool \"aws_list_estates\" invoked outside withAwsEstate scope..."}` is a false alarm caused by an over-broad guard: the SIO-828 estate wrapper applies its "must be inside withAwsEstate" check to EVERY AWS tool, including the zero-arg, estate-independent `aws_list_estates`. The SIO-854 drift reconciliation legitimately calls that tool with no scope (it is what discovers the estates), the guard throws, the router swallows it, and the drift feature is silently disabled. Fix: exempt estate-independent tools from the guard; add the regression tests that both existing suites bypass today. Success = reconciliation runs clean (drift WARNs fire only on real drift), no scope-guard WARN on pipeline or cron paths.

## Context -- how this ticket came to be

The WARN appeared in the 2026-07-15 12:32 incident run (service `agent:awsEstateRouter`) and again at 16:11:48 during a kg-topology cron sweep. Investigation showed it fires on the first AWS dispatch of every process and on every cron sweep (memoized once per process per path). It is untracked -- no prior ticket or doc mentions the symptom. Consequence is real: estate enum drift (see memory: estates changed via env-only redeploy) again surfaces only as late per-query "Unknown estate" errors, which SIO-854 existed to prevent.

## Where the bodies are buried

**The over-broad guard** -- `packages/agent/src/aws-tool-estate-wrapper.ts:15-24`, applied to every tool by the map at `:11`:

```ts
async (args: unknown) => {
	const estate = currentAwsEstate();
	if (!estate) {
		// The fan-out wrapper in queryDataSource is the only legitimate
		// caller path; missing context is a programming error worth surfacing.
		throw new Error(
			`AWS tool "${original.name}" invoked outside withAwsEstate scope. ` +
				"This indicates a bug in the AWS sub-agent fan-out.",
		);
	}
	const withEstate = { ...(args as Record<string, unknown>), estate };
	return original.invoke(withEstate);
},
```

The SIO-828 comment at `packages/agent/src/mcp-bridge.ts:379-381` reasons only about the *schema strip* being idempotent for `aws_list_estates` -- the runtime guard was overlooked:

```ts
// SIO-828: hide the `estate` arg from the LLM and inject it from ALS at call time.
// The aws_list_estates introspection tool has no `estate` arg; the wrapper's
// schema-strip is idempotent for it (delete on missing key is a no-op).
```

**The legitimate unscoped caller** -- `fetchServerEstateIds`, `packages/agent/src/aws-estate-router.ts:96-121` (invoke at `:103`; the swallowing catch that produces the observed WARN at `:115-118`). Memoized once per process via `cachedServerEstateIds` (`:76`).

**Two entry points, one shared defect**:
- Pipeline: `awsEstateRouter` node (`aws-estate-router.ts:228`) -> `reconcileEstatesWithServer` (`:246`).
- Cron: `runTopologySweep` -> `collectAwsRunsOn` (`packages/agent/src/kg-topology.ts:308`) -> `availableAwsEstates()` (`:313`) -- note this runs BEFORE the correctly-scoped `withAwsEstate(estate, ...)` ECS calls at `:324`. The WARN carries the `agent:awsEstateRouter` service tag on both paths because `fetchServerEstateIds` uses the router module's logger (`aws-estate-router.ts:21`).

**Proof the tool is estate-independent** -- `packages/mcp-server-aws/src/tools/list-estates.ts:13`: `const schema = z.object({});` and the design spec (`docs/superpowers/specs/2026-05-27-aws-multi-estate-design.md:256-258`) calls it a zero-arg tool returning `{ estates: string[] }`. The spec also forbids a default estate (`:250`): "There is no default estate. The router always pins one." -- which rules out fixing this by wrapping the call in a fabricated scope.

**Why tests are green while prod warns**:
- `packages/agent/src/aws-estate-router.test.ts:40-51` stubs `getToolsForDataSource` with a bare, UNWRAPPED `aws_list_estates` -- guard never runs.
- `packages/agent/src/kg-topology.test.ts:13-17` same pattern (`toolRegistry` stubs).
- `packages/agent/src/aws-tool-estate-wrapper.test.ts:79-83` tests the guard only for `aws_ecs_list_services`, never for `aws_list_estates`.

## The fix (step-by-step)

1. **`packages/agent/src/aws-tool-estate-wrapper.ts`** -- exempt estate-independent tools:

```ts
// SIO-1114: introspection tools that operate ON the estate registry itself take
// no estate and must be callable outside withAwsEstate (SIO-854 reconciliation
// runs before any per-estate fan-out; the design forbids a default estate).
const ESTATE_INDEPENDENT_AWS_TOOLS = new Set(["aws_list_estates"]);
```

   In the wrapped closure (`:15-24`): if `ESTATE_INDEPENDENT_AWS_TOOLS.has(original.name)`, return `original.invoke(args)` directly (no guard, no estate injection). Keep the guard unchanged for every other tool -- it is load-bearing for the fan-out contract.

2. **`packages/agent/src/mcp-bridge.ts:379-384`** -- update the SIO-828 comment to mention the runtime exemption (reference SIO-1114).

3. **Tests**:
   - `aws-tool-estate-wrapper.test.ts`: `aws_list_estates` invoked OUTSIDE any scope does not throw and passes args through untouched; still injects `estate` for `aws_ecs_list_services` inside scope; still throws outside scope for estate-scoped tools (existing `:79-83` case stays).
   - `aws-estate-router.test.ts`: one regression case that builds the tool via the REAL `wrapAwsToolsWithEstate` (not a bare stub) and asserts `reconcileEstatesWithServer` succeeds with no scope active -- fails before the fix, passes after.

4. Grep for other estate-independent AWS tools before finishing (`rg "z.object\(\{\}\)" packages/mcp-server-aws/src/tools/`) and add any genuine ones to the set (currently only list-estates is known).

## Verification

```bash
cd <repo> && bun run typecheck && bun run lint
bun test packages/agent/src/aws-tool-estate-wrapper.test.ts packages/agent/src/aws-estate-router.test.ts packages/agent/src/kg-topology.test.ts
```

Manual: run the full stack, fire one AWS-scoped incident query, and grep web logs -- expect NO `aws_list_estates call failed` WARN and (if env matches server) no drift WARN; with a deliberately wrong `AWS_ESTATES` entry, expect the SIO-854 drift WARN naming the drifted estate (the feature working again). Also let one kg-topology cron sweep run (`KG_TOPOLOGY_CRON_ENABLED=true`) and confirm the same on the cron path.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/aws-tool-estate-wrapper.ts` | ESTATE_INDEPENDENT_AWS_TOOLS set + guard bypass |
| `packages/agent/src/mcp-bridge.ts` | comment update at :379-384 |
| `packages/agent/src/aws-tool-estate-wrapper.test.ts` | exemption + unchanged-guard cases |
| `packages/agent/src/aws-estate-router.test.ts` | real-wrapper regression test |

## Workflow

Branch off `main`; SIO-1114 Todo -> In Progress -> In Review (ready PR) -> Done only with user approval. Commit format `SIO-1114: message` via HEREDOC.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Exemption set drifts as new introspection tools appear | Medium | Named set + comment; grep step 4 |
| Someone "fixes" this by pinning a default estate instead | -- | Design-forbidden (spec :250); documented here and in the ticket |
| Real fan-out bugs masked for exempted tools | Low | Only zero-arg registry tools exempted; guard untouched otherwise |

## Out of scope

- kg-topology collector robustness (SIO-1115).
- Estate enum drift redeploy mechanics (`reference_aws_estate_enum_drift`).
- The misleading guard message text for genuinely-unscoped estate-scoped calls (fine once the false positive is gone).

## Related code references

- Correctly-scoped fan-out (the guard's real purpose): `packages/agent/src/sub-agent.ts:944-952`.
- Correctly-scoped cron ECS calls: `packages/agent/src/kg-topology.ts:324`.
- ALS mechanism: `packages/agent/src/mcp-bridge.ts:32-40`.
- Origin commits: SIO-828 `36447eb` (guard), SIO-854 `c1cb268` (reconciliation), SIO-1104 `300365c` (cron entry point).

## Memory references

- `reference_aws_estate_enum_drift` (why reconciliation matters)
- `reference_supervisor_send_shape` (fan-out context)
- `project_aws_datasource_design`, `reference_aws_iam_gotchas` (background)
