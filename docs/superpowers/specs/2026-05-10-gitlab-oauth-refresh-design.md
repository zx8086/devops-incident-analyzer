# GitLab OAuth — Seed Once, Refresh Forever

**Date:** 2026-05-10
**Status:** Draft, awaiting user approval
**Linear:** TBD (created after spec approval)
**Related:** `docs/superpowers/specs/2026-05-09-mcp-oauth-shared-base-design.md` (the shared base provider this builds on), `docs/superpowers/specs/2026-04-13-gitlab-datasource-integration-design.md` (the original GitLab MCP integration)

## Context

The 2026-05-10 unified incident report run failed every GitLab tool call with `OAuth interactive authorization required for gitlab but MCP_OAUTH_HEADLESS=true`. The intended UX is "operator runs `bun run oauth:seed:gitlab` once with a popup, the system silently reuses the token from then on." Today the system supports the popup-once half but not the reuse-forever half: the seeded `access_token` expires (GitLab default ~2h), and there is no path to use the persisted `refresh_token` to mint a new one.

The current `BaseOAuthClientProvider.tokens()` (in `packages/shared/src/oauth/base-provider.ts:144`) returns whatever is on disk with zero expiry awareness. The MCP SDK calls it, gets an expired token, GitLab returns 401, the SDK throws `UnauthorizedError`, and `GitLabMcpProxy.connect()` (in `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts:100-103`) re-throws `OAuthRequiresInteractiveAuthError` because `MCP_OAUTH_HEADLESS=true`. The headless flag was added so eval runs would fail fast instead of spawning popups; it now also blocks the only path that could have rescued the call. The result in production: every tool call fails until a human re-runs the seed script, which means `bun run oauth:seed:gitlab` becomes the *de facto* refresh script — popups every couple of hours.

This spec closes that gap by adding a lazy refresh path inside the GitLab proxy. The popup happens at most once per refresh-chain lifetime — typically when the operator first seeds, and again only if the refresh token itself dies (revoked at GitLab, or refresh-token TTL exhausted).

## Goals

- One popup per refresh-chain lifetime. Concretely: at seed time, and never again unless the refresh chain is dead.
- Headless runs (evals, AgentCore deployments) silently refresh expired access tokens with no operator intervention.
- When the refresh chain is genuinely dead, the agent gets a typed error it can classify as a non-retryable auth failure, with a clear hint to re-seed.
- No regressions in the existing seed flow, the existing connect-time popup, or any non-OAuth code paths.

## Non-Goals

- **Atlassian or any other OAuth-using MCP server.** Atlassian also extends `BaseOAuthClientProvider` and may eventually need the same fix, but its tokens are fresh per the 2026-05-10 run and there is no second consumer demanding generalization. GitLab-only keeps the blast radius small.
- **Lifting refresh into `BaseOAuthClientProvider`.** Premature abstraction with one consumer. If Atlassian or a third provider hits the same wall, that's a separate effort that can read this design's lessons.
- **Background refresh timer.** Lazy refresh on 401 is sufficient for a bursty incident-analysis workload. A timer adds lifecycle (cancel on disconnect, restart on resume), pays refresh cost when nobody's calling tools, and complicates testing. YAGNI.
- **Changes to the seed script** (`packages/mcp-server-gitlab/src/cli/seed-oauth.ts`) unless the runtime guard reveals that the seeded token file is missing a `refresh_token`. If that turns out to be the case, the implementation plan adds it; the spec assumes the SDK and GitLab already negotiate a refresh_token under the existing flow.

## Architecture

```
                  +-------------------+
                  | GitLabMcpProxy    |
                  | (proxy.ts)        |
                  +---------+---------+
                            |
                            | (a) tool call
                            v
                  +-------------------+    +-------------------+
                  | SDK Client        |--->| GitLab API        |
                  | callTool(...)     |    | (HTTP)            |
                  +---------+---------+    +-------------------+
                            |
                            | (b) UnauthorizedError on expired token
                            v
                  +-------------------+
                  | proxy.callTool    |
                  | catch block       |
                  | (single retry)    |
                  +---------+---------+
                            |
                            | (c) refreshTokens()
                            v
                  +-------------------+    +-------------------+
                  | GitLabOAuth-      |--->| GitLab /oauth/    |
                  | Provider          |    | token endpoint    |
                  | (oauth-provider)  |    +-------------------+
                  +---------+---------+
                            |
                            | (d) saveTokens() -> disk
                            v
                  +-------------------+
                  | ~/.mcp-auth/      |
                  | gitlab/<key>.json |
                  +-------------------+
```

