# Fix interactive OAuth seeders hanging under `bun run` piped stdout

Date: 2026-06-04

## Problem

`bun run oauth:seed:atlassian --force` (and the GitLab equivalent) hang
indefinitely at `Waiting for browser authorization...` with no authorization URL
printed and no browser opened.

Root cause: the documented command runs through a nested `bun run --filter`
chain:

```
bun run oauth:seed:atlassian
  -> bun run --filter @devops-agent/mcp-server-atlassian oauth:seed --force
       -> bun --env-file=../../.env src/cli/seed-oauth.ts --force
```

Each `bun run` layer pipes stdout to its parent rather than connecting it to the
terminal, so by the time the CLI runs `process.stdout.isTTY === false`.

`isHeadless()` (`packages/shared/src/oauth/headless.ts`) returns `true` whenever
`MCP_OAUTH_HEADLESS === "true"` OR `process.stdout.isTTY === false`. The seeders
already neutralize the env half (`delete process.env.MCP_OAUTH_HEADLESS`) but
have no way to neutralize the TTY half.

With `isHeadless()` true, `redirectToAuthorization` (`base-provider.ts:464`)
throws `OAuthRequiresInteractiveAuthError` instead of calling `onRedirect` -- the
only place that prints the URL and spawns the browser via `open`. The auth flow
never starts, so the local callback server in `seedOAuth` (`seed.ts:73`) blocks
on a callback that never arrives.

## Solution

Add an explicit opt-out env flag, `MCP_OAUTH_FORCE_INTERACTIVE`, honored as a
hard override in `isHeadless()`:

```ts
// packages/shared/src/oauth/headless.ts
export function isHeadless(): boolean {
  if (process.env.MCP_OAUTH_FORCE_INTERACTIVE === "true") return false;
  return process.env.MCP_OAUTH_HEADLESS === "true" || process.stdout.isTTY === false;
}
```

Both interactive seed CLIs set the flag next to the existing `delete`:

```ts
delete process.env.MCP_OAUTH_HEADLESS;
process.env.MCP_OAUTH_FORCE_INTERACTIVE = "true";
```

## Why this is safe

- The flag is set ONLY by the two interactive seed CLIs, never by an MCP server,
  so server-side headless detection (including the TTY safety net that catches
  an operator who forgot `MCP_OAUTH_HEADLESS=true`) is unchanged.
- It is symmetric with the existing `delete process.env.MCP_OAUTH_HEADLESS`
  idiom: the seeder declares "I am interactive" in two coordinated ways.
- Precedence is deliberate -- `FORCE_INTERACTIVE` wins over both the env var and
  the TTY check, because the operator explicitly invoked the seeder to authorize
  in a browser.

## Components touched

| File | Change |
|------|--------|
| `packages/shared/src/oauth/headless.ts` | Add `MCP_OAUTH_FORCE_INTERACTIVE` early-return; update doc comment |
| `packages/mcp-server-atlassian/src/cli/seed-oauth.ts` | Set the flag; update comment |
| `packages/mcp-server-gitlab/src/cli/seed-oauth.ts` | Set the flag; update comment |
| `packages/shared/src/__tests__/oauth/headless.test.ts` | New unit tests for the override + existing behavior |

## Testing

Unit tests for `isHeadless()`:
- returns `false` when `MCP_OAUTH_FORCE_INTERACTIVE === "true"` even if
  `MCP_OAUTH_HEADLESS === "true"` AND stdout is not a TTY
- returns `true` when `MCP_OAUTH_HEADLESS === "true"` and the flag is absent
- returns `true` when stdout is not a TTY and the flag is absent
- returns `false` when neither headless signal is present

Each test mutates and restores `process.env` and `process.stdout.isTTY` so the
suite is order-independent (per the Bun-env-leak learning).

Manual verification: re-run `bun run oauth:seed:atlassian --force` end to end --
the URL prints, the browser opens, the callback completes, tokens persist to
`~/.mcp-auth/atlassian/`.

## Out of scope

- The boot-warn / server-side headless path (`boot-warn.ts`) -- no change.
- Any refactor of `onRedirect`, `seedOAuth`, or the callback listener.
- The GitLab vs Atlassian OAuth-vs-PAT credential split (unrelated).
