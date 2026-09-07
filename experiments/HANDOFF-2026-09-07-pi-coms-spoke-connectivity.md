# HANDOFF 2026-09-07 — cannot speak to a pi-coms spoke (reads work, sends 403)

**Date**: 2026-09-07
**Repo state**: `main` @ `972c2887`, clean tree
**Suggested branch**: `claude/pi-coms-sender-principal`
**Linear**: none yet — create one before implementing (project rule).
Relates to https://linear.app/siobytes/issue/SIO-1650 (fleet pane),
https://linear.app/siobytes/issue/SIO-1653 (fleet deploy CLI),
https://linear.app/siobytes/issue/SIO-1635 (hub client)

## TL;DR

Two **separate** problems, both diagnosed to root cause and both **configuration,
not code**. No code fix is required for either.

1. **Sending to a spoke fails with `403 name_not_allowed`** (reads work). The
   fleet pane registers a sender named `pi-fleet-<sessionId>`, but no principal
   on the prd hub allows that name. Fix: mint a `pi-fleet` principal and set
   `PI_COMS_PANE_TOKENS`, **or** set `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer`
   to reuse the principal that already exists. One line either way.
2. **`just coms eu-shared-services-prd simon` cannot reach the hub.** It was run
   from the **standalone `~/WebstormProjects/pi-coms` repo**, which has no
   `deploy/fleet.yaml` and an **old justfile without `--strict-selector`**. It
   silently fell through to a local hub on 8787 (nothing listening). The
   monorepo copy resolves correctly. Fix: run it from the monorepo.

Everything else is healthy: the prd tunnel is up on 8788, the hub authenticates,
and all three prd spokes report `status: "online"`.

## Verified state at handover (2026-09-07 ~13:05Z)

```
tunnel        127.0.0.1:8788 LISTEN (session-manager-plugin)  -> prd hub, alive
GET /v1/agents?project=pi-coms-prd  -> 200, 3 spokes ONLINE
   eu-oit-prd, eu-mendix-platform-prd, eu-shared-services-prd
GET /v1/mailbox?project=pi-coms-prd&name=ops -> 200, monitors still posting
   newest: monitor-eu-oit-prd @ 2026-09-07T13:01:15Z (status queued)
POST /api/pi/messages {environment:prd,target:eu-shared-services-prd}
   -> 502 {"error":"pi-coms hub POST /v1/agents/register failed: 403 name_not_allowed"}
```

The dev hub (`127.0.0.1:8787`) has **no tunnel**, so the pane's `dev` row showing
`fetch failed` is correct and expected, not a bug.

**Note on the screenshot**: it showed BOTH dev and prd as `fetch failed`. prd
recovered on its own — the prd tunnel is up and `/api/pi/agents` now returns all
three spokes online. Treat a prd `fetch failed` as a dropped SSM tunnel
(see [[reference_mcp_boot_resilience_and_transients]]), not this bug.

## Problem 1 — `403 name_not_allowed` on send

### Where the bodies are buried

The pane registers a sender session before sending; reads need no registration,
which is exactly why fetching works and speaking does not.

`apps/web/src/lib/server/pi-fleet.ts:27-30` states the contract:

```ts
// Directory-mode hubs bind names to principals: the pane's prefix needs its own
// principal (`just token-create pi-fleet "pi-fleet-*" service <profile>`) and its
// token in PI_COMS_PANE_TOKENS, or the prefix is set to the analyzer's own.
const DEFAULT_SENDER_PREFIX = "pi-fleet";
```

`pi-fleet.ts:194` — the name actually registered:

```ts
sender: senderNameFor(client.sessionId, pane.senderPrefix),   // "pi-fleet-<sessionId>"
```

`pi-fleet.ts:87-93` — the token used, falling back to the hub's own when
`PI_COMS_PANE_TOKENS` is unset:

```ts
const tokens = readPaneTokens(env.PI_COMS_PANE_TOKENS);
...
hubs.push({ environment, hub: paneToken ? { ...hub, authToken: paneToken } : hub });
```

### The mismatch, measured against the live hub

`just token-list eu-shared-services-prd` (run from `packages/pi-coms`):

```
eu-mendix-platform-prd   kind=agent      names=eu-mendix-platform-prd,monitor-eu-mendix-platform-prd
eu-oit-prd               kind=agent      names=eu-oit-prd,monitor-eu-oit-prd
eu-shared-services-prd   kind=agent      names=eu-shared-services-prd,monitor-eu-shared-services-prd
incident-analyzer        kind=service    names=incident-analyzer-*
simon                    kind=operator   names=simon,ops,laptop
```

`grep -c "^PI_COMS_PANE_TOKENS" .env` → **0** (not set).