The GitLab proxy wraps every tool call in a refresh-aware retry. When the SDK throws `UnauthorizedError`, the proxy asks `GitLabOAuthProvider.refreshTokens()` to exchange the persisted `refresh_token` for new tokens, persists them through the existing `saveTokens()` path, then retries the original tool call exactly once. The MCP SDK and the OAuth base class are not modified. The `connect()` flow is unchanged — the once-per-server-boot popup behaviour on a totally empty token store still applies. The new behaviour only kicks in *after* the seed has produced tokens.

A typed error `OAuthRefreshChainExpiredError` is thrown when the refresh request itself fails (no refresh_token on disk, GitLab returns `invalid_grant`, malformed response). The agent's existing tool-error classifier in `packages/agent/src/sub-agent.ts` already maps auth-shaped errors to non-retryable; this typed error reuses that path with a more accurate message.

## Components

### 1. `GitLabOAuthProvider.refreshTokens()` — new method

**Location:** `packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts`

**Inputs:** None directly. Reads `this.persisted.tokens.refresh_token`, `this.persisted.clientInformation.client_id`, and `this.config.instanceUrl` (carried via base-provider state).

**Outputs:** Returns `Promise<OAuthTokens>` with the new tokens. Side-effect: writes the new tokens to disk via the inherited `saveTokens()`.

**Behaviour:** POSTs to `${instanceUrl}/oauth/token` with `grant_type=refresh_token`, `refresh_token=<persisted>`, `client_id=<persisted>` (no `client_secret` because the seeded clientMetadata uses `token_endpoint_auth_method: "none"` per the existing GitLab provider configuration). On a 200 response with valid `access_token`, calls `this.saveTokens(newTokens)` and returns. On any failure (non-2xx, missing access_token, network error parsing JSON), throws.

**Concurrent refresh dedup:** A single `private refreshInFlight: Promise<OAuthTokens> | null = null` field on the provider. The first caller sets it before starting the fetch; concurrent callers `await` the same promise. The promise is cleared in a `finally` block so a subsequent expiry can trigger a fresh refresh. This prevents 5 parallel sub-agent tool calls from hitting a stale token simultaneously and triggering 5 token-endpoint requests.

**Failure classification:**
- Network errors (DNS, ECONNRESET, fetch reject): rethrow as-is. Transient errors propagate naturally and the agent's transient-error classifier already retries.
- HTTP non-2xx, malformed JSON, missing `access_token` field, or `refresh_token` not present on disk at call time: throw `OAuthRefreshChainExpiredError` with `namespace: "gitlab"` and a hint to re-seed.

### 2. `GitLabMcpProxy.callTool` — modified

**Location:** `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts`

**Signature:** Unchanged: `callTool(toolName, args, options?)`.

**Behaviour:** Wraps the inner `this.client.callTool(...)` in a try/catch. On `UnauthorizedError`, calls `this.oauthProvider.refreshTokens()`, then retries `this.client.callTool(...)` once. The retry's exceptions are not caught — a second 401 means refresh did not help (either the refresh succeeded but the new token is also rejected, or refresh threw `OAuthRefreshChainExpiredError`), and the error propagates.

**Storage of provider reference (prerequisite structural change):** The proxy currently creates `GitLabOAuthProvider` as a local inside `connect()` (`proxy.ts:76`) and hands it to the transport. The instance is then unreachable from `callTool`. Before the refresh logic can be wired in, the implementation must promote it to a field on the proxy class so `callTool` can reach it. Type: `private oauthProvider: GitLabOAuthProvider | null = null;` (matches the nullable pattern of `transport` and `sdkClient`). This is the only existing-code restructure the design requires; everything else is additive.

**No change to `connect()`:** The interactive popup path on initial connect (proxy.ts:105-119) stays. That path is the seed-time fallback for developers running locally without having pre-seeded — it's working as designed and is out of scope.

### 3. `OAuthRefreshChainExpiredError` — new error type

**Location:** `packages/shared/src/oauth/errors.ts` (sits next to existing `OAuthRequiresInteractiveAuthError`).

**Shape:** Mirrors the existing typed error.
```ts
export class OAuthRefreshChainExpiredError extends Error {
    constructor(
        public readonly namespace: string,
        public readonly hint: string,
    ) {
        super(`OAuth refresh chain expired for ${namespace}: ${hint}`);
        this.name = "OAuthRefreshChainExpiredError";
    }
}
```

