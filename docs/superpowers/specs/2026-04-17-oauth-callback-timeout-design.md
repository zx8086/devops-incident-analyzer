# OAuth Callback Server Timeout - Design Spec

> **Status:** Approved
> **Date:** 2026-04-17
> **Author:** Simon Owusu (with Claude Opus 4.6)
> **Linear:** SIO-651
> **Related:** SIO-650 (Atlassian MCP), SIO-647 (GitLab MCP)

## Context

Both the Atlassian (`mcp-server-atlassian`) and GitLab (`mcp-server-gitlab`) MCP servers start a local `Bun.serve()` HTTP callback server during OAuth authentication. The server listens for the authorization code redirect after the user completes OAuth in their browser. If the user never completes the flow -- closes the browser tab, walks away, or the OAuth provider errors silently -- the callback server hangs forever. The Promise never resolves or rejects, the port stays bound, and the MCP server startup blocks indefinitely.

The two `oauth-callback.ts` files are 95% identical. The only difference is the Atlassian version takes `port` as a parameter while GitLab hardcodes `OAUTH_CALLBACK_PORT`. Both share the same bug: no timeout mechanism on the Promise.

## Goal

Extract a shared, timeout-aware OAuth callback server helper into `@devops-agent/shared`. Both MCP servers consume it, eliminating duplication and fixing the hang-forever bug in one place.

## Non-Goals

- Configurable timeout via environment variable. The 120s default is passed as a parameter; callers can override via `timeoutMs` if needed later.
- Retry logic or auto-re-prompt after timeout. The supervisor already handles `AUTH_REQUIRED` status gracefully by skipping the branch.
- Changes to OAuth provider classes (`GitLabOAuthProvider`, `AtlassianOAuthProvider`). The bug is only in the callback server, not the provider.
- Token refresh timeout. Different code path, different problem.

## Architecture

### New shared helper

**File:** `packages/shared/src/oauth-callback.ts`

Exports:

```typescript
export class OAuthCallbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OAuth callback timed out after ${timeoutMs}ms`);
    this.name = "OAuthCallbackTimeoutError";
  }
}

export interface OAuthCallbackOptions {
  port: number;
  path: string;
  timeoutMs?: number; // default 120_000
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export interface OAuthCallbackResult {
  code: string;
}

export async function waitForOAuthCallback(
  options: OAuthCallbackOptions
): Promise<OAuthCallbackResult>
```

**Behavior:**

1. Starts `Bun.serve()` on `localhost:options.port`.
2. Listens for GET requests on `options.path`.
3. On `?code=<value>`: resolves with `{ code }`, schedules server stop after 3s.
4. On `?error=<value>`: rejects with descriptive error, schedules server stop after 3s.
5. On timeout (default 120s): stops the server immediately, rejects with `OAuthCallbackTimeoutError`.
6. Serves HTML success/error pages to the browser (same templates as current implementations).
7. Returns 404 for requests to other paths, 400 for requests missing both `code` and `error` params.

The timeout is implemented as a `setTimeout` that fires if neither resolve nor reject has been called. On fire, it calls `server.stop(true)` and rejects the Promise. The timer is cleared on resolve or reject to prevent double-action.

**No MCP SDK dependency.** Pure Bun.serve + HTTP. The shared package gains no new external dependencies.

### Consumer changes

**GitLab** (`packages/mcp-server-gitlab`):
- Delete `src/gitlab-client/oauth-callback.ts`.
- In `src/gitlab-client/proxy.ts`: replace import with `import { waitForOAuthCallback } from "@devops-agent/shared"` and pass `{ port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }`.

**Atlassian** (`packages/mcp-server-atlassian`):
- Delete `src/atlassian-client/oauth-callback.ts`.
- In `src/atlassian-client/proxy.ts`: replace import with `import { waitForOAuthCallback } from "@devops-agent/shared"` and pass `{ port: this.options.callbackPort, path: OAUTH_CALLBACK_PATH }`.
- Remove the re-export from `src/atlassian-client/index.ts`.

Both callers' existing error handling already catches rejected promises generically. The `OAuthCallbackTimeoutError` subclass allows optional specific handling but no behavior change is required at the call sites.

### Type consolidation

The `OAuthCallbackResult` interface (identical in both deleted files: `{ code: string }`) moves to the shared helper. The `OAuthCallbackTimeoutError` class is new.

## Testing

Six unit tests in `packages/shared/src/oauth-callback.test.ts`:

1. **Resolves on valid callback** -- start helper on ephemeral port, HTTP GET `?code=abc`, assert resolves with `{ code: "abc" }`.
2. **Rejects on error callback** -- HTTP GET `?error=access_denied`, assert rejects with message containing "access_denied".
3. **Rejects on timeout** -- start with `timeoutMs: 500`, send no request, assert rejects with `OAuthCallbackTimeoutError` within ~500ms.
4. **Server stops after timeout** -- after timeout rejection, verify port is freed by binding again.
5. **404 for wrong path** -- HTTP GET to `/wrong-path`, assert 404 response.
6. **Bad request for missing params** -- HTTP GET to correct path with no `code` or `error`, assert 400 response.

All tests use ephemeral ports to avoid conflicts in CI.

No integration tests needed. Consumer change is a 2-line import swap with identical runtime behavior. Existing smoke tests cover end-to-end.

## Acceptance Criteria

- [ ] `waitForOAuthCallback` rejects after `timeoutMs` with `OAuthCallbackTimeoutError`
- [ ] Server port is freed after timeout
- [ ] All 6 unit tests pass
- [ ] Both `proxy.ts` files use the shared import
- [ ] Deleted files: `mcp-server-gitlab/src/gitlab-client/oauth-callback.ts`, `mcp-server-atlassian/src/atlassian-client/oauth-callback.ts`
- [ ] Re-export removed from `mcp-server-atlassian/src/atlassian-client/index.ts`
- [ ] Re-exported from `packages/shared/src/index.ts`
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean on changed files
- [ ] Existing 265 tests still pass