So the pane authenticates with the **`incident-analyzer`** token (from
`PI_COMS_HUBS`) while registering the name **`pi-fleet-<sessionId>`**. The
allowed pattern for that principal is `incident-analyzer-*`. No match → 403.

### The fix — pick ONE

**Option A (recommended, zero new secrets).** Reuse the principal that already
exists, in the monorepo `.env`:

```
PI_COMS_PANE_SENDER_PREFIX=incident-analyzer
```

The pane then registers `incident-analyzer-<sessionId>`, which matches
`incident-analyzer-*`. Nothing to mint, nothing to rotate, and the sender is
correctly attributed to the analyzer.

**Option B (a distinct identity for the pane).** Mint a principal and give the
pane its own token:

```bash
cd packages/pi-coms
just token-create pi-fleet "pi-fleet-*" service eu-shared-services-prd
# then in the monorepo .env, keyed by ENVIRONMENT (not profile):
PI_COMS_PANE_TOKENS='{"prd":"<token>"}'
```

Prefer A unless the fleet pane must be distinguishable from the analyzer in hub
audit logs. B costs a secret to rotate and a second principal to keep in sync
across every hub.

**Do this per environment.** Applying it to prd alone leaves dev broken the
moment a dev tunnel exists.

### Verification

```bash
# with a prd tunnel up (see Problem 2) and the web app running:
curl -s -m 60 -H 'Content-Type: application/json' \
  -d '{"environment":"prd","target":"eu-shared-services-prd","prompt":"probe: reply OK"}' \
  http://localhost:5173/api/pi/messages
```

Expect HTTP 200 with a `msg_id` and a `status`, **not** 502
`name_not_allowed`. Then confirm in the UI: fleet pane → prd → select
`eu-shared-services-prd` → ask a question → a reply renders as data.

**Restart the web server after editing `.env`.** Vite restarts in place on an
`.env` change but `loadEnv` keeps the STALE `process.env`, so the old value
survives a hot restart — see [[reference_vite_inplace_restart_env_precedence_and_kg_slots]].
Kill the process and start it fresh, or the fix will look like it did nothing.

## Problem 2 — `just coms <hub> <cname>` cannot reach the hub

### What actually happened

The console error was:

```
Error: coms-net: server unreachable at http://127.0.0.1:8787 — coms-net: fetch failed.
```

8787 is the **dev/local** default. The prd tunnel is on **8788**. The command
never took the deployed-hub branch at all.

Cause: it was run from `~/WebstormProjects/pi-coms` (visible in the Pi console
header), the **standalone repo**, which is behind the monorepo:

```
~/WebstormProjects/pi-coms/deploy/fleet.yaml            MISSING
grep -c "strict-selector" ~/WebstormProjects/pi-coms/justfile   -> 0   (old recipe)
git -C ~/WebstormProjects/pi-coms log --oneline -1  -> 275cf6d (pre-SIO-1653)
```

Without the manifest the selector cannot resolve, so `eu-shared-services-prd`
was treated as a plain session name and the extension fell back to the local
hub default.

The monorepo copy is correct — verified:

```bash
cd ~/WebstormProjects/devops-incident-analyzer/packages/pi-coms
bun scripts/hub-tunnel-target.ts deploy/fleet.yaml eu-shared-services-prd --strict-selector
# ENV_KEY='prd' PROFILE='eu-shared-services-prd' REGION='eu-central-1'
# PORT='8787' LOCAL_PORT='8788' PROJECT='pi-coms-prd'
```

`LOCAL_PORT=8788` matches the live tunnel exactly.

### The fix

Run pi-coms commands **only from the monorepo**:

```bash
cd ~/WebstormProjects/devops-incident-analyzer
just hub-tunnel eu-shared-services-prd    # if no tunnel on 8788
just coms eu-shared-services-prd simon
```

Expect the recipe to print, before Pi starts:

```
coms-net: prd hub via localhost:8788 (project pi-coms-prd) as simon
```

If that line is absent, the selector did not resolve and you are on a local hub
again — do not proceed.

### Recommended hardening (optional, small)

The failure was silent: an unresolved selector degrades to a local session with
no warning, and the operator only learns from a connection error naming the
wrong port. Two cheap options:

1. In `packages/pi-coms/justfile`, when `$MANIFEST` is absent AND the first word
   looks like a hub selector (contains `-prd`/`-dev`, or matches a known
   profile), fail with `manifest not found: <path>` instead of falling through.
2. Retire or clearly mark `~/WebstormProjects/pi-coms` as superseded by the
   subtree (SIO-1654). A stale clone that still answers `just coms` is a trap
   that will be re-entered. See [[feedback_one_codebase_pi_coms_in_monorepo]].

Neither is required to unblock; both prevent a repeat.

## Files to modify

