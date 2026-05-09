# OAuth seeding for MCP proxies

GitLab and Atlassian MCP both authenticate via OAuth 2.0 Dynamic Client Registration. The first time the proxy connects to a remote MCP endpoint it has no tokens, so the SDK requests authorization and the provider opens a browser. Once tokens land on disk at `~/.mcp-auth/<namespace>/<sanitized-mcp-url>.json` (mode 0o600), subsequent connects use the saved access token and refresh transparently when it expires.

In non-interactive contexts -- the LangSmith eval pipeline, AgentCore deployments, headless CI runs -- there is no human to click the browser popup. SIO-685 was filed because that mismatch caused a popup loop: the popup fired, nobody clicked it, the token exchange never completed, the next request re-ran the full authorize flow, and so on.

This guide covers seeding tokens once interactively so headless contexts can run cleanly.

## When to seed

Seed when **any** of the following is true:

- You're about to run `bun run eval:agent` and `~/.mcp-auth/gitlab/*.json` lacks a `tokens.access_token` field.
- You're deploying the agent or an MCP server to AgentCore (or any other headless host).
- You wiped `~/.mcp-auth/<service>/` to recover from a stale registration after upgrading.
- The agent logs `OAuthRequiresInteractiveAuthError` for a service.

## Commands

```bash
# Seeds ~/.mcp-auth/gitlab/ -- requires GITLAB_INSTANCE_URL in .env
bun run oauth:seed:gitlab

# Seeds ~/.mcp-auth/atlassian/ -- requires ATLASSIAN_MCP_URL in .env
bun run oauth:seed:atlassian
```

Each command:

1. Loads the package's config via the same loader the MCP server uses (so DCR scope, callback port, and instance URL match production).
2. Explicitly unsets `MCP_OAUTH_HEADLESS` (so it always opens the browser, even when invoked from a shell that exports `MCP_OAUTH_HEADLESS=true` for downstream eval runs).
3. Constructs a `Client` + `StreamableHTTPClientTransport` with the package's `OAuthClientProvider`.
4. On `UnauthorizedError`, opens the browser via `open` / `xdg-open` / `start` and listens on the configured callback port (`GITLAB_OAUTH_CALLBACK_PORT=9184`, `ATLASSIAN_OAUTH_CALLBACK_PORT=9185`).
5. After you click "Authorize" in the browser, exchanges the code for tokens, persists them, and reconnects to verify they actually work.
6. Prints `Done. Tokens persisted to ~/.mcp-auth/<service>/.`

## Verifying the seed worked

```bash
cat ~/.mcp-auth/gitlab/https___gitlab.com.json | jq 'keys'
# Expect: ["clientInformation","tokens"]   (codeVerifier is cleared after the first successful exchange)

cat ~/.mcp-auth/gitlab/https___gitlab.com.json | jq '.tokens | keys'
# Expect: ["access_token","expires_in","refresh_token","scope","token_type"]

cat ~/.mcp-auth/gitlab/https___gitlab.com.json | jq '.clientInformation.token_endpoint_auth_method'
# Expect: "none"   (public client per RFC 8252; SIO-685)

stat -f "%OLp" ~/.mcp-auth/gitlab/https___gitlab.com.json
# Expect: 600
```

For Atlassian the shape differs only in `clientInformation` (it carries a `client_secret`) and `token_endpoint_auth_method` (`"client_secret_post"`).

## Headless mode (after seeding)

Once tokens are present on disk, set `MCP_OAUTH_HEADLESS=true` in any non-interactive caller:

```bash
MCP_OAUTH_HEADLESS=true bun run eval:agent
```

The provider checks this env (and `process.stdout.isTTY === false`) inside `redirectToAuthorization`. If the SDK ever decides to re-authorize (e.g. refresh failed, or you wiped the file), it throws a typed `OAuthRequiresInteractiveAuthError` instead of opening a popup. The agent's alignment node classifies that as a non-retryable auth error and the run continues with the affected datasource marked unavailable.

## Revoking and re-seeding

```bash
# Revoke locally: delete the persisted state. The next interactive seed
# recreates it via DCR.
rm ~/.mcp-auth/gitlab/https___gitlab.com.json
bun run oauth:seed:gitlab

# Revoke server-side: visit https://gitlab.com/-/profile/applications (or the
# Atlassian equivalent) and remove the registered application. Then delete
# the local file and re-seed.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|-------------|----|
| Browser popup fires every request | Tokens are present on disk but `clientInformation.token_endpoint_auth_method` mismatches the current code (e.g. legacy `client_secret_post` row from before SIO-685) | The base provider's stale-registration auto-discard handles this on next connect; if it doesn't, `rm ~/.mcp-auth/<service>/*.json` and re-seed |
| `OAuthRequiresInteractiveAuthError` thrown from `redirectToAuthorization` | `MCP_OAUTH_HEADLESS=true` is set OR stdout is not a TTY (e.g. running under `tee`, `screen` without TTY) | Run the seed CLI directly in a real terminal -- it unsets the env. If running under `tee`, redirect after the seed completes |
| Token exchange fails silently after the popup is clicked (file ends up with `clientInformation` + `codeVerifier` but no `tokens`) | DCR registered a public client but the provider sent `token_endpoint_auth_method: "client_secret_post"` (the SIO-685 root cause). Should not occur on current code | Confirm `clientMetadata.token_endpoint_auth_method === "none"` for the failing namespace; rebuild and re-seed |
| `EADDRINUSE :9184` | Another seed CLI or MCP server is already listening on the callback port | Kill it (`lsof -i :9184` then `kill <pid>`) and re-seed; or override `GITLAB_OAUTH_CALLBACK_PORT` to a free port |

## Where this is implemented

- Shared base provider, headless gate, stale-registration migration, file-mode enforcement: `packages/shared/src/oauth/`
- Seed CLI helper: `packages/shared/src/oauth/seed.ts`
- Per-package CLI wrappers: `packages/mcp-server-{gitlab,atlassian}/src/cli/seed-oauth.ts`
- GitLab provider (public client + PKCE): `packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts`
- Atlassian provider (`client_secret_post`): `packages/mcp-server-atlassian/src/atlassian-client/oauth-provider.ts`
- Architecture context: `docs/architecture/mcp-integration.md` (OAuth credential persistence section)