**Hint payload:** A short string the agent surfaces in logs verbatim. For "no refresh_token in seed file": `"seeded token file lacks refresh_token; run 'bun run oauth:seed:gitlab' to re-seed"`. For "GitLab rejected refresh_token": `"refresh_token rejected by ${instanceUrl}; run 'bun run oauth:seed:gitlab' to re-seed"`.

**Why a new type and not reusing `OAuthRequiresInteractiveAuthError`:** the existing error means "the SDK wants to redirect to an authorization URL, but we're headless." The new error means "we tried to refresh and the refresh chain itself is dead." Different operator action: the existing one says "you never seeded"; the new one says "your seed is dead, re-seed." Operationally these need to be distinguishable in logs and dashboards.

## Data Flow

**Happy path (token still valid):**
`callTool` → SDK → GitLab returns 200 → result. No refresh. No file I/O beyond what the SDK already does. Hot path is byte-for-byte unchanged.

**Refresh path (access_token expired, refresh_token works):**
1. `callTool` → SDK → GitLab returns 401 → SDK throws `UnauthorizedError`.
2. Proxy catches → calls `provider.refreshTokens()`.
3. Provider POSTs to `/oauth/token` with `grant_type=refresh_token`.
4. GitLab returns `{ access_token, refresh_token?, expires_in, token_type }`.
5. Provider calls `saveTokens(newTokens)` — writes `~/.mcp-auth/gitlab/<key>.json`.
6. Proxy retries `callTool` once. SDK reads the new token via `provider.tokens()` (already wired through the SDK's auth machinery in the existing transport setup).
7. GitLab returns 200 → result.

One extra round-trip on the boundary; transparent to the agent and the SDK. Concurrent callers all observe the same `refreshInFlight` promise and only one HTTP request to `/oauth/token` fires.

**Dead-chain path (refresh fails):**
1. `callTool` → SDK → 401 → `UnauthorizedError`.
2. Proxy catches → `provider.refreshTokens()`.
3. Provider POSTs to `/oauth/token` → GitLab returns 400 `invalid_grant`.
4. Provider throws `OAuthRefreshChainExpiredError`.
5. Proxy's catch block does not match — the error propagates.
6. **Headless mode:** the agent's sub-agent error classifier sees an auth-shaped error message and marks the GitLab data-source as non-retryable. The alignment retry loop skips it. The user sees a clear message in the report: re-seed.
7. **Interactive mode:** the operator at a terminal sees the error in the proxy logs and runs `bun run oauth:seed:gitlab` themselves. We do *not* automatically pop a browser **mid-tool-call** — that would surprise the operator and conflict with the once-only popup intent. The seed script remains the single ergonomic on-ramp. (The existing connect-time popup at `proxy.ts:105-119` is a different code path and is unchanged: a developer running the agent locally with no token on disk still gets a popup at server startup.)

## Runtime Guard for Missing `refresh_token`

The seed script and the SDK negotiate the OAuth flow; the spec assumes this produces a `refresh_token` in the persisted file because GitLab's Authorization Code + PKCE flow includes one by default. To avoid blind faith, `refreshTokens()` checks `this.persisted.tokens.refresh_token` at call time. If it's missing, the method throws `OAuthRefreshChainExpiredError` with the "seeded token file lacks refresh_token; re-seed" hint. The first time someone deploys this fix, if their existing seed file lacks a `refresh_token`, they'll see a clear error pointing at the fix. No silent failures.

The implementation plan will include a runtime check on the *first* call after a seed to log a warning if no `refresh_token` is present, so operators discover the gap before the access token expires rather than hours later. This is a small ergonomic win, not a correctness requirement.

## Error Handling Summary

| Failure mode | Where caught | Result |
|---|---|---|
| Token still valid | n/a | Happy path |
| Access token expired, refresh succeeds | proxy.callTool catch | Transparent retry |
| Refresh request returns non-2xx | refreshTokens | `OAuthRefreshChainExpiredError` |
| Refresh response missing access_token | refreshTokens | `OAuthRefreshChainExpiredError` |
| No refresh_token on disk | refreshTokens | `OAuthRefreshChainExpiredError` (with re-seed hint) |
| Network error during refresh | refreshTokens (rethrown) | Transient — propagate; agent classifier retries |
| Refresh succeeds but retried tool call still 401 | proxy.callTool (no second catch) | Propagates as `UnauthorizedError` — agent treats as non-retryable |
| Concurrent callers during refresh | refreshInFlight dedup | All callers `await` the same fetch |
| Connect-time popup (initial seed) | proxy.connect existing path | Unchanged |

## Testing

Three unit tests in a new `packages/mcp-server-gitlab/src/gitlab-client/oauth-refresh.test.ts` (clearer than mixing into the existing `proxy.test.ts`).

**Test 1 — Happy refresh:**
- Mock SDK client: `callTool` throws `UnauthorizedError` on first call, returns `{ ok: true }` on second.
- Mock global `fetch` to intercept POSTs to `/oauth/token`, return `{ access_token: "new", refresh_token: "rotated", expires_in: 7200, token_type: "Bearer" }` with status 200.
- Set `HOME` to a temp dir; pre-write `~/.mcp-auth/gitlab/<key>.json` with `{ tokens: { access_token: "old", refresh_token: "still-good" } }`.
- Invoke `proxy.callTool("gitlab_search", {...})`.
- Assert: returned value is `{ ok: true }`; the file on disk now has `access_token: "new"`; exactly one POST to `/oauth/token` was made.

**Test 2 — Dead chain in headless:**
- Same setup, but mock fetch to return 400 `{ error: "invalid_grant" }` for `/oauth/token`.
- Set `MCP_OAUTH_HEADLESS=true`.
- Invoke `proxy.callTool(...)`.
- Assert: thrown error is `instanceof OAuthRefreshChainExpiredError`; `.namespace === "gitlab"`; `.hint` mentions `oauth:seed:gitlab`; on-disk tokens unchanged.

**Test 3 — Concurrent refresh dedup:**
- SDK client throws `UnauthorizedError` on first call from each of 5 parallel callers, returns success thereafter.
- Mock fetch with a `setTimeout(resolve, 50)` and a counter of `/oauth/token` hits.
- Fire 5 `proxy.callTool` calls in parallel.
- Assert: all 5 resolve with success; counter reads `1` (one refresh shared across all 5 callers).

No integration test against a live GitLab instance. The seed script already covers that path manually and a real-token integration test in CI would require provisioned GitLab credentials.

## Out of Scope (intentionally restated)

- Atlassian, Konnect, or any other OAuth-using MCP server.
- Lifting refresh into `BaseOAuthClientProvider`. Revisit when a second provider needs it.
- Background pre-emptive refresh timer.
- Changes to the seed script (added by implementation plan only if the runtime guard reveals refresh_token is missing).
- Auto-popup on dead chain in interactive mode. The operator re-runs `oauth:seed:gitlab` themselves; we do not silently spawn a browser mid-tool-call.

## Verification

Beyond the unit tests, end-to-end verification requires:
1. `bun run typecheck` clean across all packages.
2. `bun run lint` clean.
3. `bun run --filter @devops-agent/mcp-server-gitlab test` — all tests pass including the 3 new ones.
4. Manual: seed once with `bun run oauth:seed:gitlab`. Wait until the access_token expires (~2 hours; can also be forced by editing `expires_at` on the disk file). Run an agent query that targets GitLab. Observe: no popup, the call succeeds, the on-disk `access_token` has been updated.
5. Manual: revoke the seeded application at GitLab. Run an agent query in headless mode. Observe: the GitLab data-source returns a non-retryable auth error in the report, with a hint to re-seed. No popup.

## Open Questions / Risks

- **Refresh token rotation:** GitLab may issue a new `refresh_token` on every refresh (token rotation) or it may keep the same one indefinitely. The implementation must call `saveTokens()` with the *full* response payload so a rotated `refresh_token` is captured. If we accidentally keep the old refresh_token, the next refresh will fail. The unit test for the happy path explicitly asserts the on-disk `refresh_token` matches what `/oauth/token` returned.
- **Clock skew on `expires_in`:** We do not pre-emptively refresh based on `expires_at`; we react to 401. So clock skew is irrelevant for our path. (If a future spec adds proactive refresh, we'd want a 60-second safety margin.)
- **GitLab token endpoint URL discovery:** the SDK normally discovers OAuth metadata from the server. For our hand-rolled refresh we hard-code `${instanceUrl}/oauth/token`. This is GitLab's documented endpoint and stable. If GitLab ever moves it, the unit test will keep passing (it mocks fetch) but production will break — caught by the manual verification step.
