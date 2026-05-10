# GitLab OAuth Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitLab MCP OAuth "seed once, refresh forever" — eliminate the recurring popups in eval/headless runs by using the persisted refresh_token to mint new access tokens silently when GitLab returns 401.

**Architecture:** Lazy refresh inside `GitLabMcpProxy.callTool`. When the SDK throws `UnauthorizedError`, the proxy asks `GitLabOAuthProvider.refreshTokens()` to POST to `${instanceUrl}/oauth/token` with `grant_type=refresh_token`, persists the new tokens via the inherited `saveTokens()`, then retries the original tool call exactly once. A single in-flight refresh is shared across concurrent callers via a `Promise` field on the provider. A new typed error `OAuthRefreshChainExpiredError` distinguishes "refresh chain dead, re-seed" from "never seeded" so the agent's classifier and operator dashboards can tell them apart.

**Tech Stack:** TypeScript strict mode, Bun runtime, `@modelcontextprotocol/sdk` v1.29.0, `bun:test`, Biome for lint, the project's existing `BaseOAuthClientProvider` (`packages/shared/src/oauth/base-provider.ts`).

**Spec:** `docs/superpowers/specs/2026-05-10-gitlab-oauth-refresh-design.md`

**Linear:** [SIO-698](https://linear.app/siobytes/issue/SIO-698)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/oauth/errors.ts` | Modify | Add `OAuthRefreshChainExpiredError` next to the existing `OAuthRequiresInteractiveAuthError` |
| `packages/shared/src/oauth/index.ts` | Modify | Re-export the new error |
| `packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts` | Modify | Add `refreshTokens()` method with concurrent-call dedup |
| `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts` | Modify | Promote `oauthProvider` from local to field; wrap `callTool` with single-retry refresh path |
| `packages/mcp-server-gitlab/test/oauth-refresh.test.ts` | Create | Three TDD tests: happy refresh, dead chain in headless, concurrent dedup |
| `packages/shared/src/oauth/errors.test.ts` | Create | Unit test for the new error type's shape |

No file moves, no renames. Everything else is purely additive.

---

## Task 1: Add `OAuthRefreshChainExpiredError`

**Files:**
- Modify: `packages/shared/src/oauth/errors.ts`
- Modify: `packages/shared/src/oauth/index.ts`
- Test: `packages/shared/src/oauth/errors.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/oauth/errors.test.ts`:

```ts
// src/oauth/errors.test.ts

import { describe, expect, test } from "bun:test";
import { OAuthRefreshChainExpiredError, OAuthRequiresInteractiveAuthError } from "./errors.ts";

describe("OAuthRefreshChainExpiredError", () => {
	test("carries namespace and hint and a message that mentions both", () => {
		const err = new OAuthRefreshChainExpiredError(
			"gitlab",
			"refresh_token rejected by https://gitlab.com; run `bun run oauth:seed:gitlab` to re-seed",
		);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("OAuthRefreshChainExpiredError");
		expect(err.namespace).toBe("gitlab");
		expect(err.hint).toContain("oauth:seed:gitlab");
		expect(err.message).toContain("gitlab");
		expect(err.message).toContain("refresh_token rejected");
	});

	test("is distinct from OAuthRequiresInteractiveAuthError", () => {
		const refresh = new OAuthRefreshChainExpiredError("gitlab", "x");
		const interactive = new OAuthRequiresInteractiveAuthError("gitlab", new URL("https://example.com"));
		expect(refresh).not.toBeInstanceOf(OAuthRequiresInteractiveAuthError);
		expect(interactive).not.toBeInstanceOf(OAuthRefreshChainExpiredError);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/oauth/errors.test.ts`
Expected: FAIL with `OAuthRefreshChainExpiredError` undefined / not exported.

- [ ] **Step 3: Add the new error class**

Append to `packages/shared/src/oauth/errors.ts`:

```ts
export class OAuthRefreshChainExpiredError extends Error {
	readonly namespace: string;
	readonly hint: string;

	constructor(namespace: string, hint: string) {
		super(`OAuth refresh chain expired for ${namespace}: ${hint}`);
		this.name = "OAuthRefreshChainExpiredError";
		this.namespace = namespace;
		this.hint = hint;
	}
}
```

- [ ] **Step 4: Re-export from the oauth barrel**

Edit `packages/shared/src/oauth/index.ts`. Replace the existing errors export line:

```ts
export { OAuthRequiresInteractiveAuthError } from "./errors.ts";
```

with:

```ts
export { OAuthRefreshChainExpiredError, OAuthRequiresInteractiveAuthError } from "./errors.ts";
```

(Biome enforces alphabetical order for named imports/exports; the new symbol sorts before `OAuthRequiresInteractiveAuthError`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/shared/src/oauth/errors.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run typecheck and lint for the shared package**

Run: `bun run --filter @devops-agent/shared typecheck && bun run --filter @devops-agent/shared lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/oauth/errors.ts packages/shared/src/oauth/index.ts packages/shared/src/oauth/errors.test.ts
git commit -m "$(cat <<'EOF'
SIO-698: add OAuthRefreshChainExpiredError typed error

Distinguishes "refresh chain dead, re-seed" from "never seeded"
(OAuthRequiresInteractiveAuthError) so callers and dashboards can
classify the two operator actions separately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```


---

## Task 2: Add `refreshTokens()` method on `GitLabOAuthProvider`

**Files:**
- Modify: `packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts`
- Test: covered indirectly by Task 4 (the integration-shaped tests against the proxy). For this task we add a focused unit test on the provider in isolation.
- Create: `packages/mcp-server-gitlab/test/oauth-refresh.test.ts` — bootstrap with the provider-level tests; the proxy-level tests are added in Task 4.

This task introduces the new behavior on the provider only. The proxy is wired up in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server-gitlab/test/oauth-refresh.test.ts`:

```ts
// test/oauth-refresh.test.ts

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthRefreshChainExpiredError } from "@devops-agent/shared";
import { GitLabOAuthProvider } from "../src/gitlab-client/oauth-provider.js";

const INSTANCE_URL = "https://gitlab.com";
const SANITIZED_KEY = "https___gitlab.com";

let tmpHome: string;
let originalHome: string | undefined;
let originalFetch: typeof fetch;

function tokenFilePath(home: string): string {
	return join(home, ".mcp-auth", "gitlab", `${SANITIZED_KEY}.json`);
}

function seedTokenFile(home: string, payload: Record<string, unknown>): void {
	const dir = join(home, ".mcp-auth", "gitlab");
	mkdirSync(dir, { recursive: true });
	writeFileSync(tokenFilePath(home), JSON.stringify(payload), "utf-8");
}

function makeProvider(): GitLabOAuthProvider {
	return new GitLabOAuthProvider(INSTANCE_URL, 9184, async () => {
		throw new Error("popup should not fire in refresh tests");
	});
}

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "oauth-refresh-test-"));
	originalHome = process.env.HOME;
	process.env.HOME = tmpHome;
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	process.env.HOME = originalHome;
	globalThis.fetch = originalFetch;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("GitLabOAuthProvider.refreshTokens", () => {
	test("posts grant_type=refresh_token and persists rotated tokens", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old-access", refresh_token: "still-good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://gitlab.com/oauth/token");
			expect(init?.method).toBe("POST");
			const body = init?.body as URLSearchParams;
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("still-good");
			expect(body.get("client_id")).toBe("abc123");
			return new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "rotated",
					token_type: "Bearer",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = makeProvider();
		const tokens = await provider.refreshTokens();

		expect(tokens.access_token).toBe("new-access");
		expect(tokens.refresh_token).toBe("rotated");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const onDisk = JSON.parse(readFileSync(tokenFilePath(tmpHome), "utf-8")) as {
			tokens: { access_token: string; refresh_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("new-access");
		expect(onDisk.tokens.refresh_token).toBe("rotated");
	});

	test("throws OAuthRefreshChainExpiredError when refresh_token is missing on disk", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old-access", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = (mock(async () => {
			throw new Error("fetch should not be called when refresh_token is missing");
		}) as unknown) as typeof fetch;

		const provider = makeProvider();
		await expect(provider.refreshTokens()).rejects.toBeInstanceOf(OAuthRefreshChainExpiredError);
	});

	test("throws OAuthRefreshChainExpiredError on 400 invalid_grant", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old-access", refresh_token: "dead", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = (mock(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown) as typeof fetch;

		const provider = makeProvider();
		await expect(provider.refreshTokens()).rejects.toBeInstanceOf(OAuthRefreshChainExpiredError);

		const onDisk = JSON.parse(readFileSync(tokenFilePath(tmpHome), "utf-8")) as {
			tokens: { access_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("old-access");
	});

	test("dedupes concurrent callers into a single fetch", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		let inFlight = 0;
		let maxObserved = 0;
		const fetchMock = mock(async () => {
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight--;
			return new Response(
				JSON.stringify({ access_token: "new", refresh_token: "good", token_type: "Bearer", expires_in: 7200 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = makeProvider();
		const results = await Promise.all([
			provider.refreshTokens(),
			provider.refreshTokens(),
			provider.refreshTokens(),
			provider.refreshTokens(),
			provider.refreshTokens(),
		]);

		expect(results).toHaveLength(5);
		for (const r of results) expect(r.access_token).toBe("new");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(maxObserved).toBe(1);
	});

	test("rethrows network errors as-is so transient classifier handles them", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = (mock(async () => {
			throw new TypeError("fetch failed (ECONNRESET)");
		}) as unknown) as typeof fetch;

		const provider = makeProvider();
		await expect(provider.refreshTokens()).rejects.toThrow(/ECONNRESET/);
		await expect(provider.refreshTokens()).rejects.not.toBeInstanceOf(OAuthRefreshChainExpiredError);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/mcp-server-gitlab/test/oauth-refresh.test.ts`
Expected: FAIL — `provider.refreshTokens is not a function`.

- [ ] **Step 3: Implement `refreshTokens()` on the provider**

Edit `packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts`. Replace the entire file with:

```ts
// src/gitlab-client/oauth-provider.ts

import {
	type AuthorizationHandler,
	BaseOAuthClientProvider,
	OAUTH_CALLBACK_PATH,
	OAuthRefreshChainExpiredError,
	type OAuthProviderLogger,
} from "@devops-agent/shared";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("oauth");

export type { AuthorizationHandler };
export { OAUTH_CALLBACK_PATH };

export class GitLabOAuthProvider extends BaseOAuthClientProvider {
	private readonly instanceUrl: string;
	// SIO-698: shared in-flight promise so 5 parallel sub-agent tool calls
	// hitting an expired token only fire one /oauth/token request.
	private refreshInFlight: Promise<OAuthTokens> | null = null;

	constructor(instanceUrl: string, callbackPort: number, onRedirect: AuthorizationHandler) {
		super({
			storageNamespace: "gitlab",
			storageKey: instanceUrl,
			callbackPort,
			onRedirect,
			logger: log as unknown as OAuthProviderLogger,
		});
		this.instanceUrl = instanceUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "DevOps Incident Analyzer - GitLab MCP Proxy",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// GitLab's /api/v4/mcp DCR registers public clients per RFC 8252; using
			// "client_secret_post" causes silent token-exchange failure (SIO-685)
			// because no secret is issued. PKCE alone proves possession.
			token_endpoint_auth_method: "none",
			// GitLab MR !208967 made `mcp` the default DCR scope; pinning it is
			// belt-and-braces and gives us visibility if defaults change again.
			scope: "mcp",
		};
	}

	// SIO-698: exchange the persisted refresh_token for a fresh access_token.
	// Concurrent callers share one in-flight fetch via refreshInFlight so we
	// never fire parallel /oauth/token requests for the same provider instance.
	async refreshTokens(): Promise<OAuthTokens> {
		if (this.refreshInFlight) return this.refreshInFlight;

		this.refreshInFlight = this.doRefresh().finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	private async doRefresh(): Promise<OAuthTokens> {
		const refreshToken = this.persisted.tokens?.refresh_token;
		if (!refreshToken) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`seeded token file lacks refresh_token; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const clientId = (this.persisted.clientInformation as { client_id?: string } | undefined)?.client_id;
		if (!clientId) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`seeded token file lacks client_id; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const body = new URLSearchParams();
		body.set("grant_type", "refresh_token");
		body.set("refresh_token", refreshToken);
		body.set("client_id", clientId);

		const response = await fetch(`${this.instanceUrl}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});

		if (!response.ok) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`refresh_token rejected by ${this.instanceUrl} (HTTP ${response.status}); run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		const parsed = (await response.json().catch(() => null)) as Partial<OAuthTokens> | null;
		if (!parsed || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
			throw new OAuthRefreshChainExpiredError(
				this.storageNamespace,
				`refresh response from ${this.instanceUrl} missing access_token; run \`bun run oauth:seed:${this.storageNamespace}\` to re-seed`,
			);
		}

		// GitLab may rotate the refresh_token. If a new one came back, persist it;
		// otherwise keep the old one so the chain stays intact.
		const merged: OAuthTokens = {
			access_token: parsed.access_token,
			token_type: parsed.token_type ?? this.persisted.tokens?.token_type ?? "Bearer",
			...(parsed.refresh_token ? { refresh_token: parsed.refresh_token } : { refresh_token: refreshToken }),
			...(parsed.expires_in !== undefined ? { expires_in: parsed.expires_in } : {}),
			...(parsed.scope ? { scope: parsed.scope } : {}),
		};

		this.saveTokens(merged);
		return merged;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/mcp-server-gitlab/test/oauth-refresh.test.ts`
Expected: PASS, 5 tests in this file.

- [ ] **Step 5: Run typecheck and lint for the gitlab MCP package**

Run: `bun run --filter @devops-agent/mcp-server-gitlab typecheck && bun run --filter @devops-agent/mcp-server-gitlab lint`
Expected: both exit 0. If lint flags import order, fix in place (Biome wants `OAuthRefreshChainExpiredError` before `type OAuthProviderLogger` because `O...Refresh...` < `O...Provider...` only after the existing alphabetic comparison; rely on `bun run lint:fix` if needed).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-gitlab/src/gitlab-client/oauth-provider.ts packages/mcp-server-gitlab/test/oauth-refresh.test.ts
git commit -m "$(cat <<'EOF'
SIO-698: add refreshTokens() on GitLabOAuthProvider

Exchanges the persisted refresh_token for a fresh access_token via
${instanceUrl}/oauth/token. Concurrent callers share one in-flight
fetch so parallel sub-agent tool calls never fire duplicate refreshes.
Failures throw OAuthRefreshChainExpiredError with a re-seed hint;
network errors propagate so the transient classifier still retries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire `callTool` to refresh on 401 and retry once

**Files:**
- Modify: `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts`
- Test: extend `packages/mcp-server-gitlab/test/oauth-refresh.test.ts`

This task changes `proxy.ts`'s `connect()` to store the provider as a field and changes `callTool()` to do a single refresh-and-retry on `UnauthorizedError`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-server-gitlab/test/oauth-refresh.test.ts` (inside the file, after the existing `describe(...)` block — keep the existing imports plus the additions noted):

Add at the top of the file (next to the existing imports):

```ts
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { GitLabMcpProxy, type McpClientLike } from "../src/gitlab-client/proxy.js";
```

Then append a new `describe` block at the bottom of the file:

```ts
describe("GitLabMcpProxy.callTool refresh path", () => {
	const baseConfig = {
		instanceUrl: INSTANCE_URL,
		personalAccessToken: "pat",
		timeout: 30000,
		oauthCallbackPort: 9184,
	};

	function makeRefreshingClient(opts: {
		failures: number;
		onCall?: () => void;
	}): McpClientLike {
		let remaining = opts.failures;
		return {
			listTools: async () => ({ tools: [] }),
			callTool: async () => {
				opts.onCall?.();
				if (remaining > 0) {
					remaining--;
					throw new UnauthorizedError("token expired");
				}
				return { ok: true };
			},
		};
	}

	test("refreshes once and retries on UnauthorizedError, then succeeds", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(
			async () =>
				new Response(
					JSON.stringify({ access_token: "fresh", refresh_token: "good", token_type: "Bearer", expires_in: 7200 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const calls: number[] = [];
		const client = makeRefreshingClient({ failures: 1, onCall: () => calls.push(Date.now()) });
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		const result = await proxy.callTool("gitlab_search", { q: "test" });

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(2); // one failed call + one retry
		expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one /oauth/token

		const onDisk = JSON.parse(readFileSync(tokenFilePath(tmpHome), "utf-8")) as {
			tokens: { access_token: string };
		};
		expect(onDisk.tokens.access_token).toBe("fresh");
	});

	test("propagates OAuthRefreshChainExpiredError when refresh fails (headless mode)", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old", refresh_token: "dead", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = (mock(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown) as typeof fetch;

		const prev = process.env.MCP_OAUTH_HEADLESS;
		process.env.MCP_OAUTH_HEADLESS = "true";
		try {
			const client = makeRefreshingClient({ failures: 1 });
			const proxy = new GitLabMcpProxy({ config: baseConfig, client });
			await proxy.connect();

			await expect(proxy.callTool("gitlab_search", { q: "test" })).rejects.toBeInstanceOf(
				OAuthRefreshChainExpiredError,
			);

			const onDisk = JSON.parse(readFileSync(tokenFilePath(tmpHome), "utf-8")) as {
				tokens: { access_token: string };
			};
			expect(onDisk.tokens.access_token).toBe("old"); // unchanged on failure
		} finally {
			process.env.MCP_OAUTH_HEADLESS = prev;
		}
	});

	test("does not retry a second 401 (refresh succeeded but token still rejected)", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "old", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		globalThis.fetch = (mock(
			async () =>
				new Response(
					JSON.stringify({ access_token: "fresh", refresh_token: "good", token_type: "Bearer", expires_in: 7200 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown) as typeof fetch;

		const client = makeRefreshingClient({ failures: 2 }); // both attempts fail
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		await expect(proxy.callTool("gitlab_search", { q: "test" })).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test("happy path: no UnauthorizedError, no refresh fired", async () => {
		seedTokenFile(tmpHome, {
			tokens: { access_token: "fresh", refresh_token: "good", token_type: "Bearer" },
			clientInformation: { client_id: "abc123", token_endpoint_auth_method: "none" },
		});
		const fetchMock = mock(async () => {
			throw new Error("fetch should not be called when token is valid");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const client: McpClientLike = {
			listTools: async () => ({ tools: [] }),
			callTool: async () => ({ ok: true }),
		};
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		const result = await proxy.callTool("gitlab_search", { q: "test" });
		expect(result).toEqual({ ok: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/mcp-server-gitlab/test/oauth-refresh.test.ts`
Expected: the four new tests FAIL — refresh path not wired into `callTool`. The five tests from Task 2 still PASS.

- [ ] **Step 3: Modify the proxy to store the provider as a field**

Edit `packages/mcp-server-gitlab/src/gitlab-client/proxy.ts`. Replace the class field block (currently lines 42-46):

```ts
export class GitLabMcpProxy {
	private sdkClient: Client | null = null;
	private injectedClient: McpClientLike | null = null;
	private transport: StreamableHTTPClientTransport | null = null;
	private connected = false;
	private readonly config: GitLabProxyConfig;
```

with:

```ts
export class GitLabMcpProxy {
	private sdkClient: Client | null = null;
	private injectedClient: McpClientLike | null = null;
	private transport: StreamableHTTPClientTransport | null = null;
	private connected = false;
	private readonly config: GitLabProxyConfig;
	// SIO-698: kept as a field (not a connect-local) so callTool can ask it
	// to refresh tokens when the SDK throws UnauthorizedError mid-flight.
	private oauthProvider: GitLabOAuthProvider | null = null;
```

- [ ] **Step 4: Promote the local provider in `connect()` to assign the field**

In the same file, find the `connect()` method (around lines 67-124) and locate the existing block that creates the provider (lines 76-90):

```ts
		const oauthProvider = new GitLabOAuthProvider(
			this.config.instanceUrl,
			this.config.oauthCallbackPort,
			async (authUrl) => {
```

Change the first line of that block:

```ts
		const oauthProvider = new GitLabOAuthProvider(
```

to:

```ts
		this.oauthProvider = new GitLabOAuthProvider(
```

Then, in the same `connect()` method, replace every subsequent reference to the local `oauthProvider` symbol (currently used as `authProvider: oauthProvider` on lines 93 and 116) with `authProvider: this.oauthProvider`.

After the change those two lines should read:

```ts
		this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: this.oauthProvider });
```

(both occurrences). The local `const oauthProvider = ...` declaration is gone; the variable now lives on the instance.

- [ ] **Step 5: Wrap `callTool` with refresh-and-retry**

In the same file, replace the entire current `callTool` method (currently lines 142-149):

```ts
	async callTool(toolName: string, args: Record<string, unknown>, options?: { timeout?: number }): Promise<unknown> {
		if (!this.connected) {
			throw new Error("Not connected to GitLab MCP server. Call connect() first.");
		}

		log.debug({ tool: toolName }, "Forwarding tool call to GitLab MCP");
		return this.client.callTool({ name: toolName, arguments: args }, undefined, options);
	}
```

with:

```ts
	async callTool(toolName: string, args: Record<string, unknown>, options?: { timeout?: number }): Promise<unknown> {
		if (!this.connected) {
			throw new Error("Not connected to GitLab MCP server. Call connect() first.");
		}

		log.debug({ tool: toolName }, "Forwarding tool call to GitLab MCP");
		try {
			return await this.client.callTool({ name: toolName, arguments: args }, undefined, options);
		} catch (error) {
			// SIO-698: lazy refresh on 401. We retry exactly once; a second 401
			// means refresh succeeded but the new token is also rejected, which is
			// not something a second refresh would fix. Refresh failures
			// (OAuthRefreshChainExpiredError) propagate untouched so the agent's
			// auth-error classifier marks gitlab as non-retryable.
			if (!(error instanceof UnauthorizedError) || !this.oauthProvider) {
				throw error;
			}
			log.info({ tool: toolName }, "Tool call returned 401; attempting silent token refresh");
			await this.oauthProvider.refreshTokens();
			return this.client.callTool({ name: toolName, arguments: args }, undefined, options);
		}
	}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/mcp-server-gitlab/test/oauth-refresh.test.ts`
Expected: PASS, 9 tests total (5 from Task 2, 4 from Task 3).

- [ ] **Step 7: Run the full GitLab MCP test suite**

Run: `bun run --filter @devops-agent/mcp-server-gitlab test`
Expected: all tests pass (oauth-refresh.test.ts plus the existing proxy.test.ts, oauth-provider.test.ts).

- [ ] **Step 8: Run typecheck and lint**

Run: `bun run --filter @devops-agent/mcp-server-gitlab typecheck && bun run --filter @devops-agent/mcp-server-gitlab lint`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-server-gitlab/src/gitlab-client/proxy.ts packages/mcp-server-gitlab/test/oauth-refresh.test.ts
git commit -m "$(cat <<'EOF'
SIO-698: refresh GitLab OAuth tokens lazily on 401 in proxy.callTool

Promotes the GitLabOAuthProvider from connect()-local to a class
field so callTool can reach it. On UnauthorizedError, calls
provider.refreshTokens() once and retries the original tool call.
A second 401 propagates unmodified. Refresh failures throw
OAuthRefreshChainExpiredError up the stack for the agent's
classifier to mark gitlab non-retryable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Workspace-wide validation

**Files:** none modified. This task is a verification gate before merge.

- [ ] **Step 1: Run typecheck across the whole workspace**

Run: `bun run typecheck`
Expected: every package exits 0. Investigate any failure before proceeding — most likely culprits are stale fixtures referencing the old (non-async) `tokens()` shape, but none should exist since this plan only adds new code.

- [ ] **Step 2: Run the full test suite for all packages that touch OAuth**

Run: `bun run --filter @devops-agent/shared --filter @devops-agent/mcp-server-gitlab test`
Expected: all tests pass.

- [ ] **Step 3: Run lint across the workspace**

Run: `bun run lint`
Expected: clean, modulo any pre-existing info-level Biome schema notes (the project's `biome.json` may show a schema-version info line that is unrelated to this work).

- [ ] **Step 4: Smoke check that the seed script still typechecks**

Run: `bun run --filter @devops-agent/mcp-server-gitlab typecheck`
Expected: exits 0. The seed script imports `seedOAuth` and the provider; the only public surface change on the provider is the new `refreshTokens()` method (purely additive), so the seed path stays compatible.

- [ ] **Step 5: Verify the LangSmith / agent package didn't drift**

Run: `bun run --filter @devops-agent/agent typecheck && bun run --filter @devops-agent/agent test`
Expected: both exit 0. The agent package doesn't import the OAuth code directly (it imports MCP tools through `@langchain/mcp-adapters`), so this is a sanity gate, not a real risk surface.

---

## Task 5: Manual verification

**Files:** none.

These steps require a real GitLab instance and cannot be automated as-is. Run them in a separate session against a non-production GitLab.

- [ ] **Step 1: Seed a fresh token**

Run: `bun run oauth:seed:gitlab`
Complete the popup. Confirm `~/.mcp-auth/gitlab/<sanitized-instance>.json` contains both `tokens.access_token` and `tokens.refresh_token`.

- [ ] **Step 2: Force the access token to expire**

Edit the on-disk file: change `tokens.expires_at` to a past timestamp (or just wait ~2 hours for natural expiry). Do NOT touch `refresh_token`.

- [ ] **Step 3: Run a GitLab tool call in headless mode**

```bash
MCP_OAUTH_HEADLESS=true bun run --filter @devops-agent/web dev
```

In another terminal, trigger a chat that invokes a GitLab tool (e.g. ask the agent to search a repo).

Expected: the call succeeds with no popup. The on-disk `access_token` has been updated. Logs include the line "Tool call returned 401; attempting silent token refresh" exactly once for the affected tool.

- [ ] **Step 4: Simulate a dead refresh chain**

Manually edit the on-disk file: change `tokens.refresh_token` to a clearly-invalid string (e.g. `"deliberately-invalid"`).

Run the same agent query in headless mode.

Expected: the GitLab data-source returns a non-retryable auth error in the report. The error message hints at `bun run oauth:seed:gitlab`. No popup. No infinite retry.

- [ ] **Step 5: Recovery via re-seed**

Run: `bun run oauth:seed:gitlab` (one popup, by design — this is the dead-chain re-seed path).
Re-run the agent query. Expected: works again, no further popups.

---

## Out of Scope (explicitly)

- Atlassian, Konnect, or any other OAuth-using MCP server. The same pattern is portable to them but adds risk this plan does not need to take. Track separately when a second consumer asks.
- Lifting refresh into `BaseOAuthClientProvider`. Same reason.
- Background pre-emptive refresh. Lazy refresh on 401 is sufficient for the bursty incident-analysis workload.
- Changing the seed script. The provider already declares `grant_types: ["authorization_code", "refresh_token"]` and `scope: "mcp"` (oauth-provider.ts:32-40), so the seeded file should already include `refresh_token`. The runtime guard in `refreshTokens()` makes any contrary reality immediately visible with a clear error.

---

## Self-Review Notes

- **Spec coverage check:** Every component, data-flow path, and error-handling row from the spec has a task or test that exercises it. Concurrent dedup → Task 2 step 1 test "dedupes concurrent callers". Dead chain in headless → Task 3 step 1 test. Happy path no-refresh → Task 3 step 1 test. Refresh-token rotation → Task 2 step 1 test asserts on-disk `refresh_token` matches the response. Network errors propagate → Task 2 step 1 test "rethrows network errors as-is".
- **Type consistency check:** `refreshTokens()` returns `Promise<OAuthTokens>` everywhere (Task 2 implementation, Task 3 callsite, Task 2 test type assertion). `OAuthRefreshChainExpiredError(namespace, hint)` is constructed with the same `(namespace, hint)` shape in Task 1 implementation, Task 1 test, and Task 2 implementation. `oauthProvider` field type is `GitLabOAuthProvider | null` in Task 3 step 3 declaration and used safely with a null-check in Task 3 step 5.
- **Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" left in the plan. All `SIO-698` references are concrete (Linear issue created 2026-05-10).