| File | Change |
|---|---|
| `.env` (monorepo, gitignored) | add `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` (Option A) **or** `PI_COMS_PANE_TOKENS` (Option B) |
| `.env.example` | document whichever key is chosen, with the principal contract |
| `packages/pi-coms/justfile` | *(optional)* fail loudly when the manifest is missing but a selector was given |

No application code changes are expected. `pi-fleet.ts` already implements both
options; this is a configuration gap the code comment at `:27-30` predicted.

## Verification (full)

```bash
cd ~/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint
cd apps/web && bun run test        # web tests ONLY via the package script
```

Root `bun run typecheck` **skips svelte-check**; root `bun test` can crash the
Bun runner mid-suite — run per package. A `packages/agent` SIGABRT (exit 134)
after `393 pass / 0 fail` is the known transient; re-run it.

Live probes, in order:

```bash
# 1. tunnel up?
lsof -nP -iTCP:8788 -sTCP:LISTEN

# 2. hub reachable and spokes online?
TOK=$(grep '^PI_COMS_HUBS' .env | python3 -c "import sys,json; s=sys.stdin.read().split('=',1)[1].strip().strip(\"'\"); print(json.loads(s)['prd']['authToken'])")
curl -s -H "Authorization: Bearer $TOK" \
  'http://127.0.0.1:8788/v1/agents?project=pi-coms-prd&include_explicit=true' | head -c 400

# 3. the actual fix: send must NOT 403
curl -s -m 60 -H 'Content-Type: application/json' \
  -d '{"environment":"prd","target":"eu-shared-services-prd","prompt":"probe: reply OK"}' \
  http://localhost:5173/api/pi/messages
```

**Always pass `?project=pi-coms-prd`** on `/v1/agents`. Without it the hub
returns `{"agents":[]}` and it reads exactly like "no spokes online" — a
misleading dead end. (`pi-coms-client.ts:295` gets this right; hand-rolled curl
often does not.)

Note the wire contract when probing by hand: `POST /v1/messages` takes `target`
and a registered `sender_session`, **not** `target_name`
(`pi-coms-client.ts:300-317`). A wrong shape returns `400 invalid_request`,
which is easy to misread as a hub fault.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Fix applied to prd only; dev breaks later | High | Set the prefix/token for every environment in `PI_COMS_HUBS` |
| `.env` edited but the server hot-restarts with stale env | High | Kill and restart the web server; verify via `/api/pi/agents` |
| Option B token drifts or is not rotated with the hub | Medium | Prefer Option A unless separate audit identity is required |
| Re-running `just coms` from the stale standalone repo | Medium | Run from the monorepo; consider the hardening above |
| prd `fetch failed` reappears | Medium | Usually a dropped SSM tunnel, not this bug — re-run `just hub-tunnel` |

## Out of scope

- SIO-1656 acceptance steps 2-4 (a live MR against project 82850717) — still
  open, unrelated to this.
- The fleet-console **agent** entry button, still unverified on a hub-configured
  machine (SIO-1657). Related area, different feature.
- The parked multi-hub rekey
  (`docs/superpowers/specs/2026-09-07-multi-hub-addressing.md`) and the known
  `environmentForEstate` suffix-routing hazard
  (`packages/agent/src/action-tools/pi-verifier.ts:104`).
- The 32 stale undiagnosed rows on `eu-oit-prd` (user decided: leave them).

## Related code references

- `apps/web/src/lib/server/pi-fleet.ts:27-30` — the principal/prefix contract, in a comment
- `apps/web/src/lib/server/pi-fleet.ts:87-93` — pane token fallback to the hub token
- `apps/web/src/lib/server/pi-fleet.ts:194` — the sender name registered
- `packages/agent/src/action-tools/pi-coms-client.ts:276` — register (the 403 site)
- `packages/agent/src/action-tools/pi-coms-client.ts:295` — list agents, **with** `project`
- `packages/agent/src/action-tools/pi-coms-client.ts:300-317` — send payload shape
- `packages/pi-coms/justfile` — `coms` recipe, `--strict-selector` resolution and the fall-through
- `packages/pi-coms/scripts/hub-tunnel-target.ts` — selector → `LOCAL_PORT`/`PROJECT`

## Memory references

`reference_sio1650_pi_fleet_pane` (PI_COMS_PANE_TOKENS, one await slice per request),
`reference_sio1635_pi_coms_hub_client_gotchas` (online-only routing, stale queues),
`reference_sio1653_fleet_deploy_cli` (fleet.yaml gitignored, tokens before render),
`reference_fleet_deploy_live_gotchas` (hub returns an EMPTY LIST for an unknown project),
`feedback_one_codebase_pi_coms_in_monorepo` (the standalone repo is superseded),
`reference_vite_inplace_restart_env_precedence_and_kg_slots` (stale env after an in-place restart),
`feedback_no_cross_environment_access` (dev hub for dev, prd hub for prd)
