# HANDOFF: fleet pane session, 2026-09-12 - what shipped and what is open

- **Date**: 2026-09-12
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Repo state**: `main` @ `324f3ec98953914a992341c16167bac54579ce2a`, clean and in sync with origin
- **Fleet bundle**: published `dbbcab9f` to `s3://pi-coms-dist-399987695868/fleet/`, rolled out and verified on both hub-account hosts

This is a **completed-work summary**, not a task handover. No branch to pick up. The two open items each have their own file:

- `HANDOFF-2026-09-12-SIO-1711-ingestion-quiet-hours.md`
- `HANDOFF-2026-09-12-SIO-1710-cloudtrail-not-logging.md`

## What shipped - six issues, all merged and Done

| Issue | Change | Merge |
|---|---|---|
| [SIO-1704](https://linear.app/siobytes/issue/SIO-1704) | No estate selected shows no spokes; ops inbox scoped to selection | `adf1b613` |
| [SIO-1705](https://linear.app/siobytes/issue/SIO-1705) | Inbox anchors per estate on its own daily digest, server-side | `985d22fe` |
| [SIO-1706](https://linear.app/siobytes/issue/SIO-1706) | "Open the fleet console" button removed; Pi mark on the toggle | `985d22fe` |
| [SIO-1707](https://linear.app/siobytes/issue/SIO-1707) | Hub row labelled `HUB`, distinct from its same-named spoke | `8d0dd752` |
| [SIO-1708](https://linear.app/siobytes/issue/SIO-1708) | No spoke selected sends to every spoke in scope | `dbbcab9f` |
| [SIO-1709](https://linear.app/siobytes/issue/SIO-1709) | Replies render as markdown; SSR sanitization gap closed | `324f3ec9` |

PRs #740, #741, #742, #743, #744.

## Decisions worth not re-litigating

**An empty estate selection means nothing is in scope** (SIO-1704). SIO-1703 originally treated it as "no narrowing" and showed the whole fleet; I defended that as avoiding an outage-looking UI. The operator overruled it, correctly: it let someone who had deselected everything still address any account. The outage concern is answered by wording (`"No AWS estate selected"`), not by showing the fleet. A hub whose list the scope emptied says **"No spoke here is in the selected scope"**, never "No spokes are registered" - the spokes *are* registered.

**The inbox anchors per estate, not fleet-wide** (SIO-1705). The six monitors write their digests seconds apart (00:00:02 through 00:00:34), so one shared cutoff would drop the earlier accounts' digests from view. Per-estate costs a clean chronological cut across accounts; that trade was made deliberately.

**Scoping lives server-side.** `readFleetMailbox` takes the estate list because it decides *which* rows to fetch. The SIO-1704 client-side filter was removed: filtering after a fixed cap hid rows that were never fetched. Same reasoning for the SIO-1708 fan-out - the component passes its visible targets rather than the store recomputing them.

**This pane IS the fleet console** (SIO-1706). There is no second destination. SIO-1702 had rewritten the button's label to name its destination instead of asking whether the destination existed. The `pi-fleet-console` agent still exists and is reachable from the header agent control.

**"Replies are data" means never MODEL INPUT, not never formatted** (SIO-1709). Rendering markdown for a human does not breach the PR #682 invariant; `wrapUntrusted` remains the only place a hub reply reaches a model.

## The one non-obvious thing a future session should know

`apps/web/src/lib/markdown.ts` sanitized only when `DOMPurify.isSupported` - **false outside a browser**, where it fell through to raw HTML. Probed before changing anything:

```
DOMPurify.isSupported here: false
output: <img src=x onerror=alert(1)><script>alert(2)</script>
contains onerror: true | contains <script: true
```

That was acceptable for chat (whose SSR output never ships) but not for the fleet pane, which server-renders agent-authored text about production accounts. Now on `isomorphic-dompurify`, which sanitizes in both environments. **Any future server-rendered untrusted markdown is safe by default** - do not reintroduce an environment-dependent guard.

A caution attached to that: the SSR sanitization test only fails if you revert the **dependency**. Reverting just the `isSupported` guard leaves it passing, because `isomorphic-dompurify` makes the guard a no-op. My first revert-check did exactly that and passed, which would have proved nothing.

## Process notes - two mistakes made and corrected

**An invented ticket ID reached four committed comments.** A previous turn used `SIO-1704` without reading it from Linear; it was only exposed when Linear later assigned that number to a genuinely new issue. Corrected to SIO-1703, where that work actually shipped. This is what SIO-1292 exists to prevent, and undoing it cost a commit.

**A commit landed on local `main`.** The branch was created in the worktree while the edits were made in the main checkout, which was still on `main`. Caught before any push - moved to a branch and `main` reset to `origin/main`. Nothing reached the remote. **Check `git branch --show-current` in the checkout you are actually editing.**

## Environment facts confirmed live

- **The hub account runs a spoke too.** `eu-shared-services-prd` is both the hub key and one of its own peers - that name genuinely appears twice and means two different things. This is why SIO-1707 labels the row by role rather than renaming either.
- **No `monitor-*` entries reach the spoke list.** The SIO-1665 server-side filter works; `/api/pi/agents` returns six peers, all account spokes.
- **`aws ssm send-command --targets` reports `TargetCount: 0` before targets resolve.** `list-commands` a moment later showed `2 / Success`. Do not re-issue on the initial `0`.
- **The SSM rollout reaches only the 2 hub-account instances.** The five spoke accounts converge on their own State Manager schedule (30 min).
- **Bundle paths differ per host role**: `/home/piagent/pi-coms` (spoke), `/home/comshub/pi-coms` (hub). Never `/opt`.

## Open items

| Ticket | State | Handover |
|---|---|---|
| [SIO-1710](https://linear.app/siobytes/issue/SIO-1710) | Backlog, undiagnosed | `HANDOFF-2026-09-12-SIO-1710-cloudtrail-not-logging.md` |
| [SIO-1711](https://linear.app/siobytes/issue/SIO-1711) | Backlog, options not yet chosen | `HANDOFF-2026-09-12-SIO-1711-ingestion-quiet-hours.md` |

These two are connected: SIO-1711's false positives consume the monitor's per-day investigation budget, which is part of why SIO-1710's two criticals sat `[uninvestigated]`. Fixing SIO-1711 makes SIO-1710-class findings more likely to get looked at automatically.

## Housekeeping

- No dev server left running; port 5173 free. An orphaned vite process from an earlier restart was also killed.
- The MCP servers on 9080/9082/9084/9085/9086/3001 were **not** started by this session and were left alone.
- The worktree `.claude/worktrees/data-sync-failure-eu-dev-5cfd11` is still on the merged branch `simonowusupvh/sio-1705-inbox-digest-anchor`, whose remote is deleted. Safe to remove whenever wanted.
- `.pi/` is untracked in the main checkout and pre-dates this session.
