# HANDOFF 2026-09-07 — session close: IaC MR labels, frontend panes, fleet observability

**Date**: 2026-09-07
**Repo state**: `main` @ `37e5af39`, clean tree, nothing in flight
**Updated**: 2026-09-08 — three follow-up PRs (#712, #713, #714) landed after this
doc was first written; see "Landed after this handover" below
**Suggested branch**: n/a — nothing is half-done. Branch per item if you pick one up.
**Linear**: SIO-1656, SIO-1657, SIO-1658, SIO-1659, SIO-1660, SIO-1662 (all closed);
SIO-1661 was done in a PARALLEL session (see "Two sessions" below)

## TL;DR

**Nothing is blocked and nothing is half-finished.** Ten PRs merged (#704–#714),
all five CI jobs green on each, and the two pi-coms hubs are proven end to end
with live sends. Four of the ten came from a parallel session (#710, #712, #713,
#714) — see "Landed after this handover" for the two that amend work described
here.

This is a close-out document, not a to-do list. Read it for what changed, the
invariants that are easy to break, and the traps that cost time today.

The one thing that is "open" is deliberately open: SIO-1656 is **accepted in
production** (the last few version upgrades passed `check-mr-labels` on the first
pipeline) rather than force-verified with throwaway MRs. Do not re-open it.

## What shipped

| PR | Issue | What |
|---|---|---|
| #704 | SIO-1656 | IaC MRs carry an AGENTS.md §10 change class **on create** |
| #705 | SIO-1657 | Fleet console made contextual, not a peer mode |
| #706 | SIO-1657 | Triage graph fits the pane (wrap wide layers) — reverted #705's scrolling |
| #707 | SIO-1658 | Tall HITL gate card no longer collapses the triage pane |
| #708 | SIO-1659 | Gate cards bounded to the chat column, off the panes |
| #709 | SIO-1660 | pi-coms fleet path instrumented |
| #710 | SIO-1661 | Registration failures name the rejected sender *(parallel session)* |
| #711 | SIO-1662 | One fleet control; console entry moved into the pane |
| #712 | SIO-1663 | `activeSkills` — each elastic-iac lane loads only its skills *(parallel)* |
| #713 | SIO-1664 | Fleet-upgrade history answered instead of "(unknown)" *(parallel)* |
| #714 | SIO-1665 | Monitors hidden from spoke lists; no triage graph on the console *(parallel)* |

## Landed after this handover (2026-09-08)

Three PRs merged from a **parallel session** between this doc being written and
being read. Two of them touch code this session owned, so they are summarised
here rather than left to `git log`.

**#712 — SIO-1663, `activeSkills` per IaC lane.** New
`packages/agent/src/iac/skill-selector.ts` (+ a sync test) so each lane loads
only the skills it needs, instead of every lane paying for all of them. Isolated
from this session's work.

**#713 — SIO-1664, fleet-upgrade history.** The status question answered
"(unknown)" and returned one upgrade rather than the list, and corrupted durable
memory on the way. Touches `iac/nodes.ts`, `iac/local-tools.ts`, `iac/state.ts`
and the knowledge-graph reader. Isolated from this session's work.

**#714 — SIO-1665, monitors and the console's triage graph.** This one AMENDS
two things this session shipped, and the amendments are good:

- `monitor-*` registrations were listed as addressable spokes in both the fleet
  pane and the console's `fleet_list_agents`. A new `spokesOnly` helper filters
  them at both listing sites. The hub card carries no role field and `purpose` is
  agent-authored prose, so the **name prefix is the only safe discriminator**.
  Monitor reports still reach the pane through the ops inbox, and
  `fetchFleetInbox` is unchanged.
- The triage pane followed the agent onto the Fleet Console and drew its
  two-node graph beside the fleet pane. The registry gains **`hasTriageGraph`**
  (false for the console), `/api/agents` carries it, and the page gates the
  header toggle and the mount on one derived `triageOffered`.

`fleetOffered` (SIO-1662) is intact and `triageOffered` was built to the same
rule — **one derived value gating both a control and what it controls**, which is
invariant 2 below. That rule now has two independent applications; treat it as
the established pattern for any new pane.

Also recorded there, and worth not re-investigating: a follow-up "summarise" to a
spoke repeating its earlier answer is **spoke-side behaviour** (one persistent Pi
session, fresh sender per send, no `conversation_id`), not a UI defect.

## Two sessions ran against this repo today

PR #710 (SIO-1661) was authored and merged from a **different session** at
13:46Z, touching `pi-coms-client.ts` and `pi-fleet.ts` — the same two files this
session changed for SIO-1660. Both landed; verified after the fact that they
coexist on `main` (both sets of `SIO-1661` and `SIO-1660` markers present, 394
web + 79 action-tools tests green).

Worth knowing because the two are complementary and easy to mistake for
duplicates: SIO-1660 logs **every** hub call at one seam; SIO-1661 makes the
registration **error message** name the sender it tried. If you touch either
file, check `git log` for concurrent work before assuming you have the whole
picture.

## Invariants that are easy to break

These were each established by a defect this session. Breaking one reintroduces
a specific, known bug.

1. **The triage panel must FIT the pane — never scroll horizontally.**
   #705 shipped natural-size rendering with horizontal scroll; it was rejected on
   sight (the pane opened on empty space with the flow running off both edges).
   The fix is `MAX_ROW_NODES = 3` in `apps/web/src/lib/graph-layout.ts`, which
   wraps wide layers so every chart caps at 654px. Raising it re-introduces the
   shrink. `w-full` + `max-width` on the SVG is correct; `max-w-full` would also
   re-shrink.

2. **HITL gate cards live INSIDE the chat column.**
   As siblings of the split row they span the full page and both collapse and
   cover the triage/fleet panes. `fleetOffered`/`hasGateCard` gate the region;
   the cap is `max-h-[55vh]`. Gating a control is not the same as gating what it
   controls — the pane's own `{#if}` needs the same condition as its toggle, or
   it renders in IaC with nothing to close it.

3. **Fleet belongs to the incident analyzer, and panes follow the agent.**
   `fleetOffered = piFleetStore.configured && (currentAgent === "incident-analyzer"
   || currentAgent === "pi-fleet-console")`. The console is reached from **inside
   the pane** (`onAskAll` → "Ask all spokes at once"), not a header icon. There is
   exactly one fleet control.
   SIO-1665 applied the same rule to the triage pane via `hasTriageGraph` on the
   registry descriptor and a `triageOffered` derived. **Add a capability flag to
   `AgentDescriptor` rather than an `agentName === ...` check** — that is what the
   descriptor exists for (`hasConfidence`, `hasDataSources`, `streamsTokens`,
   `surface`, `hasTriageGraph`), and it is why adding an agent stays cheap.

   Also: **monitors are not addressable spokes.** `spokesOnly` filters `monitor-*`
   at both listing sites (the pane and the console's `fleet_list_agents`). The hub
   card has no role field and `purpose` is agent-authored prose, so the name prefix
   is the only safe discriminator. Their reports still arrive via the ops inbox.

4. **Never log a token, prompt, or spoke reply.**
   `packages/observability/src/logger.ts` has **no redaction config** — whatever
   is passed is emitted. The SIO-1660 logging is written to carry identity and
   outcome only, and was verified against real output (grepped the running
   server's log for the actual `.env` tokens, the `Bearer` header, and a probe
   prompt — all absent). Keep it that way when adding events.

5. **MR labels: the change class is required ON CREATE.**
   `check-mr-labels` reads `CI_MERGE_REQUEST_LABELS`, resolved at pipeline
   creation, so a label added later is invisible. `WORKFLOW_CHANGE_CLASS` in
   `packages/agent/src/iac/mr-labels.ts` is an exhaustive
   `Record<IacWorkflow, ChangeClass>` — a new workflow cannot ship unclassified
   without failing typecheck. `AGENT_MR_LABELS` is the READ-side filter only;
   never resend that bare pair at a create call site.

## Traps that cost time today

- **A stale standalone repo.** `just coms <hub> <cname>` run from
  `~/WebstormProjects/pi-coms` silently falls through to a LOCAL hub (8787)
  because that clone has no `deploy/fleet.yaml` and a justfile predating
  `--strict-selector`. The error names the wrong port and reads like a dead hub.
  Run pi-coms commands **only from the monorepo**. A correct run prints
  `coms-net: prd hub via localhost:8788 (project ...) as <cname>` before Pi starts.

- **`fetch failed` on EVERY hub is usually EXPIRED AWS CREDENTIALS**, not a
  pi-coms fault — it stops the SSM tunnel being established at all. Check
  `aws sts get-caller-identity --profile <hub profile>` first. These profiles hold
  temporary STS keys in `~/.aws/credentials` (no sso-session, no role_arn), so
  only the operator can refresh them, and refreshing prd does not refresh dev.

- **`/v1/agents` without `?project=` returns `{"agents":[]}`**, which reads
  exactly like "no spokes online". `pi-coms-client.ts` gets this right; hand-rolled
  curl often does not. Likewise `POST /v1/messages` takes `target` and a registered
  `sender_session`, **not** `target_name` — a wrong shape returns `400
  invalid_request` and looks like a hub fault.

- **Tailwind compiles arbitrary values at BUILD time.** Setting `max-h-[45vh]`
  from devtools does nothing unless that exact class exists in source. Probe
  alternative caps with inline `style.maxHeight`.

- **The ROOT typecheck skips svelte-check.** Restructuring markup needs
  `cd apps/web && bun run typecheck` — it caught an unbalanced `</div>` this
  session that the root run reported as clean.

- **A green-then-abort CI failure.** The Test job can print `393 pass / 0 fail /
  exit 0` and still fail with exit **134** — a Bun SIGABRT in `packages/agent`,
  the known transient. Read far enough up the log to see which package aborted
  before re-running; a real failure shows the same red X.

## Verification

```bash
cd ~/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint
cd apps/web && bun run test          # 394 pass
cd ../../packages/agent && bun test src/action-tools/   # 79 pass
```

Known-noise, both **pre-existing** and reproducible on an unmodified tree (proven
by stashing): `@devops-agent/pi-coms/contracts` and `@earendil-works/*` module
errors in the local checkout. CI resolves these fine — Typecheck is green on
`main`.

Live fleet probe (needs valid creds + a tunnel):

```bash
just hub-tunnel eu-shared-services-prd      # prd -> localhost:8788
# dev is eu-shared-services-dev -> localhost:8787
curl -s localhost:5173/api/pi/agents | python3 -m json.tool
curl -s -H 'Content-Type: application/json' \
  -d '{"environment":"prd","target":"eu-shared-services-prd","prompt":"probe"}' \
  localhost:5173/api/pi/messages
```

Expect HTTP 200 / `status: complete` with a sender named `incident-analyzer-<id>`.
**Kill the tunnel afterwards** and prove the port free
(`lsof -nP -iTCP:8788 -sTCP:LISTEN`).

## State of the fleet at handover

- **Both hubs proven end to end**, 2026-09-07. prd: 6 spokes online, live send to
  `eu-shared-services-prd` and `eu-oit-prd` both `complete`. dev: 4 spokes online,
  live send to `eu-shared-services-dev` `complete` (replied with account
  352896877281 — correct account, no cross-environment leakage).
- **No principal work outstanding.** Both hubs already carry
  `incident-analyzer  kind=service  names=incident-analyzer-*`, and the tokens in
  `PI_COMS_HUBS` match those principals' SSM tokens (compared by SHA-256).
- `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` is set in the monorepo `.env`.
  It applies to **both** environments — that is why the dev principal mattered.
- **No tunnels left running.** 8787 and 8788 both free at close.

## Known, documented, NOT fixed

- `environmentForEstate` (`packages/agent/src/action-tools/pi-verifier.ts:104`)
  routes an estate to a hub by name **suffix**, so a second prd hub in another
  account would be addressed as shared-services with no error. Correct only while
  one prd hub exists. Parked design:
  `docs/superpowers/specs/2026-09-07-multi-hub-addressing.md`.
- The stale `~/WebstormProjects/pi-coms` clone still answers `just coms` and will
  trap someone again. Options considered, neither done: fail loudly when the
  manifest is missing but a selector was given, or retire the clone (SIO-1654 made
  the monorepo subtree authoritative).
- SIO-1656 residual: live traffic exercises `config-change` (the mapping's
  default). `ilm` and `fleet-integrations` share the same call site and are
  unit-tested but not yet observed live. If one ever fails the gate, check
  `WORKFLOW_CHANGE_CLASS` first.

## Review-bot status

**Greptile has SKIPPED 31 consecutive PRs** (#679–#711) and CodeRabbit has been
silent for as many. The documented merge gate cannot pass, so every merge in this
session was an explicit per-PR override by the user, recorded as such in
`docs/code-review-bakeoff.md` (a row + detail section per PR — keep appending).

Worth stating for whoever picks this up: **four of this session's defects were
found by the user opening the running app**, past green CI and a skipped review.
Two of them were regressions in work that had just shipped. Verify UI changes
with a screenshot and a measured before/after, not just a passing test — twice
this session a metric was optimised (label pixels, then "pane visible") while the
thing the user actually needed stayed broken.

## Related code references

- `apps/web/src/lib/graph-layout.ts` — `MAX_ROW_NODES`, layer wrapping
- `apps/web/src/lib/components/GraphTriagePanel.svelte` — fit-to-width SVG
- `apps/web/src/routes/+page.svelte` — `fleetOffered`, `hasGateCard`, gate region
- `apps/web/src/lib/components/PiFleetPane.svelte` — `onAskAll` console entry
- `apps/web/src/lib/server/pi-fleet.ts` — pane hub access + SIO-1660/1661 logging
- `packages/agent/src/action-tools/pi-coms-client.ts` — the `http()` seam
- `packages/agent/src/iac/mr-labels.ts` — `WORKFLOW_CHANGE_CLASS`, `mrLabels`

## Memory references

`reference_sio1656_mr_change_class_label`,
`reference_sio1657_agent_surface_and_triage_scaling`,
`reference_sio1658_hitl_gate_cards_collapse_panes`,
`reference_pi_coms_send_403_name_not_allowed`,
`reference_vite_inplace_restart_env_precedence_and_kg_slots`,
`feedback_one_codebase_pi_coms_in_monorepo`,
`feedback_no_cross_environment_access`,
`reference_greptile_skips_docs_only_prs`
