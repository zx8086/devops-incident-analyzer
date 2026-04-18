# OAuth Callback Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a shared, timeout-aware OAuth callback server helper into `@devops-agent/shared`, replacing the duplicate hang-forever implementations in the GitLab and Atlassian MCP servers.

**Architecture:** One new file in the shared package (`oauth-callback.ts`) with `Bun.serve()`-based callback server that rejects after a configurable timeout. Both MCP servers delete their local `oauth-callback.ts` and import from shared. Six unit tests cover resolve, reject, timeout, port cleanup, 404, and 400 paths.

**Tech Stack:** Bun 1.3.9+, TypeScript 5.x strict, `Bun.serve()` for the HTTP server, `bun:test` for tests.

**Source spec:** `docs/superpowers/specs/2026-04-17-oauth-callback-timeout-design.md`

**Linear issue:** SIO-651

---

## File Structure

**Create:**
- `packages/shared/src/oauth-callback.ts` -- shared helper with timeout logic
- `packages/shared/src/__tests__/oauth-callback.test.ts` -- 6 unit tests

**Modify:**
- `packages/shared/src/index.ts` -- add re-exports
- `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts:8,65` -- swap import and call
- `packages/mcp-server-atlassian/src/atlassian-client/proxy.ts:8,95` -- swap import and call
- `packages/mcp-server-atlassian/src/atlassian-client/index.ts:3-4` -- remove re-exports

**Delete:**
- `packages/mcp-server-gitlab/src/gitlab-client/oauth-callback.ts`
- `packages/mcp-server-atlassian/src/atlassian-client/oauth-callback.ts`

---

## Task 0: Verify baseline

**Goal:** Confirm tests pass before any changes.

**Files:** None

- [ ] **Step 1: Run shared package tests**

Run: `bun test packages/shared/src/`
Expected: all tests pass.

- [ ] **Step 2: Run full agent+bridge suite to confirm baseline**

Run: `bun test packages/agent/src/ packages/gitagent-bridge/src/`
Expected: 265 pass, 0 fail.

- [ ] **Step 3: No commit**

Verification only.

---

## Task 1: Write failing tests for the shared helper

**Goal:** TDD -- write all 6 tests first. They will fail because `oauth-callback.ts` does not exist yet.

**Files:**
- Create: `packages/shared/src/__tests__/oauth-callback.test.ts`

- [ ] **Step 1: Create the test file**

Create `packages/shared/src/__tests__/oauth-callback.test.ts`:

```typescript
// shared/src/__tests__/oauth-callback.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
	OAuthCallbackTimeoutError,
	waitForOAuthCallback,
} from "../oauth-callback.ts";

// Use port 0 so Bun picks an ephemeral port; extract the actual port from
// within the test by racing a fetch against the promise.
// For tests that need to send HTTP requests, we start the helper on a known
// high port and verify behavior.

let serverPort = 19_400;

afterEach(() => {
	// Bump port to avoid bind conflicts between tests
	serverPort++;
});

describe("waitForOAuthCallback", () => {
	test("resolves with code on valid callback", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({ port: serverPort, path });

		// Give the server a moment to bind
		await Bun.sleep(50);

		const res = await fetch(
			`http://localhost:${serverPort}${path}?code=test_auth_code`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Authorization Successful");

		const result = await promise;
		expect(result.code).toBe("test_auth_code");
	});

	test("rejects on error callback", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({ port: serverPort, path });

		await Bun.sleep(50);

		const res = await fetch(
			`http://localhost:${serverPort}${path}?error=access_denied&error_description=User%20denied`,
		);
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain("Authorization Failed");

		await expect(promise).rejects.toThrow("User denied");
	});

	test("rejects with OAuthCallbackTimeoutError on timeout", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({
			port: serverPort,
			path,
			timeoutMs: 300,
		});

		await expect(promise).rejects.toThrow(OAuthCallbackTimeoutError);
	});

	test("server port is freed after timeout", async () => {
		const path = "/oauth/callback";
		const port = serverPort;
		const promise = waitForOAuthCallback({
			port,
			path,
			timeoutMs: 200,
		});

		// Wait for the timeout rejection
		try {
			await promise;
		} catch {
			// expected
		}

		// Give server a moment to fully release the port
		await Bun.sleep(100);

		// Verify port is free by binding a new server on it
		const testServer = Bun.serve({
			port,
			hostname: "localhost",
			fetch() {
				return new Response("ok");
			},
		});
		expect(testServer.port).toBe(port);
		testServer.stop(true);
	});

	test("returns 404 for wrong path", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({
			port: serverPort,
			path,
			timeoutMs: 2000,
		});

		await Bun.sleep(50);

		const res = await fetch(`http://localhost:${serverPort}/wrong-path`);
		expect(res.status).toBe(404);

		// Clean up: send a valid callback to resolve the promise
		await fetch(
			`http://localhost:${serverPort}${path}?code=cleanup`,
		);
		await promise;
	});

	test("returns 400 for missing code and error params", async () => {
		const path = "/oauth/callback";
		const promise = waitForOAuthCallback({
			port: serverPort,
			path,
			timeoutMs: 2000,
		});

		await Bun.sleep(50);

		const res = await fetch(`http://localhost:${serverPort}${path}`);
		expect(res.status).toBe(400);

		// Clean up: send a valid callback to resolve the promise
		await fetch(
			`http://localhost:${serverPort}${path}?code=cleanup`,
		);
		await promise;
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/shared/src/__tests__/oauth-callback.test.ts`
Expected: FAIL with import errors (`OAuthCallbackTimeoutError` and `waitForOAuthCallback` not found).

- [ ] **Step 3: Commit the failing tests**

```bash
git add packages/shared/src/__tests__/oauth-callback.test.ts
git commit -m "SIO-651: Add failing tests for shared OAuth callback helper

Six tests covering resolve, reject, timeout, port cleanup, 404, and
400 paths. Tests fail because the implementation does not exist yet.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement the shared OAuth callback helper

**Goal:** Create `oauth-callback.ts` in the shared package that passes all 6 tests.

**Files:**
- Create: `packages/shared/src/oauth-callback.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create the implementation**

Create `packages/shared/src/oauth-callback.ts`:

```typescript
// shared/src/oauth-callback.ts

const DEFAULT_TIMEOUT_MS = 120_000;

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authorization Successful</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px">
<h1>Authorization Successful</h1>
<p>You can close this window and return to the terminal.</p>
<script>setTimeout(()=>window.close(),3000)</script>
</body></html>`;

const ERROR_HTML = (error: string) => `<!DOCTYPE html>
<html><head><title>Authorization Failed</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px">
<h1>Authorization Failed</h1>
<p>Error: ${error}</p>
</body></html>`;

export class OAuthCallbackTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`OAuth callback timed out after ${timeoutMs}ms -- user did not complete authorization`);
		this.name = "OAuthCallbackTimeoutError";
	}
}

export interface OAuthCallbackOptions {
	port: number;
	path: string;
	timeoutMs?: number;
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
	options: OAuthCallbackOptions,
): Promise<OAuthCallbackResult> {
	const { port, path, logger } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise<OAuthCallbackResult>((resolve, reject) => {
		let settled = false;

		const server = Bun.serve({
			port,
			hostname: "localhost",

			fetch(req) {
				const url = new URL(req.url);

				if (url.pathname !== path) {
					return new Response("Not found", { status: 404 });
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (code) {
					logger?.info({ port, path }, "OAuth authorization code received");
					settled = true;
					clearTimeout(timer);
					resolve({ code });
					setTimeout(() => server.stop(true), 3000);
					return new Response(SUCCESS_HTML, {
						headers: { "Content-Type": "text/html" },
					});
				}

				if (error) {
					const description =
						url.searchParams.get("error_description") || error;
					logger?.error(
						{ error: description },
						"OAuth authorization failed",
					);
					settled = true;
					clearTimeout(timer);
					reject(
						new Error(`OAuth authorization failed: ${description}`),
					);
					setTimeout(() => server.stop(true), 3000);
					return new Response(ERROR_HTML(description), {
						status: 400,
						headers: { "Content-Type": "text/html" },
					});
				}

				return new Response(
					"Bad request: missing code or error parameter",
					{ status: 400 },
				);
			},
		});

		logger?.info(
			{ port, path, timeoutMs },
			"OAuth callback server started",
		);

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				server.stop(true);
				logger?.error(
					{ port, timeoutMs },
					"OAuth callback server timed out",
				);
				reject(new OAuthCallbackTimeoutError(timeoutMs));
			}
		}, timeoutMs);
	});
}
```

- [ ] **Step 2: Add re-exports to shared index.ts**

In `packages/shared/src/index.ts`, add the following at the end of the file:

```typescript
export {
	OAuthCallbackTimeoutError,
	type OAuthCallbackOptions,
	type OAuthCallbackResult,
	waitForOAuthCallback,
} from "./oauth-callback.ts";
```

- [ ] **Step 3: Run the tests**

Run: `bun test packages/shared/src/__tests__/oauth-callback.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 4: Run full shared package tests to confirm no regressions**

Run: `bun test packages/shared/src/`
Expected: all tests pass (existing + 6 new).

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/shared' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/oauth-callback.ts packages/shared/src/index.ts
git commit -m "SIO-651: Implement shared OAuth callback helper with timeout

Bun.serve()-based callback server that rejects with
OAuthCallbackTimeoutError after configurable timeout (default 120s).
Stops the server and frees the port on timeout. Serves HTML
success/error pages to the browser. Six tests pass.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Migrate GitLab proxy to shared helper

**Goal:** Delete the GitLab `oauth-callback.ts` and update `proxy.ts` to import from `@devops-agent/shared`.

**Files:**
- Delete: `packages/mcp-server-gitlab/src/gitlab-client/oauth-callback.ts`
- Modify: `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts:8,65`

- [ ] **Step 1: Update the import in proxy.ts**

In `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts`, replace line 8:

```typescript
// OLD:
import { waitForOAuthCallback } from "./oauth-callback.js";

// NEW:
import { waitForOAuthCallback } from "@devops-agent/shared";
```

- [ ] **Step 2: Update the call site to pass options**

In `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts`, replace line 65:

```typescript
// OLD:
				const { code } = await waitForOAuthCallback();

// NEW:
				const { code } = await waitForOAuthCallback({
					port: OAUTH_CALLBACK_PORT,
					path: OAUTH_CALLBACK_PATH,
				});
```

The constants `OAUTH_CALLBACK_PORT` and `OAUTH_CALLBACK_PATH` are already imported from `./oauth-provider.js` via the deleted file. They need to be imported directly. Check if `proxy.ts` already imports from `./oauth-provider.js`:

Line 9 imports `GitLabOAuthProvider` from `./oauth-provider.js`. Extend that import:

```typescript
// OLD:
import { GitLabOAuthProvider } from "./oauth-provider.js";

// NEW:
import { GitLabOAuthProvider, OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "./oauth-provider.js";
```

- [ ] **Step 3: Delete the old file**

Run: `rm packages/mcp-server-gitlab/src/gitlab-client/oauth-callback.ts`

- [ ] **Step 4: Typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-gitlab' typecheck`
Expected: clean. No other file in the gitlab package imports from `oauth-callback.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-gitlab/src/gitlab-client/proxy.ts
git rm packages/mcp-server-gitlab/src/gitlab-client/oauth-callback.ts
git commit -m "SIO-651: Migrate GitLab proxy to shared OAuth callback helper

Delete local oauth-callback.ts, import waitForOAuthCallback from
@devops-agent/shared. Pass port and path as options. GitLab OAuth
now has a 120s timeout instead of hanging forever.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Migrate Atlassian proxy to shared helper

**Goal:** Delete the Atlassian `oauth-callback.ts`, update `proxy.ts`, and clean up `index.ts` re-exports.

**Files:**
- Delete: `packages/mcp-server-atlassian/src/atlassian-client/oauth-callback.ts`
- Modify: `packages/mcp-server-atlassian/src/atlassian-client/proxy.ts:8,95`
- Modify: `packages/mcp-server-atlassian/src/atlassian-client/index.ts:3-4`

- [ ] **Step 1: Update the import in proxy.ts**

In `packages/mcp-server-atlassian/src/atlassian-client/proxy.ts`, replace line 8:

```typescript
// OLD:
import { waitForOAuthCallback } from "./oauth-callback.js";

// NEW:
import { waitForOAuthCallback } from "@devops-agent/shared";
```

- [ ] **Step 2: Update the call site to pass options**

In `packages/mcp-server-atlassian/src/atlassian-client/proxy.ts`, replace line 95:

```typescript
// OLD:
				const { code } = await waitForOAuthCallback(this.options.callbackPort);

// NEW:
				const { code } = await waitForOAuthCallback({
					port: this.options.callbackPort,
					path: OAUTH_CALLBACK_PATH,
				});
```

`OAUTH_CALLBACK_PATH` is already available. Check: line 9 imports `AtlassianOAuthProvider` from `./oauth-provider.js`. Extend that import:

```typescript
// OLD:
import { AtlassianOAuthProvider } from "./oauth-provider.js";

// NEW:
import { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";
```

- [ ] **Step 3: Remove re-exports from index.ts**

In `packages/mcp-server-atlassian/src/atlassian-client/index.ts`, delete lines 3-4:

```typescript
// DELETE these two lines:
export type { OAuthCallbackResult } from "./oauth-callback.js";
export { waitForOAuthCallback } from "./oauth-callback.js";
```

- [ ] **Step 4: Check for other imports of the deleted file**

Run: `grep -r "oauth-callback" packages/mcp-server-atlassian/src/ --include="*.ts"`
Expected: no results (proxy.ts now imports from `@devops-agent/shared`, index.ts re-exports removed).

- [ ] **Step 5: Delete the old file**

Run: `rm packages/mcp-server-atlassian/src/atlassian-client/oauth-callback.ts`

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-atlassian/src/atlassian-client/proxy.ts packages/mcp-server-atlassian/src/atlassian-client/index.ts
git rm packages/mcp-server-atlassian/src/atlassian-client/oauth-callback.ts
git commit -m "SIO-651: Migrate Atlassian proxy to shared OAuth callback helper

Delete local oauth-callback.ts, import waitForOAuthCallback from
@devops-agent/shared. Pass port and path as options. Remove stale
re-exports from index.ts. Atlassian OAuth now has a 120s timeout
instead of hanging forever.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full workspace verification

**Goal:** Confirm everything works together after all changes.

**Files:** None

- [ ] **Step 1: Typecheck all packages**

Run: `bun run typecheck`
Expected: clean across all packages.

- [ ] **Step 2: Lint changed files**

Run: `bunx biome check packages/shared/src/oauth-callback.ts packages/shared/src/__tests__/oauth-callback.test.ts packages/shared/src/index.ts packages/mcp-server-gitlab/src/gitlab-client/proxy.ts packages/mcp-server-atlassian/src/atlassian-client/proxy.ts packages/mcp-server-atlassian/src/atlassian-client/index.ts`
Expected: no errors on changed files.

- [ ] **Step 3: Run shared package tests**

Run: `bun test packages/shared/src/`
Expected: all tests pass including 6 new OAuth callback tests.

- [ ] **Step 4: Run agent + gitagent-bridge tests**

Run: `bun test packages/agent/src/ packages/gitagent-bridge/src/`
Expected: 265 pass, 0 fail.

- [ ] **Step 5: No commit**

Verification only.

---

## Task 6: PR prep

**Goal:** Push branch and open PR.

**Files:** None

- [ ] **Step 1: Push the branch**

Run: `git push -u origin sio-651-oauth-callback-timeout`

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "SIO-651: Fix OAuth callback timeout in GitLab and Atlassian" --body "$(cat <<'EOF'
## Summary

- Extract shared `waitForOAuthCallback()` helper into `@devops-agent/shared` with configurable timeout (default 120s)
- Delete duplicate `oauth-callback.ts` from both `mcp-server-gitlab` and `mcp-server-atlassian`
- On timeout: stops server, frees port, rejects with `OAuthCallbackTimeoutError`
- 6 unit tests covering resolve, reject, timeout, port cleanup, 404, and 400 paths

## Test plan

- [ ] `bun test packages/shared/src/__tests__/oauth-callback.test.ts` -- 6 pass
- [ ] `bun run typecheck` -- clean
- [ ] `bun test packages/agent/src/ packages/gitagent-bridge/src/` -- 265 pass, 0 fail
- [ ] Verify no other imports of deleted files remain

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```
