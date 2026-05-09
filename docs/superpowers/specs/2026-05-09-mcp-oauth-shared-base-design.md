# MCP OAuth: shared base + GitLab public-client hardening (SIO-685)

## Context

The LangSmith eval verification on 2026-05-09 (experiment
`agent-eval-postfix-34bb6fc-94f5e041`) surfaced that every GitLab sub-agent
invocation triggers an OAuth browser popup. Across the 5 eval queries the
popup fired 5 times, the GitLab sub-agent was then classified as a
non-retryable auth error, and the run dropped from a possible 5/5 confidence
checks to 3/5.

Inspection of `~/.mcp-auth/gitlab/https___gitlab.com.json` shows the file has
`clientInformation` and `codeVerifier` saved but **no `tokens`**. By contrast
the Atlassian sibling at `~/.mcp-auth/atlassian/<endpoint>.json` has full
tokens including `refresh_token`. The MCP SDK's auth flow tries token refresh
first, then falls back to a fresh authorize request — with no persisted
tokens, every connect re-runs the authorize flow → popup.

Root cause: GitLab's `/api/v4/mcp` Dynamic Client Registration registers
public clients per RFC 8252 (no `client_secret`). Our GitLab provider sends
`token_endpoint_auth_method: "client_secret_post"` to GitLab DCR. When the
SDK then exchanges code+verifier for tokens, the request looks malformed and
GitLab fails it silently. Atlassian's DCR returns a real `client_secret`, so
`client_secret_post` works there. The two providers were copy-pasted instead
of sharing a base, so one diverged when GitLab tightened its DCR contract.

This work fixes GitLab (the highest-priority bug) and uses the fix as the
forcing function to extract the shared OAuth pattern that should have existed
from day one. The same gaps that bit GitLab can bite Atlassian or any future
MCP server we add (Slack, Linear, etc.) — making this a reliability and
security pillar fix, not just a one-off bugfix.

## Goals

1. GitLab MCP OAuth produces persisted `tokens.access_token` and
   `tokens.refresh_token` after a single interactive authorization, and the
   SDK's refresh path keeps subsequent calls quiet for the lifetime of the
   refresh token.
2. Eliminate the duplicated OAuth provider code between
   `mcp-server-gitlab` and `mcp-server-atlassian` by extracting a shared
   base in `packages/shared/src/oauth/` that both servers subclass.
3. Add a typed headless contract (`MCP_OAUTH_HEADLESS=true`) so the eval
   pipeline and AgentCore deployments never spawn browser popups; instead
   they get a clear, retryable error pointing operators to a one-shot
   `bun run oauth:seed:<service>` CLI.
4. Make the security posture explicit: dir mode 0o700, file mode 0o600
   enforced on both new and pre-existing files; sanitization regex shared
   so persisted-file naming stays stable across future refactors.

## Non-goals

- OS keyring / encrypted-at-rest token storage (deferred — file permissions
  are the security boundary, matching `~/.aws/credentials`).
- Switching Atlassian to public-client + PKCE (verified working; no incident
  driving the change).
- Token expiry monitoring/alerting (the SDK handles refresh transparently;
  if refresh fails we'd see an `UnauthorizedError` and the existing alignment
  node already classifies it).
