# HANDOFF 2026-09-12 — fleet pane live-hub verification (SIO-1712 / 1714 / 1715)

| | |
|---|---|
| **Date** | 2026-09-12 |
| **Tickets** | [SIO-1712](https://linear.app/siobytes/issue/SIO-1712), [SIO-1714](https://linear.app/siobytes/issue/SIO-1714), [SIO-1715](https://linear.app/siobytes/issue/SIO-1715) — all **Done**, all merged |
| **PRs** | [#745](https://github.com/zx8086/devops-incident-analyzer/pull/745) `fe59e39d` · [#748](https://github.com/zx8086/devops-incident-analyzer/pull/748) `54b876ed` · [#749](https://github.com/zx8086/devops-incident-analyzer/pull/749) `2ccc96e3` |
| **Repo state** | all three merged to `main`; `origin/main` tip `2ccc96e3` |
| **Suggested branch** | none — this is a **verification** task. Only branch if it finds a bug (then a new ticket, not a reopen). |
| **Status** | **Live run completed 2026-09-12 against the prd hub — PASSED.** Checks 1, 2, 5, 7, 8, 9 verified; 3 and 4 not reachable that day; **check 6 (two hubs) still untested**. The setup recipe below is CORRECTED from the run. |

## TL;DR

Three merged PRs reworked the pi-fleet pane's ops-inbox rendering: the digest moved to the main scroll region and is now labelled as the anchor, the hub header is sticky, and the picker is capped in `rem`. They were built with no live hub available, so this doc was written to specify the live pass.

**That pass ran on 2026-09-12 against the prd hub and PASSED.** Against 36 real ops messages from 6 estates: exactly 6 rows marked `isDigest`, one per estate, none mis-marked (the follow-ups include `[critical]` and `[warn]` rows, which is where naive prefix-matching would have failed). Picker 176px vs digest 565px at a 720px window; sticky header held at offset 0 with the picker scrolled 103px; no horizontal scroll despite real ARNs and log-group names.

**Two things remain.** Check 6 (two hubs with mailboxes loaded at once) is still untested and is still the least-proven path — only prd is tunnelled, and the dev hub is a different account, so loading both would breach the no-cross-environment rule. Checks 3 and 4 could not be exercised because every estate had an `[info]` digest that day; they stay covered by unit tests only.

**The setup section below has been corrected from the run.** The original recipe was wrong in three ways that each produce a working-looking but empty pane.

## Context — how this came to be

The operator reported (with screenshots) that the Inbox ops response was unreadable: clipped mid-sentence, with the spoke list scrolled away above it. SIO-1712 moved the digest card out of the height-capped picker; SIO-1714 marked the digest server-side and pinned the hub header; SIO-1715 replaced the picker's percentage cap with a `rem` cap after measuring that a percentage gave the target list more room than the report on a laptop-sized window.

All three were built and verified by rendering `PiFleetPane` via `svelte/server` and measuring the result with `getBoundingClientRect()`. That proved layout and markup but not the wiring — hub listing, mailbox fetch, anchoring against real monitor output, or the multi-hub case. This doc was written to specify that missing pass.

The pass then ran on 2026-09-12 and is recorded below: the wiring holds against live prd data, the setup recipe needed three corrections, and the multi-hub case is still outstanding.

## Where the bodies are buried

*All line numbers below are against merged `main` at `2ccc96e3`.*

**The pane will not mount without a configured hub.** `apps/web/src/routes/+page.svelte:197`:

```svelte
const fleetOffered = $derived(
	piFleetStore.configured &&
		(agentStore.currentAgent === "incident-analyzer" || agentStore.currentAgent === "pi-fleet-console"),
);
```

`configured` comes from `/api/pi/agents`, which is false without `PI_COMS_HUBS` (`apps/web/src/lib/server/pi-fleet.ts:186`, `:263`). **This is why the work could not be checked live: the build worktree has no `.env` at all.**

**The digest anchor is computed and marked server-side** — `apps/web/src/lib/server/pi-fleet.ts:75-108`:

```ts
const anchor = rows.findLastIndex((m) => m.prompt.includes(DIGEST_MARKER));
if (anchor === -1) missingDigest.push(estate);
// An estate with no digest keeps all its rows and marks none: its block
// starts mid-range, so calling its first row the digest would be a lie.
const block = anchor === -1 ? rows : rows.slice(anchor);
kept.push(...block.map((m, i) => ({ ...m, isDigest: anchor !== -1 && i === 0 })));
```

`DIGEST_MARKER = "daily digest"` (`:51`). The monitor writes **both** `[info] aws-<id> daily digest (since ...)` and `[warn] aws-<id> daily digest <notes>` (`packages/pi-coms/scripts/monitor/report.ts:275-276`) — the `[warn]` form appears when paused or degraded and is the one most worth spotting. Detection keys on the marker, never the prefix.

**Window sizes** (`pi-fleet.ts:43,48`): anchored reads fetch `MAILBOX_ANCHOR_WINDOW = 200`; unanchored `MAILBOX_DEFAULT_LIMIT = 20`. A full window sets `windowTruncated`, which the pane renders as a warning.

**Layout invariants now under test** (`apps/web/src/lib/components/PiFleetPane.svelte`):

- `:190` — picker is `shrink-0 max-h-[11rem] overflow-y-auto` (SIO-1715; **not** a percentage)
- `:213` — hub header row is `sticky top-0 z-10 -mx-4 ... bg-tommy-cream` (SIO-1714)
- `:277` — digest + replies share `flex-1 overflow-y-auto min-h-0`
- `:423` — composer is `px-3 py-2` with `rows="2"` (SIO-1714)

## The verification (step by step)

### 1. Bring up a tunnel to a real hub

```bash
just hub-tunnel eu-shared-services-prd 8788
```

Leave it running. `just hub-tunnel` is defined at `justfile:37`; it resolves the target from the gitignored fleet manifest.

### 2. Create a worktree `.env` — THREE corrections from the live run

The first draft of this section was wrong in three ways. Each produces a pane that looks correctly wired and shows nothing, so they cost real time to diagnose.

**Get the token** (there is no `pi-fleet` principal on the prd hub — see correction 2):

```bash
aws ssm get-parameter --profile eu-shared-services-prd --region eu-central-1 --name /pi-coms/auth/incident-analyzer --with-decryption --query Parameter.Value --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
```

Then the worktree `.env` (gitignored — verify with `git check-ignore -v .env`; it holds a real prd credential and this repo is public):

```bash
PI_COMS_HUBS='{"eu-shared-services-prd":{"serverUrl":"http://127.0.0.1:8788","authToken":"<token>","environment":"prd","project":"pi-coms-prd","estates":["eu-b2b-ecom-prd","eu-b2becom-v2-prd","eu-ediservices-prd","eu-mendix-platform-prd","eu-oit-prd","eu-shared-services-prd"]}}'
PI_COMS_PANE_SENDER_PREFIX=incident-analyzer
AWS_ESTATES='{"eu-oit-prd":{"assumedRoleArn":"arn:aws:iam::762715229080:role/DevOpsAgentReadOnly","region":"eu-central-1"}}'
```

**Correction 1 — `project` is REQUIRED.** The prd hub registers its agents under **`pi-coms-prd`**. The field defaults to `"default"`, which the hub answers with **0 agents and no error**: `/api/pi/agents` returns `configured: true`, the hub row renders with `error: null`, and the spoke list is empty — indistinguishable from an empty fleet. Tell them apart by asking the hub directly:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8788/v1/agents?project=pi-coms-prd&include_explicit=true" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("agents",[])))'
```

Observed 2026-09-12: `pi-coms-prd` -> **13 agents**, `default` -> **0**, `prd` -> **0**.

**Correction 2 — do NOT mint a `pi-fleet` principal in prd.** The earlier advice to run `just token-create pi-fleet ...` against prd was wrong. SSM `/pi-coms/auth/` holds one principal per spoke plus `incident-analyzer` and `simon`, and `incident-analyzer` is `{"kind":"service","names":["incident-analyzer-*"]}`. Setting `PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` reuses it, so the pane registers as `incident-analyzer-<hex>` and is allowed; `PI_COMS_PANE_TOKENS` is then unnecessary. (Without the prefix the default `pi-fleet-<hex>` sender fails `403 name_not_allowed` — see `reference_pi_coms_send_403_name_not_allowed`.)

**Correction 3 — `AWS_ESTATES` is mandatory, not optional.** Per SIO-1704 no estate selected means nothing in scope, and `selectedAwsEstates` is auto-populated from `/api/aws/estates` (`agent.svelte.ts:545-549`). With no MCP servers running the datasource selector never renders, so without `AWS_ESTATES` the pane mounts and says *"No AWS estate selected"* forever. One entry per estate you want in scope; the entries only need to exist for the pane — no role is assumed.

### 3. Start a web server FROM THE WORKTREE, on a non-default port

The operator's own dev server on :5173 runs **main-repo** code. Check the port first, never kill a server you did not start:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

```bash
bun run --filter @devops-agent/web dev -- --port 5174
```

Track the PID at spawn and kill it by that PID when done; prove the port is free with `lsof -nP -iTCP:5174 -sTCP:LISTEN`. See `reference_worktree_web_server_replay_env` for the env gaps that silently make a worktree replay useless (they bite the agent path, not the pane, but the same server is in play).

**The dev server binds IPv6 `[::1]` only.** `curl http://127.0.0.1:5174/...` is refused with exit 7; use `http://localhost:5174`. Cost ten minutes on the live run.

**Restart the server after every `.env` edit — kill the PID and start a fresh one.** Vite's in-place restart keeps stale env (`reference_vite_inplace_restart_env_precedence_and_kg_slots`).

### 4. What to actually check

Select an AWS estate first — per SIO-1704 the pane shows nothing without one, and its selector row is part of why the pane is short.

| # | Check | Expected | **Result 2026-09-12** |
|---|---|---|---|
| 1 | Click `Inbox ops` | Digest renders full-width, **not** clipped at a boundary | **PASS** |
| 2 | The anchor row | `DAILY DIGEST` chip; rows after it indented under a left rule | **PASS** — 6 chips, 30 indented follow-ups, 36 rows total |
| 3 | A `[warn]` digest | Still marked as the digest — not `[info]`-only | **not reachable** — all 6 digests were `[info]` that day; unit-tested only |
| 4 | An estate with no digest in the window | Nothing labelled digest; amber `missingDigest` note; findings still in full | **not reachable** — `missingDigest: []`, every estate had one; unit-tested only |
| 5 | Scroll the spoke list with 6 spokes | Hub row stays pinned; last spoke still selectable | **PASS** — scrolled 103px, header offset 0, Inbox reachable |
| 6 | **Two hubs, both mailboxes loaded** | Two `<details>` cards, each with its own hubKey; independent collapse | **NOT TESTED** — see below |
| 7 | Collapse/expand by keyboard | `<details>` toggles; summary keeps its `N reports` | **PASS** — 42px collapsed, `36 reports` survives, reopens |
| 8 | Click Refresh | Icon spins, button disables, re-enables | **PASS** |
| 9 | Digest region taller than the picker | Picker pinned at 176px | **PASS** — picker 176px, digest 565px at a 720px window |

**Check 6 remains the priority and is still untested.** Only the prd hub is tunnelled; the dev hub (`local_port` 8787) is a different account, and loading both at once would breach the no-cross-environment rule (`feedback_no_cross_environment_access`). It needs a deliberate dev-hub session, or an explicit decision that a prd+dev pane is acceptable for one test.

**What the live data proved that fixtures could not.** The ops mailbox returned **36 messages across 6 estates**, of which **exactly 6 were marked `isDigest` — one per estate, each first in its block, none mis-marked**. The follow-ups include `[critical]` and `[warn]` rows; a naive prefix match would have mislabelled them. `missingDigest: []`, `windowTruncated: false` (the 200-row window sufficed). The hub returned **13** agents and the pane rendered **6**, confirming the SIO-1665 `monitor-*` filter live. No horizontal scroll despite real ARNs and log-group names.

### 5. Measure, don't eyeball (check 9)

In devtools console, with the pane open:

```js
const picker = document.querySelector('[class*="max-h-"]');
const digest = document.querySelector('.flex-1.overflow-y-auto.min-h-0');
({ picker: picker.getBoundingClientRect().height,
   digest: digest.getBoundingClientRect().height,
   digestWins: digest.getBoundingClientRect().height > picker.getBoundingClientRect().height })
```

Expected: `picker` ≈ 176, `digestWins: true` at every window height. Reference figures from the SSR measurement — digest 182px @560px pane, 262px @640px, 502px @880px.

## Risks and edge cases

| Risk | Status after the live run | Mitigation |
|---|---|---|
| Two hubs render one card, or cards collide | **STILL OPEN** — untested | Check 6. If broken, new ticket; the `{#each scoped}` at `PiFleetPane.svelte:289` is the suspect |
| Monitor changes its digest wording | **Open**, low likelihood / high impact | `DIGEST_MARKER` is a substring match; a reworded header silently disables anchoring and everything lands in `missingDigest`. Nothing alerts on this |
| `[warn]` digest not marked | **Open but unit-tested** | Not reachable live (all digests were `[info]`). Re-check on a day an account is paused or degraded |
| Estate with no digest in window | **Open but unit-tested** | Not reachable live (`missingDigest: []`) |
| Real digest markdown breaks the layout | **CLOSED** — verified live | `noHorizontalScroll: true` with real ARNs and log-group names |
| Sticky header transparent against rows | **CLOSED** — verified live | Held at offset 0 with the picker scrolled 103px; `bg-tommy-cream` opaque |
| Picker outgrows the digest | **CLOSED** — verified live | 176px vs 565px at a 720px window |
| Tunnel drops mid-check | Operational | Hub errors render inline per row; re-run `just hub-tunnel` |
| A real prd token left in a worktree `.env` | **Operational, important** | The repo is public. `git check-ignore -v .env` before starting; delete `.env` and any cached token file at teardown |

## Out of scope

- **Changing the picker cap again.** SIO-1715 measured and settled it. A 4-row (12.5rem) cap was tested and rejected (still lost at 560px).
- **Parsing severity out of the digest body.** Deliberate: no severity field on the wire, and parsing agent prose would cross the "hub replies are data" line. That needs the monitor to emit structured fields — a separate ticket if wanted.
- **`FleetInboxCard.svelte`** — the in-chat digest card, a different component, untouched by all three PRs.
- **Pane width** (`w-2/5 max-w-xl`, `+page.svelte:738`) — the complaint was always vertical.

## Related code references

- `apps/web/src/lib/server/pi-fleet.ts:75-108` — `anchorOnDigest`, marks `isDigest` (`:106` is the marking line)
- `apps/web/src/lib/server/pi-fleet.ts:464-477` — field-by-field response mapping (`isDigest` carried at `:476`); **a new field must be named here or it is silently dropped**
- `apps/web/src/lib/pi-fleet-types.ts` — `PiFleetInboxMessageSchema.isDigest`
- `apps/web/src/lib/components/PiFleetPane.test.ts` — 34 SSR tests, incl. the sticky-header and rem-cap guards
- `apps/web/src/lib/server/pi-fleet.test.ts` — digest-marking cases (anchor only, `[warn]`, `missingDigest`, one per estate)
- `packages/pi-coms/scripts/monitor/report.ts:275-276` — where both digest headers are built

## Memory references

- `reference_fleet_pane_live_verification_config` — **the corrected setup facts from the live run** (project=pi-coms-prd, the sender-prefix reuse, AWS_ESTATES, IPv6-only bind)
- `reference_fleet_pane_pinning_is_region_not_content` — "pinned" meant a capped scroll region, not pinned content; why a tall-viewport probe proves nothing
- `reference_sio1712_digest_anchor_and_contrast` — `isDigest` is server-side; the cream/offwhite contrast table
- `reference_worktree_web_server_replay_env` — env gaps when running a web server from a worktree
- `reference_pi_coms_send_403_name_not_allowed` — the pane-token failure mode
- `reference_sio1650_pi_fleet_pane` — the pane's original seams
- `feedback_always_kill_own_background_processes_safely` — kill by tracked PID, never `pkill`
