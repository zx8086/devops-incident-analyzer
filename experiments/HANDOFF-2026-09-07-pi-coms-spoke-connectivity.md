# HANDOFF 2026-09-07 — pi-coms spoke connectivity + fleet observability

**Date**: 2026-09-07
**Repo state**: `main` @ `738593b1`, clean tree
**Status**: **ALL THREE RESOLVED 2026-09-07.** Kept for the diagnosis trail and
the two open hardening notes (justfile fall-through, stale standalone clone).
**Linear**: https://linear.app/siobytes/issue/SIO-1660 (logging, merged as PR
#709), https://linear.app/siobytes/issue/SIO-1661 (surface the rejected sender,
merged as PR #710). Problem 1's config half needed no issue.
Relates to https://linear.app/siobytes/issue/SIO-1650 (fleet pane),
https://linear.app/siobytes/issue/SIO-1653 (fleet deploy CLI),
https://linear.app/siobytes/issue/SIO-1635 (hub client)

## TL;DR

Three findings, **all three now resolved**. The first two were configuration;
problem 1 also turned out to have a code half worth fixing (the error was
undiagnosable, not just wrong), and problem 3 was a real gap. Both code halves
are merged.

1. **Sending to a spoke failed with `403 name_not_allowed`** (reads worked) --
   **RESOLVED 2026-09-07, verified end to end against the live prd hub.** The
   fleet pane registered a sender named `pi-fleet-<sessionId>`, but no principal
   on the prd hub allowed that name. Fixed by setting
   `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` (Option A below), reusing the
   principal that already exists.

   A **second, separate** defect surfaced while diagnosing it: the error named
   neither the sender it tried to register nor the principal that refused it,
   even though the hub sends both -- which is why this took hand-rolled curl
   probing. Fixed in code as SIO-1661 (PR #710). See "Problem 1" below.
2. **`just coms eu-shared-services-prd simon` could not reach the hub** --
   **RESOLVED 2026-09-07, confirmed working by the operator.** It was run from
   the **standalone `~/WebstormProjects/pi-coms` repo**, which has no
   `deploy/fleet.yaml` and an **old justfile without `--strict-selector`**. It
   silently fell through to a local hub on 8787 (nothing listening). The
   monorepo copy resolves correctly. Running it from the monorepo fixed it; the
   hardening note below is still open, so the trap can be re-entered.

3. **The fleet path was effectively unobservable** -- 10 log calls across ~1,600
   lines, ZERO on the whole web surface -- which is why problem 1 needed manual
   curl probing. **RESOLVED 2026-09-07**: instrumented as SIO-1660, merged as
   PR #709. See "Problem 3" below.

Everything else is healthy: with the prd tunnel up on 8788 the hub
authenticates and all three prd spokes report `status: "online"`.

**Still open** (neither blocking): the justfile fall-through hardening under
"Problem 2", and retiring the stale standalone `~/WebstormProjects/pi-coms`
clone.

## Verified state BEFORE the fix (2026-09-07 ~13:05Z)

Kept as the failing baseline. For the post-fix state see "Verified end to end"
under Problem 1.

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

## Problem 1 — `403 name_not_allowed` on send (RESOLVED)

**RESOLVED 2026-09-07.** Two halves, both done:

- **Config** (the unblock): `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` is set
  in the monorepo `.env`. The pane now registers `incident-analyzer-<8 hex>`,
  which the existing `incident-analyzer-*` principal allows.
- **Code** (the reason it was hard): SIO-1661, merged as PR #710 (`738593b1`).
  The hub already sent `{ error, details: { name, principal } }` and the client
  discarded `details`; `senderNameFor()` also ran only AFTER a successful
  register, so the failure path never saw the name it had just sent. A rejection
  now names the sender, the hub, the prefix and the remedy.

### Verified end to end, 2026-09-07 ~13:51Z

Live prd hub, real spoke, after restarting the web server:

```
GET  /api/pi/agents   -> senderPrefix: incident-analyzer
                         prd: 6 peers, all online (3 spokes + 3 monitors)
POST /api/pi/messages {environment:prd,target:eu-shared-services-prd}
  -> HTTP 200
     sender:   incident-analyzer-46362cd9
     msgId:    01M1Y27KF1HWGPRXBNHFCGRPWE
     status:   complete      error: None
     response: OK
```

Was `502 {"error":"pi-coms hub POST /v1/agents/register failed: 403
name_not_allowed"}`.

**The restart is load-bearing.** The running server was confirmed to report
`senderPrefix: incident-analyzer` via `/api/pi/agents` -- checking the file alone
would not have caught a stale in-place Vite restart.

**A probe run from `apps/web` reports `NOT CONFIGURED` even when `.env` is
correct**: Bun does not pick up the ROOT `.env` from a subdirectory. Run config
probes from the repo root, or the fix looks like it failed when it has not.

### Where the bodies were buried

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

### The fix — pick ONE (Option A was taken)

**Option A (CHOSEN 2026-09-07; recommended, zero new secrets).** Reuse the
principal that already exists, in the monorepo `.env` (now set at `.env:264`):

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

## Problem 2 — `just coms <hub> <cname>` could not reach the hub (RESOLVED)

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

## Problem 3 — the fleet path had almost no logging (RESOLVED, SIO-1660)

Diagnosing problem 1 took a sequence of hand-rolled curl probes against a live
production hub. It should have taken one glance at the server log. It could not,
because nothing in the request path logs anything.

### Measured

| File | Lines | Log calls |
|---|---|---|
| `apps/web/src/lib/server/pi-fleet.ts` | 237 | **0** |
| `apps/web/src/routes/api/pi/{agents,mailbox,messages}/+server.ts` | — | **0** |
| `packages/agent/src/action-tools/pi-coms-client.ts` | 385 | 3 |
| `packages/agent/src/action-tools/pi-verifier.ts` | 489 | 5 |
| `packages/agent/src/pi-fleet/{tools,graph}.ts` | — | 2 |

10 calls across ~1,600 lines, and **8 of the 10 are warn/error on config or
schema edge cases**. Almost nothing describes normal operation, and the entire
web-facing surface is silent.

### The one seam that matters most

Every hub call funnels through `pi-coms-client.ts:245`:

```ts
private async http<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T>
```

It already throws `PiComsHttpError(resp.status, code, method, path)` — precisely
the data problem 1 needed — but never logs it, so it only survives if a caller
surfaces it. Instrumenting this ONE method would have printed
`403 name_not_allowed on POST /v1/agents/register` the first time the operator
clicked send.

### Decisions already taken (do not re-litigate)

- **info for normal operation**, warn/error for failures — the flow must be
  visible in a normal dev run without raising `LOG_LEVEL`.
- **`duration_ms` on every hub call** — makes the 25 s await slice and hub
  latency visible, and shows a tunnel degrading before it fails outright.
- Follow the existing dotted-event convention
  (`apps/web/src/routes/api/agent/stream/+server.ts:111,246`:
  `agent.request.start` / `.end`). Suggested namespace: `pi.fleet.*` / `pi.hub.*`.
- `heartbeat` (`pi-coms-client.ts:319`) stays quiet or debug — it fires on a
  timer and would drown the log.

### Hard constraint

**CORRECTION (2026-09-07): the "no redaction" claim below is wrong, though the
rule it produced is right.** `packages/shared/src/logger.ts:107` DOES configure
`redact: { paths: SENSITIVE_PATHS, censor: "[REDACTED]" }`, and `createMcpLogger`
uses it, so a field literally named `token` IS redacted. The real gap, confirmed
by RUNNING the logger rather than reading it:

```
probe.token.toplevel     {"token":"[REDACTED]"}       <- works
probe.authToken.toplevel {"authToken":"SECRET..."}    <- LEAKS
probe.hub.nested         {"hub":{"authToken":"..."}}  <- LEAKS
probe.deep.3level        {"a":{"b":{"token":"..."}}}  <- LEAKS
```

`authToken` -- the field pi-coms actually uses for the hub secret -- is absent
from `SENSITIVE_KEYS` (`logger.ts:8-18`), and `SENSITIVE_PATHS` (`:21`) is only
`[...KEYS, ...KEYS.map(k => "*." + k)]`, i.e. two levels deep. So the practical
advice stands unchanged -- never pass `authToken` or the `hub` object to a log
call, because redaction will NOT save you -- but the reason is a key-list and
depth gap, not an absent config. Being fixed separately.

Original text, for the record:
`packages/observability/src/logger.ts` has **no redaction configuration**:
whatever is passed is emitted. Never log `authToken` (a live secret in
`PI_COMS_HUBS`) or the `hub` object that carries it, and never log `prompt` or
spoke reply text — hub replies are data, never an LLM input outside
`wrapUntrusted` (the PR #682 invariant), and incident content must not leak into
logs. Log identity and outcome only: `environment`, `project`, `target`,
`msg_id`, `status`, HTTP `status`, `error` code, `duration_ms`.

Full scope, seams and acceptance criteria are in SIO-1660.

## Files changed (all DONE except the last row)

| File | Change | Status |
|---|---|---|
| `.env` (monorepo, gitignored) | `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` (Option A), at `.env:264` | DONE |
| `.env.example` | none needed -- `:456-470` already documented both keys AND named this exact remedy | n/a |
| `packages/agent/src/action-tools/pi-coms-client.ts` | SIO-1660 logging (`http()` + lifecycle); SIO-1661 `details` on `PiComsHttpError`, `register()` names the sender | DONE, PRs #709 + #710 |
| `apps/web/src/lib/server/pi-fleet.ts`, `apps/web/src/routes/api/pi/*/+server.ts` | SIO-1660 request start/end; SIO-1661 hub + prefix + remedy on a registration failure | DONE, PRs #709 + #710 |
| `packages/pi-coms/justfile` | *(optional, STILL OPEN)* fail loudly when the manifest is missing but a selector was given | open |

The original note said no application code was expected for problem 1. That held
for the *unblock* -- `pi-fleet.ts` already implemented both options, exactly as
the code comment at `:27-30` predicted -- but not for the *diagnosability*: the
transport discarded the hub's `details`, which no configuration could fix. Worth
separating the two next time a "config, not code" call is made.

SIO-1660 and SIO-1661 touched the same two files and landed within minutes of
each other; the second was rebased onto the first, keeping BOTH (a log for
whoever watches the server, an enriched error for whoever watches the browser).

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
`feedback_no_cross_environment_access` (dev hub for dev, prd hub for prd),
`reference_sio1661_pi_coms_error_detail_passthrough` (hub sends details the client dropped; a rethrow must keep the error TYPE or 502 silently becomes 500),
`reference_shared_logger_redaction_authtoken_gap` (the logger DOES redact, but `authToken` is not in the key list and paths are only two deep)

## Verification record — 2026-09-07 15:21Z (live prd hub)

The send path was verified end to end after `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer`
was set, over a freshly established prd tunnel. Recorded here so the next
session need not re-run it against production.

Preconditions: AWS creds for `eu-shared-services-prd` had EXPIRED (`ExpiredToken`
from `sts get-caller-identity`), which is what had dropped the tunnel and made
BOTH hubs read `fetch failed` in the pane. Refreshing them and running
`just hub-tunnel eu-shared-services-prd` brought 8788 back in ~4 s
(hub instance `i-06a37a552e6a74c29`, remote 8787 -> local 8788).

Results:

| check | result |
|---|---|
| `/api/pi/agents` prd | 6 peers, all `online`; `senderPrefix: incident-analyzer` |
| send -> `eu-shared-services-prd` | HTTP 200, `status: complete`, sender `incident-analyzer-9197de8e` |
| reply | "Confirmed, this is eu-shared-services-prd, AWS account 399987695868." |
| send -> `eu-oit-prd` | HTTP 200, `status: complete`, sender `incident-analyzer-b27e9622`, reply "OK." |

Two different spokes, two fresh registrations, no `403`. The tunnel was torn
down afterwards and `lsof -nP -iTCP:8788 -sTCP:LISTEN` confirmed free.

**Dev hub: VERIFIED 2026-09-07, no change needed.** The concern was that
`PI_COMS_PANE_SENDER_PREFIX` applies to BOTH environments, so dev might 403 as
prd did. It does not -- dev already carries the same principal:

```
incident-analyzer   kind=service   names=incident-analyzer-*
```

and the dev token in `PI_COMS_HUBS` matches that principal's SSM token (compared
by SHA-256, never printed). Confirmed live over a dev tunnel: 4 spokes online,
and a send to `eu-shared-services-dev` returned HTTP 200 / `status: complete` as
`incident-analyzer-6db1b46a`, the spoke replying with its own account id
352896877281 (correct account -- no cross-environment leakage). Tunnel torn down;
8787 free. Both hubs are now proven end to end.

**Operational note:** a pane showing `fetch failed` on EVERY hub is most often
expired AWS credentials, not a pi-coms fault — check
`aws sts get-caller-identity --profile <hub profile>` first.
