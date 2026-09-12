# vendor/context-mode-patch

One file: a patched `build/adapters/pi/extension.js` for context-mode 1.0.169.

## Why this exists (SIO-1726)

context-mode registers its `ctx_*` tools lazily from Pi's `before_agent_start`
hook. Pi emits that hook from exactly one place -- the `_runAgentPrompt` path.
coms-net delivers an inbound message with
`{ deliverAs: "followUp", triggerTurn: true }`, and Pi's `sendMessage` tests
`isStreaming` BEFORE `triggerTurn`, so a spoke that is already mid-turn takes
`agent.followUp()` -- which never emits the hook. The turn then reaches the
model with ZERO `ctx_*` tools, silently.

A spoke runs pi-monitor alongside and is usually busy, so this is the normal
case there. An idle interactive console always takes `_runAgentPrompt`, which is
why the same package works on a laptop and not on a spoke.

The patch adds the already-registered `context` hook as a bootstrap backstop.
Pi wires `context` into the agent itself as `transformContext`, so it runs for
every model call whatever created the turn, and `runner.emitContext` awaits each
handler and catches per-handler errors. CLI-only paths (`pi list`, help/version,
config) still never fire it, so the upstream #534/#809 guard that motivated the
lazy bootstrap is preserved.

Verified on eu-oit-dev (arm64 Linux, Bun 1.4.2): without the patch the spoke
answers "no ctx tools"; with it the spoke calls `ctx_batch_execute` and returns
its sandboxed output, and the bridge child becomes a live child of the Pi
process.

## Second patch: eager bootstrap at session_start (SIO-1726, follow-up)

The `context` backstop alone is one turn late. Pi emits `before_agent_start`
only from the user-text `prompt()` path; `pi.sendMessage()` (every spoke turn)
goes straight to `agent.prompt()`, which snapshots the tool list BEFORE
`transformContext` runs. So the first inbound message after a Pi start still
answered `no ctx tools`; the second had the tools. The patched build honours
`CONTEXT_MODE_BRIDGE_EAGER=1` to start the bridge from `session_start`, which
only a live AgentSession emits (never `pi list`/help/version). The launcher
exports it next to the `-e` flag, under the same `CTX_MODE_ENABLED` guard.

## Provenance

- Upstream: https://github.com/mksglu/context-mode
- Upstream version: 1.0.169
- Built from: local checkout at commit `1447087` on branch
  `fix/pi-bridge-bootstrap-on-context` (two patches + regression tests; upstream suite
  210 files / 4719 tests passing)
- License: Elastic License 2.0 -- retained; see the upstream LICENSE. This file
  is an unmodified build of upstream source plus those two patches.

## Remove this when

The fix lands in an upstream release. Then drop this directory, drop the overlay
step in `deploy/bootstrap/agent-bootstrap.sh`, and bump `CTX_VERSION` to the
release that carries it. The overlay is keyed to 1.0.169 on purpose: a different
`CTX_VERSION` must not silently get a build patched against another version.
