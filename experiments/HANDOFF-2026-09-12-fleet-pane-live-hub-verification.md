# HANDOFF 2026-09-12 — fleet pane live-hub verification (SIO-1712 / 1714 / 1715)

| | |
|---|---|
| **Date** | 2026-09-12 |
| **Tickets** | [SIO-1712](https://linear.app/siobytes/issue/SIO-1712), [SIO-1714](https://linear.app/siobytes/issue/SIO-1714), [SIO-1715](https://linear.app/siobytes/issue/SIO-1715) — all **Done**, all merged |
| **PRs** | [#745](https://github.com/zx8086/devops-incident-analyzer/pull/745) `fe59e39d` · [#748](https://github.com/zx8086/devops-incident-analyzer/pull/748) `54b876ed` · [#749](https://github.com/zx8086/devops-incident-analyzer/pull/749) `2ccc96e3` |
| **Repo state** | all three merged to `main`; `origin/main` tip `2ccc96e3` |
| **Suggested branch** | none — this is a **verification** task. Only branch if it finds a bug (then a new ticket, not a reopen). |

## TL;DR

Three merged PRs reworked the pi-fleet pane's ops-inbox rendering: the digest moved to the main scroll region and is now labelled as the anchor, the hub header is sticky, and the picker is capped in `rem`. **Every claim rests on SSR renders measured in a headless browser — none of it has been exercised against a live pi-coms hub**, because the worktree it was built in has no `.env` and the pane never mounts without one. Success here means opening the pane against a real tunnelled prd hub and confirming the digest, the sticky header and the multi-hub case behave as the fixtures predicted. The highest-risk gap is **two or more hubs with mailboxes loaded at once** — that path has only ever seen a single-hub fixture.

## Context — how this came to be

The operator reported (with screenshots) that the Inbox ops response was unreadable: clipped mid-sentence, with the spoke list scrolled away above it. SIO-1712 moved the digest card out of the height-capped picker; SIO-1714 marked the digest server-side and pinned the hub header; SIO-1715 replaced the picker's percentage cap with a `rem` cap after measuring that a percentage gave the target list more room than the report on a laptop-sized window.

All three were verified by rendering `PiFleetPane` via `svelte/server` and measuring the result with `getBoundingClientRect()` in the in-app browser. That proves layout and markup. It does **not** prove the wiring: hub listing, mailbox fetch, anchoring against real monitor output, or the pane's behaviour with more than one hub.

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

### 2. Create a worktree `.env` with the two hub variables

`PI_COMS_HUBS` alone is **not** always enough. On a directory-mode hub the pane registers short-lived senders as `pi-fleet-<8 hex>`, which needs its own principal and token per hub (`.env.example:464-470`):

```bash
# only if the hub is directory-mode
just token-create pi-fleet "pi-fleet-*" service eu-shared-services-prd
```

Then in the worktree `.env`:

```bash
PI_COMS_HUBS='{"eu-shared-services-prd":{"serverUrl":"http://127.0.0.1:8788","authToken":"<prd token>","environment":"prd","estates":["eu-oit-prd","eu-mendix-platform-prd"]}}'
PI_COMS_PANE_TOKENS='{"prd":"<pi-fleet token on the prd hub>"}'
```

Unset `PI_COMS_PANE_TOKENS` only if the hub is token-mode — otherwise sends fail `403 name_not_allowed` (see `reference_pi_coms_send_403_name_not_allowed`).

### 3. Start a web server FROM THE WORKTREE, on a non-default port

The operator's own dev server on :5173 runs **main-repo** code. Check the port first, never kill a server you did not start:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

```bash
bun run --filter @devops-agent/web dev -- --port 5174
```

Track the PID at spawn and kill it by that PID when done; prove the port is free with `lsof -nP -iTCP:5174 -sTCP:LISTEN`. See `reference_worktree_web_server_replay_env` for the env gaps that silently make a worktree replay useless (they bite the agent path, not the pane, but the same server is in play).

### 4. What to actually check

Select an AWS estate first — per SIO-1704 the pane shows nothing without one, and its selector row is part of why the pane is short.

| # | Check | Expected |
|---|---|---|
| 1 | Click `Inbox ops` | Digest renders full-width in the lower region, **not** clipped at a boundary |
| 2 | The anchor row | Carries a `DAILY DIGEST` chip; rows after it are indented under a left rule |
| 3 | A `[warn]` digest (paused/degraded account) | Still marked as the digest — the chip is not `[info]`-only |
| 4 | An estate with no digest in the window | **Nothing** is labelled digest; the amber `missingDigest` note appears; findings still shown in full |
| 5 | Scroll the spoke list with 6 spokes | `PRD / HUB / account / Inbox ops` stays pinned; the last spoke is still selectable |
| 6 | **Two hubs, both mailboxes loaded** | Two separate `<details>` cards, each labelled with its own hubKey; collapsing one does not affect the other |
| 7 | Collapse/expand a card by keyboard | `<details>` toggles on Enter/Space; the summary keeps its `N reports` count |
| 8 | Click Refresh | Icon spins, button disables, re-enables on completion |
| 9 | Shrink the browser to ~900px tall | Digest region still taller than the picker (picker pinned at 176px) |

**Check 6 is the priority.** Every fixture used a single hub; the multi-card path is the least-proven code in the three PRs.

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

| Risk | Likelihood | Mitigation |
|---|---|---|
| Two hubs render one card, or cards collide | **Medium** — untested path | Check 6. If broken, new ticket; the `{#each scoped}` at `PiFleetPane.svelte:289` is the suspect |
| Real digest markdown breaks the layout (wide ARN, long log group) | Medium | Body has `overflow-x-auto break-words`; confirm no horizontal scrollbar on the pane itself |
| `[warn]` digest not marked | Low — covered by a unit test | Check 3 |
| Sticky header transparent against rows | Low | `bg-tommy-cream` must match the pane wrapper (`+page.svelte:738`); check while scrolling |
| Monitor changes its digest wording | Low, high impact | `DIGEST_MARKER` is a substring match; a reworded header silently disables anchoring — everything would land in `missingDigest` |
| Tunnel drops mid-check | Medium | Hub errors render inline per row; re-run `just hub-tunnel` |

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

- `reference_fleet_pane_pinning_is_region_not_content` — "pinned" meant a capped scroll region, not pinned content; why a tall-viewport probe proves nothing
- `reference_sio1712_digest_anchor_and_contrast` — `isDigest` is server-side; the cream/offwhite contrast table
- `reference_worktree_web_server_replay_env` — env gaps when running a web server from a worktree
- `reference_pi_coms_send_403_name_not_allowed` — the pane-token failure mode
- `reference_sio1650_pi_fleet_pane` — the pane's original seams
- `feedback_always_kill_own_background_processes_safely` — kill by tracked PID, never `pkill`