- A general "auth provider" abstraction for non-OAuth flows (PAT-only services
  don't need it).

## Architecture

### Shared base layer (`packages/shared/src/oauth/`)

```
packages/shared/src/oauth/
  base-provider.ts   abstract BaseOAuthClientProvider implements OAuthClientProvider
  errors.ts          OAuthRequiresInteractiveAuthError
  headless.ts        isHeadless()  // env + TTY check
  seed.ts            seedOAuth(provider, mcpUrl)  // shared interactive CLI helper
  index.ts           barrel
```

`BaseOAuthClientProvider` constructor:

```ts
interface BaseOAuthProviderOptions {
  storageNamespace: string;        // "gitlab" | "atlassian" → ~/.mcp-auth/<ns>/
  storageKey: string;              // mcpEndpoint or instanceUrl, sanitized for filename
  callbackPort: number;            // OAuth redirect listener port
  onRedirect: AuthorizationHandler; // browser-open or stub for tests
  logger?: Logger;
}
```

The base owns: storage I/O (mkdirSync mode 0o700, writeFileSync + chmodSync 0o600,
sanitization regex `/[^a-zA-Z0-9.-]/g`), `redirectUrl` getter, all 9 methods of
the `OAuthClientProvider` interface, the headless check inside
`redirectToAuthorization`, the stale-registration auto-discard inside
`clientInformation()`, and the codeVerifier-clear-on-saveTokens hygiene.

The base exposes one abstract method: `clientMetadata` getter. That's the
single seam where GitLab and Atlassian differ.

### Subclasses

```ts
// packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts (~30 lines)
export class GitLabOAuthProvider extends BaseOAuthClientProvider {
  constructor(instanceUrl: string, callbackPort: number, onRedirect: AuthorizationHandler) {
    super({ storageNamespace: "gitlab", storageKey: instanceUrl, callbackPort, onRedirect });
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "DevOps Incident Analyzer - GitLab MCP Proxy",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",  // public client per RFC 8252 + GitLab DCR
      scope: "mcp",
    };
  }
}
```

The Atlassian subclass is the same shape but keeps `client_secret_post` and
omits `scope`. Atlassian's existing public constructor (option-bag) is
preserved exactly so `test/oauth-provider.test.ts` passes unchanged.

### Headless contract

`isHeadless()` returns true when either:
- `process.env.MCP_OAUTH_HEADLESS === "true"`, or
- `process.stdout.isTTY === false` (catches accidental headless on a
  server where the operator forgot to set the env).

In `BaseOAuthClientProvider.redirectToAuthorization`:

```ts
async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
  if (isHeadless()) {
    log.error(
      { namespace: this.storageNamespace, url: authorizationUrl.toString() },
      `OAuth interactive authorization required but MCP_OAUTH_HEADLESS=true; run \`bun run oauth:seed:${this.storageNamespace}\``,
    );
    throw new OAuthRequiresInteractiveAuthError(this.storageNamespace, authorizationUrl);
  }
  await this.onRedirect(authorizationUrl);
}
```

Proxies (gitlab + atlassian) propagate the new error type alongside
`UnauthorizedError`. The agent's alignment node already classifies these as
non-retryable auth errors, so the failure mode degrades gracefully in
production.

### Stale-registration migration (overrides existing on-disk state)

Users who already ran the buggy GitLab provider have a persisted
`clientInformation` registered with `token_endpoint_auth_method:
"client_secret_post"`. The base detects this on load and discards it:

```ts
clientInformation(): OAuthClientInformationMixed | undefined {
  const persisted = this.persisted.clientInformation;
  if (persisted && persisted.token_endpoint_auth_method !== this.clientMetadata.token_endpoint_auth_method) {
    log.warn(
      { persisted: persisted.token_endpoint_auth_method, expected: this.clientMetadata.token_endpoint_auth_method },
      "persisted client registration auth_method mismatch -- discarding",
    );
    this.persisted.clientInformation = undefined;
    saveState(this.namespace, this.key, this.persisted);
    return undefined;
  }
  return persisted;
}
```

The SDK then calls `registerClient` again with the new metadata, the new
`clientInformation` is saved, and the user sees one popup (the seeding flow)
instead of an infinite loop.

### Seed CLI

`seedOAuth(provider, mcpUrl)` in `shared/oauth/seed.ts`:
- Constructs `Client` + `StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })`.
- Catches `UnauthorizedError` from first `client.connect`.
- Opens browser via `Bun.spawn(["open"|"start"|"xdg-open", url])`.
- Awaits `waitForOAuthCallback({ port, path })`.
- `transport.finishAuth(code)`.
- Reconnects to verify.
- Prints `Seeded <namespace> OAuth tokens at <path>`.

Per-package wrapper at `<package>/src/cli/seed-oauth.ts`:
1. `delete process.env.MCP_OAUTH_HEADLESS` (always interactive).
2. Load config, build provider, call `seedOAuth`.

Root `package.json`:
- `"oauth:seed:gitlab": "bun run --filter '@devops-agent/mcp-server-gitlab' src/cli/seed-oauth.ts"`
- `"oauth:seed:atlassian": "bun run --filter '@devops-agent/mcp-server-atlassian' src/cli/seed-oauth.ts"`

## Tests

### Shared (`packages/shared/src/__tests__/oauth/`)

`base-provider.test.ts`:
- Storage paths use `~/.mcp-auth/<namespace>/<sanitized-key>.json`.
- `fs.statSync(path).mode & 0o777 === 0o600` after save (also covers
  pre-existing files via the `chmodSync` enforcement).
- Round-trip persistence (save → new instance → values present).
- `invalidateCredentials("tokens" | "client" | "verifier" | "all")` matrix.
- `redirectToAuthorization` calls `onRedirect` when not headless.
- `redirectToAuthorization` throws `OAuthRequiresInteractiveAuthError` when
  `MCP_OAUTH_HEADLESS=true`.
- `clientInformation()` discards stale registration when
  `token_endpoint_auth_method` mismatches.
- `saveTokens` clears persisted `codeVerifier`.
- Sanitization snapshot test on `https://mcp.atlassian.com/v1/mcp` produces
  the same filename Atlassian users have on disk today (regression guard).

