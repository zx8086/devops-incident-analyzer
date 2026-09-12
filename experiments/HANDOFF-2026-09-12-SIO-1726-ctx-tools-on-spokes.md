# HANDOFF 2026-09-12 — SIO-1726: ctx_* tools do not reach a spoke turn

- **Date**: 2026-09-12
- **Tickets**:
  - [SIO-1726](https://linear.app/siobytes/issue/SIO-1726) — ship context-mode to the fleet spokes behind a kill-switch (**In Review, BLOCKED**)
  - [SIO-1725](https://linear.app/siobytes/issue/SIO-1725) — three aws-spoke investigation skills (**In Review, DONE and verified — mergeable now**)
  - Parent epic: [SIO-1686](https://linear.app/siobytes/issue/SIO-1686) — context-mode concepts feasibility
  - Closed as duplicate: [SIO-1731](https://linear.app/siobytes/issue/SIO-1731) → already fixed by [SIO-1728](https://linear.app/siobytes/issue/SIO-1728)
- **PR**: [#759](https://github.com/zx8086/devops-incident-analyzer/pull/759)
- **Repo state**: branch `claude/context-mode-spokes-extension-a8ac32` @ `6ee0e37a`, clean tree, pushed. `main` is `0e1b0c75` (branch is 3 behind: two are the `just coms` fixed-extension-set commits, one a theme chore).
- **Upstream checkout**: `~/WebstormProjects/context-mode` @ `571ba5f` on branch `fix/pi-bridge-bootstrap-on-context` (a real git clone of `mksglu/context-mode` at 1.0.169 WITH TypeScript source — not pushed)
- **Suggested branch for continuation**: reuse `claude/context-mode-spokes-extension-a8ac32`

## TL;DR

**What's done**: SIO-1725's three skills are authored, exported, deployed and verified on both dev spokes. SIO-1726's install path works end to end — `bun add --ignore-scripts` into `~/.pi-ctx`, both `-e` flags on the live Pi process, the `CTX_MODE_ENABLED` kill-switch, and a vendored patched `extension.js` overlaid from the bundle.

**What's next**: the L2 gate still fails. Both spokes answer `no ctx tools` even with the patched extension confirmed on disk and loaded. The `context`-hook patch is proven correct in isolation (0 tools at load → 11 after the hook, tested against the built artifact) but is evidently not sufficient on the real spoke path. The remaining gap is between "patched extension loaded" and "tools reach the model on a followUp turn".

**Gotchas hit**: four separate false leads, all documented below — a grep that lied about `bun:sqlite`, a macOS install that passed for the wrong reason, a duplicate ticket for an already-landed fix, and a warm-up fix that hit the very gap it was meant to dodge.

## Context — how this came to be

The operator asked to extend context-mode to the deployed pi-coms AWS fleet spokes and to give them the same skills the local console has. SIO-1689 had already closed spoke context-mode with *no code* on the finding that Pi truncates bash output itself (re-verified: `DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES=50KB` in `dist/core/tools/truncate.js`). SIO-1686's "Do not do" list also forbids `better-sqlite3` and "No MCP server spawned from the Pi extension".

The operator explicitly overrode both prohibitions on new evidence (context-mode runs clean on `bun:sqlite`), so this work proceeds against them deliberately. That is recorded on SIO-1726 rather than glossed.

Originating spec: `docs/superpowers/specs/2026-09-10-context-mode-concepts-feasibility.md`.

## The core finding — why it works everywhere except a spoke

This is the one thing to carry forward. The operator's question was: *why does this work in Claude Desktop, the console and the IDE, but not on the spoke?*

context-mode registers its `ctx_*` tools **lazily, from Pi's `before_agent_start` hook**. That is deliberate upstream (#534/#809): CLI-only paths like `pi list` load the extension but must never spawn the MCP server.

`~/WebstormProjects/context-mode/src/adapters/pi/extension.ts:635` — the ONLY `ensureMCPBridge(...)` call site:

```ts
pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      _pendingContext = "";
      await ensureMCPBridge(isForegroundSession(ctx));
      if (!_sessionId) return;
```

Pi emits that event from exactly one place. `dist/core/agent-session.js:885` is the only `emitBeforeAgentStart` call in the file, and it lives inside `_runAgentPrompt`. The branch that decides:

```js
if (options?.deliverAs === "nextTurn") { ... }
else if (this.isStreaming && options?.triggerTurn !== false) {   // BUSY
    if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage);        // no hook emitted
    }
}
else if (options?.triggerTurn) {
    await this._runAgentPrompt(appMessage);      // hook emitted HERE
}
```

`isStreaming` is tested **before** `triggerTurn`. So `pi.sendMessage(msg, { deliverAs: "followUp", triggerTurn: true })` — what `packages/pi-coms/extensions/coms-net.ts:819` uses for every inbound message — takes the hook only when the agent happens to be idle.

**The asymmetry:** Claude Desktop, the console and the IDE are all interactive. The agent is idle when a human hits enter, so every turn goes through `_runAgentPrompt`, the hook fires, 11 tools register. A spoke runs `pi-monitor.service` alongside (verified `active` on both dev spokes) which keeps it mid-turn, so inbound messages take `agent.followUp()` and the hook never fires. **Same package, same version, same install — different path through Pi, decided by timing.**

## Where the bodies are buried

### Our repo (all committed on the branch)

`packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh` — the install, in the agent-user heredoc (runs under `bash -euo pipefail`, hence the guard):

```bash
if [ "${CTX_MODE_ENABLED:-}" != "false" ] && [ "${CTX_MODE_ENABLED:-}" != "0" ]; then
  CTX_DIR="$HOME/.pi-ctx"
  CTX_VERSION="1.0.169"
  if [ ! -f "$CTX_DIR/node_modules/context-mode/server.bundle.mjs" ] \
     || [ "$(cat "$CTX_DIR/.ctx-version" 2>/dev/null || echo none)" != "$CTX_VERSION" ]; then
    ...
    if (cd "$CTX_DIR" && bun add --ignore-scripts "context-mode@$CTX_VERSION"); then
```

`--ignore-scripts` is **required**, not cosmetic — see False lead 2.

Same file, the patch overlay (after the bundle unpack, because the patch rides in the bundle while the npm install runs earlier):

```bash
CTX_PATCH_FOR_VERSION="1.0.169"
CTX_PATCH_SRC="$AGENT_HOME/pi-coms/vendor/context-mode-patch/extension.js"
if ... && [ "$(cat "$AGENT_HOME/.pi-ctx/.ctx-version" ...)" = "$CTX_PATCH_FOR_VERSION" ]; then
  if ! cmp -s "$CTX_PATCH_SRC" "$CTX_EXT_INSTALLED"; then
    cp "$CTX_PATCH_SRC" "$CTX_EXT_INSTALLED"
```

Version-keyed on purpose: a `CTX_VERSION` bump must not silently overlay a build patched against another release.

Same file, the launcher (inside a `<<'LAUNCH'` **quoted** heredoc, so `$HOME` and `${VAR:-}` expand at launcher runtime — that is why build-time values use `*_PLACEHOLDER` + `sed`):

```bash
EXT_ARGS=(-e extensions/coms-net.ts)
CTX_EXT_PATH="$HOME/.pi-ctx/node_modules/context-mode/build/adapters/pi/extension.js"
if [ "${CTX_MODE_ENABLED:-}" != "false" ] && ... && [ -f "$CTX_EXT_PATH" ]; then
  EXT_ARGS+=(-e "$CTX_EXT_PATH")
fi
```

`packages/pi-coms/vendor/context-mode-patch/` — the vendored patched build (41KB) plus a README recording provenance, ELv2 attribution and the removal condition.

`packages/pi-coms/extensions/coms-net.ts:819` — the inbound delivery that triggers the bug. **Do not change its `followUp` semantics**: queueing behind a busy turn is what stops concurrent inbound work interleaving.

### Upstream checkout

`~/WebstormProjects/context-mode/src/adapters/pi/extension.ts:750` — the patch, on branch `fix/pi-bridge-bootstrap-on-context`:

```ts
pi.on("context", async (event: any, hookCtx: any) => {
    try {
      await ensureMCPBridge(isForegroundSession(hookCtx));
    } catch {
      // best effort — a bridge failure must never break context assembly
    }
    try {
      if (!_pendingContext) return;
      const ctx = _pendingContext;
```

Param is `hookCtx` deliberately — `ctx` is already bound to `_pendingContext` below and would shadow.

Rationale: `context` is wired into the agent as `transformContext` (`dist/core/sdk.js:220`) and consumed at `@earendil-works/pi-agent-core/dist/agent-loop.js:181-182`, which runs per model call regardless of turn path. `runner.emitContext` (`dist/core/extensions/runner.js:747`) **awaits** each handler and catches per-handler errors, which is what makes an async bootstrap safe there.

`~/WebstormProjects/context-mode/tests/pi-extension.test.ts` — two added cases in a `describe("MCP bridge bootstrap signal")` block. The first drives ONLY `context`, never `before_agent_start`, and asserts `ctx_*` names reach `pi.registerTool`.

## Current live state (verified 2026-09-12, both dev spokes)

| Check | eu-oit-dev | eu-shared-services-dev |
|---|---|---|
| bundle | `6ee0e37a` | `6ee0e37a` |
| `.ctx-version` | `1.0.169` | `1.0.169` |
| patched extension on disk (`hookCtx`) | 2 | 2 |
| skills installed | 5 | 5 |
| `-e` flags on live Pi | 2 | 2 |
| `pi-monitor.service` | active | active |
| **L2 gate (ask the spoke to use ctx_batch_execute)** | **`no ctx tools`** | **`no ctx tools`** |

So everything below the model layer is correct and the gate still fails.

## What is PROVEN (do not re-investigate)

- **context-mode runs on Bun.** `server.bundle.mjs` picks its SQLite driver at runtime via `["bun","sqlite"].join(":")`, so `grep bun:sqlite` finds nothing. Probes pass with `node_modules/better-sqlite3` **deleted outright**.
- **The bridge works on the spoke.** `bootstrapMCPTools(pi, serverBundle, { foreground: false })` called directly on eu-oit-dev returned `HANDLE_TOOLS: 11` and registered all eleven `ctx_*` names.
- **Runtime resolution is fine.** `resolveJsRuntimeForBridge()` → `bun`, `CONTEXT_MODE_BRIDGE_DEPTH` unset (no fork-bomb guard trip). No node/npm needed.
- **arm64 Linux is fine.** L1 (raw stdio `initialize` + `ctx_batch_execute`) passes on the spoke: `Indexed 1 sections. Searched 1 queries.`, `aarch64`, clean stderr.
- **bun:sqlite works inside Pi.** `~/.pi/context-mode/{sessions,content}` hold live `.db` + `-wal` files written during turns.
- **The patched build itself works.** Tested against the built artifact: 0 tools at extension load, **11 after invoking the `context` hook** (`ctx_execute, ctx_execute_file, ctx_index, ctx_search, ...`).
- **The patch reached the spokes.** Overlay logged `applied the patched context-mode extension`; file mtime 16:51:58, Pi started 16:52:01.
- **Pi's own truncation is real** (SIO-1689 was right): 2000 lines / 50KB, applied in `dist/core/tools/bash.js`.
- **RAM is a non-issue.** ~1.12GB available on `t4g.small` with the bridge running.
- **The full upstream suite passes with the patch**: 210 files, 4719 tests, 0 failures; `tsc --noEmit` clean.

## The open question

Why do the tools still not reach the model when the patched extension is loaded?

Candidates, none yet tested:

1. **Does `context` actually fire on the `followUp` path?** This is the load-bearing assumption of the patch and it was reasoned from source, never observed on a spoke. Verify by adding a temporary `pi.logger.warn` at the top of the `context` handler, rebuilding, deploying, and grepping the session JSONL after an inbound message.
2. **Tool-registry snapshot timing.** Pi may snapshot the tool set for a model call *before* `transformContext` runs, in which case registering during `context` is too late for that same call — tools would appear only from the *next* turn onward. Test: send two inbound messages and see whether the second one has them.
3. **The idle reaper.** `CONTEXT_MODE_BRIDGE_IDLE_MS` is armed for non-foreground sessions (`isForegroundSession` is `ctx?.hasUI !== false`, and a herdr-hosted spoke has no UI). A reaped child may leave registrations pointing at a dead bridge. Test: set `CONTEXT_MODE_BRIDGE_IDLE_MS=0` in `~/.coms-env.local` and retry.
4. **`refreshTools`.** Pi exposes `refreshTools` / `getActiveTools` / `getAllTools` on the runtime (`dist/core/extensions/runner.js:160-168`). If registration lands after a snapshot, calling `refreshTools` after bootstrap may be the missing step — and would be a better upstream fix than the `context` hook alone.

Candidate 2 is the most likely and the cheapest to falsify. Start there.

## Verification commands

Local, before any publish:

```bash
cd packages/gitagent-bridge && bun test          # 445 pass
cd packages/pi-coms && bun run test              # 375 pass -- NOTE: `bun run test`, not `bun test`
bun run typecheck                                # clean (grep for "error" matches the literal "0 ERRORS" line)
bash -n packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh
```

Upstream checkout:

```bash
cd ~/WebstormProjects/context-mode
bun install --ignore-scripts                     # npm install FAILS -- Arborist edgesOut, upstream #1139
npx tsc && npx vitest run tests/pi-extension.test.ts   # 70 pass
```

Publish + converge a dev spoke (needs `fleet.yaml`, which lives only in the MAIN checkout):

```bash
cd packages/pi-coms
bun scripts/fleet.ts publish --hub eu-shared-services-dev \
  --manifest ~/WebstormProjects/devops-incident-analyzer/packages/pi-coms/deploy/fleet.yaml
bun scripts/fleet.ts rollout eu-oit-dev --operator simon --manifest <same>
```

The L2 gate over the hub, non-interactively (`just coms` is a TUI and cannot be driven from a session):

```bash
# 1. token: the SSM parameter is a JSON RECORD -- send .token, not the whole blob
aws ssm get-parameter --name /pi-coms/auth/simon --with-decryption \
  --profile eu-shared-services-dev --region eu-central-1 --query Parameter.Value --output text \
  | python3 -c 'import sys,json;print(json.loads(sys.stdin.read().strip())["token"])'

# 2. tunnel on a NON-default local port (8787 is often already taken by another session)
aws ssm start-session --profile eu-shared-services-dev --region eu-central-1 \
  --target i-05d6f6ae51e5353ce --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8787"],"localPortNumber":["18787"]}' &

# 3. the sender MUST register first, under a name the token allows (simon/ops/laptop)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"project":"pi-coms-dev","session_id":"<ulid>","name":"simon","purpose":"probe","model":"cli","color":"#888","cwd":"/tmp","explicit":true}' \
  http://127.0.0.1:18787/v1/agents/register

# 4. send, then read the reply -- msg_id goes in the PATH, not a query param
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18787/v1/messages/<msg_id>
```

PASS is the spoke naming `ctx_batch_execute` and quoting its sandboxed output. `no ctx tools` means the gate still fails.

## Files to modify (if continuing)

| File | Change |
|---|---|
| `~/WebstormProjects/context-mode/src/adapters/pi/extension.ts` | add temporary diag logging; try `refreshTools` after bootstrap |
| `packages/pi-coms/vendor/context-mode-patch/extension.js` | re-vendor after each upstream rebuild |
| `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh` | only if the overlay or install needs changing |

## Workflow

Branch off `main` (or continue the existing branch, rebasing first — it is 3 behind). Linear: SIO-1726 stays **In Review** until the L2 gate passes; do not set Done without operator approval. Commit format `SIO-XXXX: message`, PRs ready-for-review not draft.

```bash
git commit -F - <<'MSG'
SIO-1726: <what changed>

<why, with the file:line evidence>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Vendored patch drifts from upstream | Medium | overlay is keyed to `CTX_VERSION=1.0.169`; a bump skips it rather than mis-patching |
| We now own a forked ELv2 build | Certain (accepted) | README records provenance + removal condition; drop it when upstream releases |
| `CTX_VERSION` bump silently loses the patch | Low | version gate makes it a no-op, not a wrong patch — but `ctx_*` would vanish silently. Re-run the L2 gate after any bump |
| A convergence overwrites a hand-applied patch | Was real, now fixed | the patch rides in the bundle; never hand-apply to a host again |
| Publishing from a worktree | Medium | `publish-fleet.sh` archives `git HEAD` of the package root, so publish from the worktree holding the commits, and pass `--manifest` pointing at the main checkout's `fleet.yaml` |
| SSO expiry mid-session | High on long sessions | `aws sso login --profile eu-shared-services-dev`; a publish fails at the S3 upload step with "Token has expired" |

## Out of scope

- Changing coms-net's `followUp` delivery semantics (the queueing is correct and deliberate).
- Adding anything to `agents/shared/skills/` (discovered by presence, so it would hit the analyzer orchestrator and all seven datasource sub-agents).
- A Zod field for `CTX_MODE_ENABLED` (no TypeScript read point; it is shell-only on the spoke).
- Editing `userdata.sh.tftpl` (`user_data_replace_on_change = true` — any byte change replaces every instance).
- Touching `packages/pi-coms/justfile` (main's `5d8882cb` now pins the console's extension set, including context-mode via explicit `-e`; the console was never broken).
- Rolling out to prd. **The L2 gate must pass on a dev spoke first.**

## Four false leads, so they are not repeated

1. **`grep bun:sqlite` returns nothing** — the specifier is built by `["bun","sqlite"].join(":")`. A grep for a joined specifier is not evidence of absence in this package.
2. **`bun add` passes on macOS, fails on a spoke** — better-sqlite3's postinstall calls `node-gyp` (exit 127) on a Bun-only host. macOS left the same postinstall BLOCKED as untrusted, so it succeeded by accident. Always `--ignore-scripts`.
3. **A `session_start` warm-up does not work** (`a15427dc`, reverted in `75c21f77`) — a `sendMessage({triggerTurn:true})` from inside `session_start` also fails to reach `_runAgentPrompt`.
4. **Check `git log origin/main` before filing a bug** — SIO-1731 was filed for a persona-version bug that SIO-1728 had already fixed hours earlier on a branch 5 commits ahead.

Also: four context-mode installs exist on this machine — `~/.pi/agent/npm/node_modules/context-mode` (console), `~/.claude/plugins/cache/context-mode` (Claude Code), **`~/WebstormProjects/context-mode` (git checkout WITH source — use this, not minified bundles)**, and `~/.bun/install/cache/context-mode`.

## Recommendation

**Merge SIO-1725's three skills now.** They are authored, exported, deployed and verified on both dev spokes, with zero runtime risk and no dependency on the context-mode work.

Hold the SIO-1726 half. The install plumbing is correct and proven; the blocker is a single unanswered question (does `context` fire on the `followUp` path, and is registration too late for that call?). Candidate 2 above is the cheapest test. If `refreshTools` turns out to be the missing step, that becomes the better upstream fix and the vendored patch should be rebuilt around it.

The upstream report (`/private/tmp/.../scratchpad/context-mode-upstream-issue.md`, also sent to the operator) is accurate as written but should gain the "still fails on a real spoke" caveat before filing.

## Memory references

- `reference_sio1726_context_mode_on_spokes.md` — root cause, the four installs, install gotchas, hub REST gotchas
- `reference_context_mode_runs_on_bun_via_runtime_array_join.md` — the grep-lies finding
- `reference_fleet_deploy_live_gotchas.md`, `reference_fleet_bundle_install_path_and_verify.md` — publish/converge mechanics
- `reference_fleet_operator_token_resolution_and_multi_operator_model.md` — operator token model
- `feedback_never_blame_working_code_for_probe_failures.md` — relevant: four probe failures here were the probe's fault, not the code's
