# HANDOFF 2026-09-07 — frontend: agent selector shape and the IaC triage panel

**Date**: 2026-09-07
**Repo state**: `main` @ `d85a7584`, clean tree, nothing in flight
**Suggested branch**: `claude/frontend-agent-selector-and-triage`
**Linear**: none yet — create one before implementing (project rule); relates to
SIO-1655 (three-agent registry) and SIO-1572 (graph triage panel)

## TL;DR

Two frontend asks, both raised from looking at the running app at
`http://localhost:5173`:

1. **The header icon should cycle only the two "modes" — Incident Analyzer and
   Elastic IaC. The pi-coms Fleet Console should not be in that rotation; it
   should be reached from the chat menu instead.** Today the icon cycles all
   three (screenshots show it landing on "Fleet Console — Ask the live account
   agents across the fleet").
2. **The Elastic IaC triage view "looks small".** Needs a design pass; see the
   open question below about which panel is meant.

Neither is started. No code was written for either. The infrastructure work that
filled the previous session is finished and merged.

## Context — how these came up

The previous session took the pi-fleet work live: prd rollout to three accounts,
then a run of `just` ergonomics fixes (PRs #702, #703). At the end the user
opened the app, cycled the header agent control through all three agents, and
raised these two UI points. They are explicitly deferred to a fresh session; the
ops team owns the live incidents from here.

Prior sessions worth knowing about:
- `docs/superpowers/specs/2026-09-07-multi-hub-addressing.md` — parked hub
  rekey, unrelated to these items but written the same day.
- `docs/architecture/pi-fleet-third-graph.md` — why `pi-fleet-console` is a
  third graph at all.

## Item 1 — the selector should offer two modes, not three

### Where the bodies are buried

The header control cycles whatever `/api/agents` returns, in registry order:

`apps/web/src/routes/+page.svelte:171`

```svelte
// Cycles through the agents this deployment offers, in registry order.
function cycleAgent() {
	const ids = selectableIds;
	const next = ids[(ids.indexOf(agentStore.currentAgent) + 1) % ids.length];
	if (next) agentStore.switchAgent(next);
}
```

Bound at `+page.svelte:264-267` (`onclick={cycleAgent}`, `title="Switch agent
({agentTitle})"`).

The list comes from `apps/web/src/lib/server/graph-registry.ts:121`:

```ts
export function listSelectableAgents(env: NodeJS.ProcessEnv = process.env): readonly AgentDescriptor[] {
	return listAgents().filter(
		(a) => a.id !== "pi-fleet-console" || (isPiFleetGraphEnabled(env) && isPiComsConfigured(env)),
	);
}
```

served by `apps/web/src/routes/api/agents/+server.ts:14`.

So `pi-fleet-console` is already conditional — it appears only when the flag is
on AND a hub is configured. On this machine both hold, which is why it is in the
rotation. The ask is stronger: it should never be in the *icon* rotation, hub or
not, and should be reachable another way.

### The shape of the fix

The vocabulary is `apps/web/src/lib/agent-ids.ts:13`:

```ts
export const AGENT_IDS = ["incident-analyzer", "elastic-iac", "pi-fleet-console"] as const;
```

Do **not** delete the id — `graphFor()` must keep resolving it, and
`memory-backend.ts`'s `AGENT_MEMORY_IDENTITIES` map throws for unregistered
names by design. The distinction to introduce is between *an agent that exists*
and *an agent the header icon cycles*.

Suggested: add a field to `AgentDescriptor` (e.g. `surface: "mode" | "menu"`),
keep `listSelectableAgents` as the "can this deployment offer it at all" filter,
and have the header derive its rotation from `surface === "mode"`. Then the chat
menu renders the `"menu"` ones. That keeps one registry entry per agent and
avoids a second hardcoded list, which is the mistake SIO-1655 removed.

**Open question for the user**: "the chat menu" needs pinning down — the `+`
button left of the composer (`+page.svelte`, near the input), a new dropdown, or
the existing `PiFleetPane`? Ask before building.

### Watch out

- `apps/web/src/lib/server/agent.test.ts` asserts the selectable list; expect it
  to fail and read the failure as signal, not something to rewrite to fit.
- Two `agentName === "elastic-iac"` branches in `invokeAgent`/`iacResume` are
  deliberate (different state shape, not just a different graph) — leave them.
- `isIac` at `+page.svelte:88` gates genuinely IaC-specific rendering. It is a
  feature check, not a two-agent assumption; it stays either way.

## Item 2 — "the Elastic IaC triage looks small"

### What exists

`GraphTriagePanel` (SIO-1572) is mounted at `+page.svelte:503-514` inside:

```svelte
<div class="w-2/5 max-w-xl shrink-0 border-l border-gray-200 bg-tommy-cream overflow-hidden">
```

so it is capped at `max-w-xl` (36rem) regardless of viewport. Its own root is
`apps/web/src/lib/components/GraphTriagePanel.svelte:120` (`flex flex-col
h-full`), with a header at `:121-125` using `text-xs` / `text-[0.625rem]`.

### The ambiguity to resolve first

The screenshots show the **Elastic IaC agent with no triage panel visible at
all** — the IaC view is a full-width empty state. So "the Elastic IaC triage
looks small" could mean:

- the shared `GraphTriagePanel` when running as `elastic-iac` (cramped by
  `max-w-xl`, tiny type), or
- the IaC-specific plan/drift review rendering (`+page.svelte:315`, `:341`,
  `variant={isIac ? "iac" : "incident"}` at `:396`), or
- that IaC has no triage pane and should.

**Ask the user which, with the app open, before changing CSS.** Guessing here
wastes a cycle. If it is the first: `max-w-xl` and the `text-[0.625rem]`
subtitle are the two obvious levers, but check both agents at a realistic window
size — widening the pane takes width from the chat column.

Project rule: **Tailwind only**, no `<style>` blocks (exception: MarkdownRenderer).

## Verification

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint
cd apps/web && bun run test        # web tests ONLY via the package script
```

Note: root `bun run typecheck` **skips svelte-check** — run `apps/web`
separately or a Svelte type error slips through. Root `bun test` can crash the
Bun runner mid-suite; run per package.

Manual, both items:

```bash
bun run --filter @devops-agent/web dev    # port 5173
```

Cycle the header icon: it must land only on Incident Analyzer and Elastic IaC.
Confirm the Fleet Console is still reachable by its new route and that
`graphFor("pi-fleet-console")` still resolves (it must not 404).

## Files likely to change

| File | Change |
|---|---|
| `apps/web/src/lib/server/graph-registry.ts` | add the surface distinction to `AgentDescriptor` |
| `apps/web/src/routes/+page.svelte` | `cycleAgent` derives from mode agents; menu entry for the console |
| `apps/web/src/routes/api/agents/+server.ts` | expose the new field |
| `apps/web/src/lib/server/agent.test.ts` | update expectations (read failures as signal) |
| `apps/web/src/lib/components/GraphTriagePanel.svelte` | item 2, pending the clarification |

`agent-ids.ts` should NOT lose `pi-fleet-console`.

## Workflow

Branch off `main`, create the Linear issue first (project rule: no
implementation without one), PR ready-for-review not draft.

Expect **Greptile to skip**: it has returned `SKIPPED` in ~110-165 ms on every
PR since #696 (nine consecutive code PRs merged with no bot review; CodeRabbit
silent for 24). The documented merge gate cannot pass — merging is the user's
explicit per-PR call, and the bake-off ledger row must record it as an override,
not as a satisfied gate. Append to `docs/code-review-bakeoff.md` either way.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Removing the console from the rotation makes it unreachable | Medium | Build the menu entry in the same PR; verify `graphFor` still resolves it |
| A second hardcoded agent list creeps back in | Medium | Derive from the registry; SIO-1655 exists to prevent exactly this |
| Widening the triage pane squeezes the chat column | Medium | Check at a realistic window size, both agents |
| Guessing which "triage" is meant | High | Ask first, with the app open |

## Out of scope

- The parked multi-hub rekey (`2026-09-07-multi-hub-addressing.md`).
- Live incident work on the prd fleet — the ops team owns it.
- The 32 stale undiagnosed rows on `eu-oit-prd` (user decided: leave them; they
  age out at 90 days).
- Anything about `wrapUntrusted` or how hub replies reach a model.

## State of the fleet at handover (context, not tasks)

- Three prd spokes + three monitors online under project `pi-coms-prd`;
  investigation verified working on all three (`unsent reports: 0`).
- `just hub-tunnel eu-shared-services-prd 8787` and `just coms
  eu-shared-services-prd simon` are the current commands, run from the repo
  root. No tunnels are left running.
- Known, documented, not fixed: `environmentForEstate`
  (`packages/agent/src/action-tools/pi-verifier.ts:104`) routes an estate to a
  hub by name suffix, so a second prd hub would be addressed as
  shared-services with no error.

## Memory references

`reference_sio1655_fleet_console_graph`, `reference_sio1572_graph_triage_pathmap_unreachable`,
`reference_root_typecheck_skips_svelte_check`, `reference_web_tests_need_package_script_and_ssr_comments`,
`feedback_capabilities_default_on_in_config_schema`, `reference_greptile_skips_docs_only_prs`,
`reference_sio1650_pi_fleet_pane`