`seed.test.ts`:
- Mocked transport: first connect throws `UnauthorizedError`, mocked
  `waitForOAuthCallback` resolves `{ code: "abc" }`, mocked `finishAuth`
  succeeds, second connect succeeds. Assert tokens persisted via the
  injected provider.

### Per-package

`mcp-server-gitlab/test/oauth-provider.test.ts` (NEW):
- `clientMetadata.token_endpoint_auth_method === "none"`.
- `clientMetadata.scope === "mcp"`.
- `redirectUrl === "http://localhost:{injectedPort}/oauth/callback"`.

`mcp-server-gitlab/test/proxy.test.ts` (NEW):
- E2E mock: first `Client.connect` → `UnauthorizedError`. `waitForOAuthCallback`
  mocked to resolve `{ code: "abc" }`. `transport.finishAuth` mocked, calls
  `provider.saveTokens(...)`. Second `Client.connect` succeeds.
- Assert disk file contains `tokens.access_token` after the flow.

`mcp-server-atlassian/test/oauth-provider.test.ts` (EXISTING):
- Must pass unchanged after commit 1. This is the regression guard for the
  shared-base extraction.

## Delivery

One PR, three commits, all under `SIO-685: ` prefix:

1. **`SIO-685: extract BaseOAuthClientProvider`** (~+350/-220 LOC) —
   refactor only. Both providers subclass shared base. All existing tests
   pass. Atlassian on-disk format byte-identical.
2. **`SIO-685: GitLab public-client OAuth + headless mode`** (~+120/-30) —
   `auth_method:"none"`, `scope:"mcp"`, headless env + error type, callback
   port becomes config-driven, GitLab provider/proxy tests, stale-registration
   migration, codeVerifier hygiene, file-mode enforcement.
3. **`SIO-685: OAuth seed CLI + ops doc`** (~+150/-0) — `seed.ts`, two CLI
   wrappers, package.json scripts, `docs/operations/oauth-seeding.md`,
   `docs/architecture/mcp-integration.md` GitLab section refresh,
   `.env.example` updates.

## Risks & mitigations

- **Atlassian regression during shared-base extraction.** Mitigation: keep
  Atlassian's public constructor signature byte-identical, run Atlassian's
  existing test suite untouched after commit 1, snapshot-test the
  sanitization regex output.
- **SDK 1.29.0 may not respect `auth_method:"none"` on the refresh path.**
  Mitigation: read `auth.js` `refreshAuthorization` before commit 2; if it
  unconditionally sends `client_secret`, file an SDK upstream issue and
  document the workaround. Initial token-exchange success is the primary
  goal of SIO-685; a refresh-flow gap would be a separate follow-up.
- **`Bun.spawn(xdg-open)` on truly headless Linux exits silently.** Mitigation:
  `isHeadless()` checks `process.stdout.isTTY === false` so we fail fast
  with a clear error rather than hanging on the callback.
- **Existing GitLab persisted state will be discarded automatically** by the
  stale-registration migration. The user must run `oauth:seed:gitlab` once
  after the fix lands. Documented in the ops doc.
- **PR size.** Three commits keep individual review scope manageable
  (~30/45/15 minute reviews). Commit 1 is the largest but mechanical.
