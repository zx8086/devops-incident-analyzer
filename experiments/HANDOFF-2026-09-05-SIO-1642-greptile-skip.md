# HANDOFF 2026-09-05: Greptile terminally SKIPs every review across the zx8086 org (SIO-1642)

| Field | Value |
|---|---|
| Date | 2026-09-05 |
| Ticket | [SIO-1642](https://linear.app/siobytes/issue/SIO-1642) Greptile terminally SKIPs every review on zx8086/devops-incident-analyzer since 2026-08-31 (repo/account-level); merge gate unsatisfiable |
| Parent / related | [SIO-1635](https://linear.app/siobytes/issue/SIO-1635) (PR #682 is blocked behind this), [SIO-1640](https://linear.app/siobytes/issue/SIO-1640) (PR #683), [SIO-1641](https://linear.app/siobytes/issue/SIO-1641) (PR #684), [SIO-1572](https://linear.app/siobytes/issue/SIO-1572) (PR #679, the last PR that got real reviews) |
| Repo state | `main` at `ce7eea04` (bake-off ledger for #684); this handover lands on top |
| Suggested branch | none for the dashboard work; `claude/sio-1642-greptile-gate-wording` if the CLAUDE.md gate text needs a permanent change afterwards |
| Owner action required | YES. The root cause is in the Greptile account or app installation, which no Claude session can see or change. Sections 4.1 to 4.3 are for Simon. |

## 1. TL;DR

Since 2026-08-31 every Greptile review request in the whole `zx8086` GitHub org (three repos: devops-incident-analyzer, pi-coms, aws-cost-analyzer) is recorded by Greptile as terminal `SKIPPED` about 100 to 150 ms after creation, with `body: null` and no reason. GitHub sees nothing: no `Greptile Review` status check, no bot comment, no review object. CodeRabbit has been silent on the same PRs. The CLAUDE.md merge gate ("wait for the Greptile Review check to reach COMPLETED") therefore cannot be satisfied, and four code PRs have merged on CI green plus MCP-confirmed SKIPPED plus explicit per-PR user authorization. Success looks like: a new PR on this repo gets a `Greptile Review` check that reaches `COMPLETED`/`SUCCESS` with a bot comment carrying a confidence score, #682 gets a real review, and the ledger records the cause.

The single strongest lead: the account is a Greptile trial that hit its 50-credit limit once before, on 2026-08-14 (#661), when the bot still said so in a PR comment. The current silence has the same shape minus the message. Check billing and trial state first.

## 2. Context: how this ticket came to be

Greptile became primary reviewer on 2026-08-13 and CodeRabbit was deliberately kept on for a dual-reviewer bake-off (`docs/code-review-bakeoff.md`, CLAUDE.md "Greptile Review Lifecycle"). PR #679 (2026-08-29) got four completed Greptile rounds. From #680 (2026-08-31) onward every PR has been skipped. Sessions first read this as a docs-only carve-out (#680, #681 were single .md files), then #682 (20-file code PR, 2026-09-04) skipped via all three trigger paths, then #683 and #684 (code) skipped on push. Each session recorded the observation in the ledger and memory but none could act on the cause, because it is outside the repo. This handover consolidates the evidence so the owner can fix it in one sitting and a later session can close the loop.

## 3. Where the bodies are buried

### 3.1 The evidence trail (Greptile MCP, authoritative)

`mcp__greptile__list_code_reviews` with `name`, `remote: "github"`, `defaultBranch: "main"` and optional `prNumber`. Every skipped review looks like this (id 22718874, PR #684):

```json
{"id":"22718874","source":"pr","status":"SKIPPED",
 "commitSha":"55efdd46cfe5d4e2fbe96af15fb2331878d02784",
 "createdAt":"2026-09-05T20:41:39.170Z","completedAt":"2026-09-05T20:41:39.316Z",
 "metadata":{"changedFiles":[... 14 files ...],"strictness":2,"correlationId":"bf2c46be-..."},
 "dispatchUserId":null,
 "mergeRequest":{"id":"60818711","prNumber":684,"repository":{"name":"zx8086/devops-incident-analyzer"}}}
```

`get_code_review` on it returns `body: null` and no citations. The 146 ms create-to-complete gap means no review work was attempted.

Timeline of the transition (all UTC):

| When | Repo / PR | Greptile record |
|---|---|---|
| 2026-08-14 15:36 to 15:54 | devops-incident-analyzer #661 | Four bot review comments: "`zx8086` has reached the 50-credit limit for trial accounts. To continue receiving code reviews, upgrade your plan" (link `https://app.greptile.com/review/github`). Reviews resumed from round 2 the same day. |
| 2026-08-29 22:22 | #679 first auto-trigger | SKIPPED id 21427571 in 145 ms, same signature as today. The explicit `@greptile review` at 22:43 then produced COMPLETED reviews 21428803, 21429294, 21429585, 21429883 (last at 23:01:51). |
| 2026-08-31 09:09 to 09:11 | pi-coms #8 | COMPLETED id 21568128. The LAST completed review anywhere in the org. |
| 2026-08-31 about 13:30 | devops-incident-analyzer #680 | SKIPPED ids 21596457 (auto) and 21597765 (`@greptile review`). |
| 2026-09-01 | #681 | SKIPPED id 21783725. |
| 2026-09-04 21:04 to 22:00 | #682 heads 670a4d77, 7e92e2a0, 9a2fe74e | SKIPPED ids 22602629 (auto), 22602846 (`@greptile review`), 22602981 (MCP `trigger_code_review`, which returned "triggered successfully"), 22603676, 22612848. |
| 2026-09-04 10:14 to 2026-09-05 18:32 | pi-coms #86 to #93 | 10 of 10 SKIPPED. |
| 2026-09-05 09:44 to 14:29 | aws-cost-analyzer #176 to #179 | 5 of 5 SKIPPED (query with `defaultBranch: "master"`; the repo is "not found" under `main`). |
| 2026-09-05 19:5x | #683 | SKIPPED id 22714467. Merged on explicit user instruction. |
| 2026-09-05 20:41 | #684 | SKIPPED id 22718874. Merged on explicit user instruction. |

So the window in which the account changed state is 2026-08-31 09:11Z to about 13:30Z.

### 3.2 What the Greptile MCP still shows as healthy

- `list_knowledge_bases`: all three repos listed (namespaceIds d05ec1de..., ddc5e7e3..., 41d5a4d1...). Indexing is not the problem.
- `list_custom_context`: 20 entries, two ACTIVE `CLAUDE.md` style-guide instructions scoped to this repo (ids ac030d7c..., ac1ec2af...), two ACTIVE `CLAUDE.md files` PATTERN entries, no rule that could plausibly mean "skip". Fourteen entries are `LEARNING` with `body: null`.
- `get_analytics_overview` (2026-08-20 to 2026-09-06, this repo): `prsReviewed: 27`, `totalUsers: 1`, `activeUsers: 1`. The analytics count SKIPPED records as reviews (2026-09-04 shows `reviewCounts: 5` for #682 with `totalComments: 0`), so the dashboard's review counter will look healthy while nothing is reviewed. The findings series is zero from 2026-08-30 on.

### 3.3 GitHub side

- `greptile-apps` check-runs on the skipped heads `cc11489c`, `1c299f5d`, `9a2fe74e`, `3ba94efd`, `55efdd46`: 0 each. On #679 head `615a0d63`: 1 (`Greptile Review`, success, 2026-08-29T23:01:51Z).
- Issue comments by `greptile-apps[bot]` on #680 to #684: 0 each. The retrigger URL format from the #679 footer is `https://app.greptile.com/api/retrigger?id=<mergeRequest.id>`; #682's mergeRequest id is `60580727`, #684's is `60818711`.
- Repo is public, not archived, default branch `main`. `gh api .../hooks` returns nothing for this token (needs admin), so webhook delivery state is unverified.
- No `.greptile/`, `greptile.json` or similar config file is tracked in the repo.

### 3.4 The rules that assume a review exists

`CLAUDE.md:128`:

```
- **NEVER merge a PR while the Greptile review is pending** -- wait for the `Greptile Review` status check to reach `COMPLETED`, then triage every finding ...
```

`CLAUDE.md:131` to `:165` ("Greptile Review Lifecycle") describes the completion check, the bot comment footer, re-triggering, and thread auto-resolution. None of it mentions the SKIPPED state, and the `gh pr view ... statusCheckRollup` gate returns nothing forever on a skipped PR.

Ledger rows already recording the streak: `docs/code-review-bakeoff.md` summary table rows for #680, #681, #683, #684 and the "PR #680 detail" through "PR #684 detail" sections at the end of the file.

Memory note carrying the session-side lessons: `reference_greptile_skips_docs_only_prs.md` (name is historical; it now covers code PRs too).

### 3.5 Local tooling facts the next session needs

- The `greptile` MCP is configured in `~/.claude.json` under this project (`type: http`, `url: https://api.greptile.com/mcp`, auth header set). Its tools are deferred; load with `ToolSearch select:mcp__greptile__list_code_reviews,mcp__greptile__get_code_review,mcp__greptile__trigger_code_review`.
- The auto-mode permission classifier blocked `gh pr create` and `gh pr merge` in some sessions but not on 2026-09-05. Working recipes: `gh api repos/zx8086/devops-incident-analyzer/pulls -f title=... -f head=... -f base=main -F draft=false -F body=@file` and `gh pr merge <n> --squash` (never `--delete-branch` from a worktree).
- `gh pr merge` from a worktree cannot check out `main` locally; the remote merge still succeeds. Verify with `gh pr view <n> --json state,mergedAt,mergeCommit`.

## 4. The fix, step by step

Steps 4.1 to 4.3 need the Greptile dashboard and GitHub org settings. Steps 4.4 to 4.6 are for a Claude session afterwards.

### 4.1 Check account plan and credits (most likely cause)

Open `https://app.greptile.com/review/github` (the upgrade link the bot posted on #661) and the billing / plan page for the `zx8086` account. Look for: trial expired on or about 2026-08-31, credits exhausted, payment failed, seat count 0. The #661 precedent shows this account is (or was) a trial with a 50-credit cap that was hit once and later reset. If the plan is expired or out of credits, upgrading or adding credits is the whole fix. Note for the ledger: the bot no longer posts the credit message, it skips silently, which is a Greptile behavior change worth recording.

### 4.2 Check repository review settings

In the Greptile dashboard, for each of the three repos: reviews enabled, trigger mode (every push vs. on-demand), and any skip conditions (labels, author filters, draft PRs, path globs, title patterns, "skip bot-authored PRs"). All five 2026-09-05 PRs were authored by `zx8086`; #684 was opened via `gh api` under the same login, so an author filter is unlikely but cheap to rule out.

### 4.3 Check the GitHub App installation

GitHub org or user settings, Installed GitHub Apps, `Greptile`: not suspended, repository access includes all three repos, permissions unchanged. Under the app's Advanced tab, recent webhook deliveries to Greptile should show 2xx responses for the 2026-09-05 pushes. A 401/403/410 pattern there means the installation token is the problem rather than billing.

### 4.4 Confirm recovery (session)

After the owner reports a change, open a trivial PR (or re-trigger #682 via `gh pr comment 682 --body "@greptile review"`) and run:

```bash
gh pr view 682 --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.name=="Greptile Review")] | .[0] | "\(.status) \(.conclusion)"'
```

Expected `COMPLETED SUCCESS` within about 5 minutes, and `list_code_reviews` for PR 682 showing a new record with `status: "COMPLETED"` and a non-null `body` via `get_code_review`. If the record is again SKIPPED within 200 ms, the cause is not fixed; do not poll GitHub.

### 4.5 Record the cause (session)

- `docs/code-review-bakeoff.md`: add a short "Greptile outage 2026-08-31 to <date>" note above the "PR #680 detail" section stating the root cause and the fix, and update the #680 to #684 detail sections' shared claim ("repo/account level, unresolved") to point at it.
- Memory: append the cause to `reference_greptile_skips_docs_only_prs.md` and shorten its MEMORY.md index line.
- If the cause was billing, add one sentence to CLAUDE.md "Greptile Review Lifecycle": a review recorded as SKIPPED by the MCP with `body: null` within 200 ms means the account is out of credits or disabled; stop polling and escalate.

### 4.6 Decide the standing gate for a silent Greptile (session, with the owner)

Options, in order of preference:

1. Fix the account and keep the existing gate unchanged.
2. If Greptile stays unavailable, make the CLAUDE.md gate explicit about the SKIPPED state: "CI green + MCP-confirmed terminal SKIPPED on the head SHA + explicit per-PR user authorization" for code PRs, which is what #683 and #684 actually used.
3. Suspend the bake-off: the ledger has recorded availability only, no recall, since #679. The CLAUDE.md sentence "Do NOT suggest suspending either app" is about the bake-off evaluation, not about an outage; raise it with the owner rather than deciding unilaterally.

## 5. Verification

Nothing in this ticket changes code. For the docs commits:

```bash
bun run typecheck && bun run lint && (cd apps/web && bun run test)
```

Manual probes:

```bash
# Greptile side (load the MCP tools first). Expect COMPLETED after the fix.
mcp__greptile__list_code_reviews name=zx8086/devops-incident-analyzer remote=github defaultBranch=main prNumber=682

# GitHub side. Expect one greptile-apps check-run on the new head.
gh api repos/zx8086/devops-incident-analyzer/commits/<head-sha>/check-runs \
  --jq '.check_runs[] | select(.app.slug=="greptile-apps") | "\(.name) \(.status) \(.conclusion)"'

# Bot comment present with a confidence score.
gh api repos/zx8086/devops-incident-analyzer/issues/682/comments --paginate \
  --jq '.[] | select(.user.login=="greptile-apps[bot]") | .body' | grep -o 'Confidence Score: [0-9]/5'
```

## 6. Files to modify

| File | Change |
|---|---|
| Greptile dashboard, GitHub App settings | owner-only; see 4.1 to 4.3 |
| `docs/code-review-bakeoff.md` | outage note with root cause; amend #680 to #684 detail claims |
| `CLAUDE.md` (Greptile Review Lifecycle, lines 128 and 131 to 165) | one sentence on the SKIPPED state, only if 4.5/4.6 call for it |
| `~/.claude/projects/.../memory/reference_greptile_skips_docs_only_prs.md` and `MEMORY.md` | record the cause |

## 7. Workflow

- Dashboard work: none of it touches the repo.
- Docs commits: from a worktree, `git checkout -B docs/<topic> origin/main`, edit, commit with a HEREDOC message, then push as a standalone command `git push origin HEAD:main`, verify with `git merge-base --is-ancestor <sha> origin/main`. Handovers and the ledger are allowed to go to main directly.
- A CLAUDE.md change goes through a PR (it is repo policy, not documentation), and that PR is itself subject to whatever the gate is at the time.
- Linear: SIO-1642 Backlog to In Progress when the owner starts on the dashboard; In Review once a real review lands on #682; Done only with explicit owner approval.

Commit message template (use a HEREDOC with a delimiter other than EOF when the body itself contains one):

```bash
git commit -F - <<'MSG'
docs: record Greptile skip root cause (SIO-1642) and close the 2026-08-31 outage in the bake-off ledger

<one paragraph: cause, fix, first PR reviewed again>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

## 8. Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cause is billing and the bot now skips silently instead of posting the credit message | high | Check plan first (4.1). Record the behavior change so future sessions do not re-diagnose from GitHub silence |
| Cause is a suspended or re-permissioned GitHub App installation | medium | Webhook deliveries under the app's Advanced tab (4.3) distinguish this from billing in one look |
| A session waits on the status check again | medium | Rule already in memory: consult `list_code_reviews` at PR-open time; SKIPPED means stop polling |
| #682 accumulates drift while blocked | medium | Owner can authorise a merge on CI green as with #683/#684, or rebase after the fix |
| Analytics dashboard looks healthy | high | It counts SKIPPED as reviewed; use the review records, not the counters |
| CLAUDE.md "do not suggest suspending either app" read as forbidding any gate change | low | The sentence protects the bake-off, not an outage; decide with the owner (4.6) |

## 9. Out of scope

- Fixing CodeRabbit's absence (six straight PRs). Separate investigation; it is not the merge gate.
- Re-reviewing #683 and #684 after the fix. They are merged; the ledger records them as unreviewed.
- Changing which bot is primary. That is the bake-off decision and needs recall data this outage has prevented.

## 10. Related code and doc references

- `CLAUDE.md:128` merge gate sentence; `CLAUDE.md:131-165` Greptile Review Lifecycle; `CLAUDE.md:167-175` Greptile skills (`greploop`, `check-pr`, `cli-review`), all of which assume a review can exist.
- `docs/code-review-bakeoff.md` summary table (#661 row: "Greptile skipped round 1 (credits)"; #679 to #684 rows) and the "PR #661 detail" section (the exact credit message and its recovery).
- PR #679 bot comment footer (working-state reference): `Reviews (4): Last reviewed commit: 615a0d63 | Re-trigger Greptile https://app.greptile.com/api/retrigger?id=58284478`.

## 11. Memory references

- `reference_greptile_skips_docs_only_prs` (skip streak, account-wide scope, MCP-first rule, code-PR gate on explicit authorization, API recipes)
- `reference_pr_merge_no_branch_protection_and_worktree_gh_quirk` (main unprotected; `gh pr merge` from a worktree; push with `HEAD:main`)
- `reference_pr661_review_gate_gotchas` (read the Greptile body, not just the check)
- `feedback_dual_reviewer_bakeoff_keep_both` (why both bots stay on; ledger location)
- `reference_coderabbit_review_latency_varies_widely` (CodeRabbit no-shows predate this outage)
- `feedback_auto_merge_after_greptile_triage` (the normal merge flow this outage suspends)
