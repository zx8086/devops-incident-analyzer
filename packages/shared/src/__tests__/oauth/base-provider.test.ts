// src/__tests__/oauth/base-provider.test.ts

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
	BaseOAuthClientProvider,
	REFRESH_LOCK_STALE_THRESHOLD_MS,
	REFRESH_LOCK_TIMEOUT_MS,
	STALE_INVALIDATION_WINDOW_MS,
	TOKEN_EXPIRY_SKEW_MS,
} from "../../oauth/base-provider.ts";
import { OAuthRefreshLockTimeoutError, OAuthRequiresInteractiveAuthError } from "../../oauth/errors.ts";

const TEST_NAMESPACE = "__base-provider-test__";
const STORAGE_DIR = join(homedir(), ".mcp-auth", TEST_NAMESPACE);

function cleanup() {
	if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
}

class TestProvider extends BaseOAuthClientProvider {
	// SIO-702: stub for ensureFreshTokens()'s required protected doRefresh().
	// Tests inject the desired behaviour by reassigning this field.
	refreshImpl: () => Promise<OAuthTokens> = async () => {
		throw new Error("refreshImpl not configured for this test");
	};

	override get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "test",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	protected override async doRefresh(): Promise<OAuthTokens> {
		const tokens = await this.refreshImpl();
		this.saveTokens(tokens);
		return tokens;
	}

	// Test seam to drive ensureFreshTokens() like a subclass would.
	publicEnsureFreshTokens(): Promise<OAuthTokens | undefined> {
		return this.ensureFreshTokens();
	}

	// SIO-747: test seam for the cross-process lock + post-reload retry path.
	publicLockedRefresh(): Promise<OAuthTokens> {
		return this.lockedRefresh();
	}

	// SIO-747: drive acquireRefreshLock directly so the lock-timeout test can
	// hold the lock and observe a contender's failure mode.
	publicAcquireRefreshLock(): Promise<() => void> {
		return this.acquireRefreshLock();
	}
}

function makeProvider(
	overrides: Partial<{
		key: string;
		port: number;
		onRedirect: (u: URL) => void;
		clock: () => number;
	}> = {},
): TestProvider {
	return new TestProvider({
		storageNamespace: TEST_NAMESPACE,
		storageKey: overrides.key ?? "test-key",
		callbackPort: overrides.port ?? 9999,
		onRedirect: overrides.onRedirect ?? (() => {}),
		clock: overrides.clock,
	});
}

// SIO-702: simple monotonic clock that advances on each call. Tests use this
// when they need to cross the STALE_INVALIDATION_WINDOW_MS boundary between
// saveTokens() (records lastSaveAt) and invalidateCredentials() (reads it).
function makeAdvancingClock(stepMs: number, start = 1_000_000): () => number {
	let t = start;
	return () => {
		const v = t;
		t += stepMs;
		return v;
	};
}

describe("BaseOAuthClientProvider", () => {
	beforeEach(cleanup);
	afterEach(cleanup);
	afterEach(() => {
		delete process.env.MCP_OAUTH_HEADLESS;
	});

	test("redirectUrl uses configured callback port", () => {
		const provider = makeProvider({ port: 9876 });
		expect(provider.redirectUrl).toBe("http://localhost:9876/oauth/callback");
	});

	test("saveTokens persists to sanitized file path with mode 0o600", () => {
		const provider = makeProvider({ key: "https://example.com/v1/mcp" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });

		const sanitized = "https___example.com_v1_mcp";
		const path = join(STORAGE_DIR, `${sanitized}.json`);
		expect(existsSync(path)).toBe(true);

		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.tokens.access_token).toBe("tkn");
	});

	test("file mode is enforced via chmod even on pre-existing world-readable files", () => {
		const sanitized = "preexisting";
		const path = join(STORAGE_DIR, `${sanitized}.json`);
		// Simulate a file written by an older buggy version with mode 0o644.
		require("node:fs").mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(path, "{}", { encoding: "utf-8", mode: 0o644 });
		expect(statSync(path).mode & 0o777).toBe(0o644);

		const provider = makeProvider({ key: sanitized });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("persistence round-trip: tokens survive across instances keyed by storageKey", async () => {
		const a = makeProvider({ key: "round-trip" });
		a.saveTokens({ access_token: "first", token_type: "bearer" });

		const b = makeProvider({ key: "round-trip" });
		expect((await b.tokens())?.access_token).toBe("first");
	});

	test("invalidateCredentials matrix", async () => {
		const provider = makeProvider({ clock: () => 1_000_000 });
		provider.saveClientInformation({ client_id: "c1" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		provider.saveCodeVerifier("verifier-1");

		// SIO-702: stale-wipe guard suppresses 'tokens' invalidation within
		// STALE_INVALIDATION_WINDOW_MS of saveTokens. Use a clock ahead of the
		// window to exercise the canonical wipe path.
		const lateProvider = makeProvider({ clock: makeAdvancingClock(STALE_INVALIDATION_WINDOW_MS + 1_000) });
		lateProvider.saveClientInformation({ client_id: "c1" });
		lateProvider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		lateProvider.saveCodeVerifier("verifier-1");

		lateProvider.invalidateCredentials("tokens");
		expect(await lateProvider.tokens()).toBeUndefined();
		expect(lateProvider.clientInformation()?.client_id).toBe("c1");

		lateProvider.invalidateCredentials("verifier");
		expect(() => lateProvider.codeVerifier()).toThrow();

		lateProvider.invalidateCredentials("client");
		expect(lateProvider.clientInformation()).toBeUndefined();

		// 'all' bypasses the guard intentionally.
		provider.invalidateCredentials("all");
		expect(await provider.tokens()).toBeUndefined();
	});

	test("redirectToAuthorization invokes onRedirect when not headless", async () => {
		let invokedWith: URL | undefined;
		const provider = makeProvider({
			onRedirect: (url) => {
				invokedWith = url;
			},
		});

		await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
		expect(invokedWith?.toString()).toBe("https://auth.example.com/authorize");
	});

	test("redirectToAuthorization throws OAuthRequiresInteractiveAuthError when MCP_OAUTH_HEADLESS=true", async () => {
		process.env.MCP_OAUTH_HEADLESS = "true";
		const provider = makeProvider();

		try {
			await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(OAuthRequiresInteractiveAuthError);
			const e = error as OAuthRequiresInteractiveAuthError;
			expect(e.namespace).toBe(TEST_NAMESPACE);
			expect(e.authorizationUrl.toString()).toBe("https://auth.example.com/authorize");
		}
	});

	test("clientInformation discards stale registration when auth_method mismatches", () => {
		const provider = makeProvider();
		// Persist a registration as if from an older codebase using client_secret_post.
		provider.saveClientInformation({
			client_id: "stale",
			token_endpoint_auth_method: "client_secret_post",
		} as Parameters<typeof provider.saveClientInformation>[0]);

		// New code expects "none" — the persisted record should be discarded silently.
		expect(provider.clientInformation()).toBeUndefined();

		// And the on-disk file should reflect the discard.
		const path = join(STORAGE_DIR, "test-key.json");
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.clientInformation).toBeUndefined();
	});

	test("clientInformation preserves persisted record when auth_method is absent (legacy fixtures)", () => {
		const provider = makeProvider();
		// Older test fixtures and persisted DCR responses may not carry an explicit
		// token_endpoint_auth_method. The migration path must trust those records.
		provider.saveClientInformation({ client_id: "legacy" });
		expect(provider.clientInformation()?.client_id).toBe("legacy");
	});

	test("saveTokens clears persisted codeVerifier (one-shot per flow)", () => {
		const provider = makeProvider();
		provider.saveCodeVerifier("verifier-2");
		expect(() => provider.codeVerifier()).not.toThrow();

		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		expect(() => provider.codeVerifier()).toThrow();
	});

	test("sanitization: filename matches the byte-identical Atlassian shape", () => {
		// Regression guard: this snapshot ties the sanitization regex to the existing
		// on-disk filename users have for `https://mcp.atlassian.com/v1/mcp`. Any
		// regex change here would log existing users out by re-keying their state.
		const provider = makeProvider({ key: "https://mcp.atlassian.com/v1/mcp" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });

		const expectedPath = join(STORAGE_DIR, "https___mcp.atlassian.com_v1_mcp.json");
		expect(existsSync(expectedPath)).toBe(true);
	});

	// SIO-702: refresh-on-read + stale-wipe guard
	describe("ensureFreshTokens (SIO-702)", () => {
		test("saveTokens stamps tokenObtainedAt on disk", () => {
			const provider = makeProvider({ clock: () => 12_345_678 });
			provider.saveTokens({ access_token: "a", token_type: "bearer", expires_in: 7200 });

			const path = join(STORAGE_DIR, "test-key.json");
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
				tokens?: { access_token?: string };
				tokenObtainedAt?: number;
			};
			expect(parsed.tokenObtainedAt).toBe(12_345_678);
		});

		test("returns persisted as-is when within skew (no refresh)", async () => {
			let now = 1_000_000;
			const provider = makeProvider({ clock: () => now });
			provider.saveTokens({ access_token: "still-fresh", token_type: "bearer", expires_in: 7200 });

			const refreshSpy = mock(async () => {
				throw new Error("refresh must not be called");
			});
			provider.refreshImpl = refreshSpy;

			now += 1_000; // 1s later, well within 7200s - 60s skew
			const result = await provider.publicEnsureFreshTokens();
			expect(result?.access_token).toBe("still-fresh");
			expect(refreshSpy).not.toHaveBeenCalled();
		});

		test("treats legacy file without tokenObtainedAt as expired (self-heal)", async () => {
			// Simulate a pre-SIO-702 file by writing raw JSON without tokenObtainedAt.
			const path = join(STORAGE_DIR, "test-key.json");
			require("node:fs").mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
			writeFileSync(
				path,
				JSON.stringify({ tokens: { access_token: "old", refresh_token: "r", token_type: "bearer", expires_in: 7200 } }),
				"utf-8",
			);

			let refreshCount = 0;
			const provider = makeProvider({ clock: () => 1_000_000 });
			provider.refreshImpl = async () => {
				refreshCount++;
				return { access_token: "new", refresh_token: "r", token_type: "bearer", expires_in: 7200 };
			};

			const result = await provider.publicEnsureFreshTokens();
			expect(result?.access_token).toBe("new");
			expect(refreshCount).toBe(1);
		});

		test("single-flight: 10 concurrent ensureFreshTokens calls trigger one doRefresh", async () => {
			const provider = makeProvider({ clock: () => 9_999_999_999_999 });
			// Pre-persist an "expired" token (tokenObtainedAt at epoch 0 + small expires_in).
			provider.saveTokens({ access_token: "old", refresh_token: "r", token_type: "bearer", expires_in: 1 });
			// Reset lastSaveAt so the stale-wipe guard does not interfere later.
			(provider as unknown as { lastSaveAt: number }).lastSaveAt = 0;
			(provider as unknown as { persisted: { tokenObtainedAt?: number } }).persisted.tokenObtainedAt = 0;

			let inFlight = 0;
			let maxObserved = 0;
			let refreshCount = 0;
			provider.refreshImpl = async () => {
				inFlight++;
				maxObserved = Math.max(maxObserved, inFlight);
				refreshCount++;
				await new Promise((r) => setTimeout(r, 30));
				inFlight--;
				return { access_token: "fresh", refresh_token: "r", token_type: "bearer", expires_in: 7200 };
			};

			const results = await Promise.all(Array.from({ length: 10 }, () => provider.publicEnsureFreshTokens()));

			expect(refreshCount).toBe(1);
			expect(maxObserved).toBe(1);
			for (const r of results) expect(r?.access_token).toBe("fresh");
		});

		test("returns undefined when nothing is persisted", async () => {
			const provider = makeProvider();
			const result = await provider.publicEnsureFreshTokens();
			expect(result).toBeUndefined();
		});

		test("propagates doRefresh errors to all concurrent waiters", async () => {
			const provider = makeProvider({ clock: () => 9_999_999_999_999 });
			provider.saveTokens({ access_token: "old", refresh_token: "r", token_type: "bearer", expires_in: 1 });
			(provider as unknown as { lastSaveAt: number }).lastSaveAt = 0;
			(provider as unknown as { persisted: { tokenObtainedAt?: number } }).persisted.tokenObtainedAt = 0;

			provider.refreshImpl = async () => {
				await new Promise((r) => setTimeout(r, 10));
				throw new Error("refresh chain expired");
			};

			const settled = await Promise.allSettled(Array.from({ length: 5 }, () => provider.publicEnsureFreshTokens()));
			expect(settled.every((s) => s.status === "rejected")).toBe(true);
			for (const s of settled) {
				expect(s.status === "rejected" && (s.reason as Error).message).toBe("refresh chain expired");
			}
		});
	});

	// SIO-747: proactive refresh keep-alive
	describe("startProactiveRefresh (SIO-747)", () => {
		// Tests use fake timers via Bun's setTimeout/clearInterval visibility by
		// driving the interval handler manually rather than waiting on wall time.
		// The handler is registered with setInterval inside startProactiveRefresh,
		// so we tick it by waiting a tiny real interval.

		test("tick fires a refresh when tokens are persisted", async () => {
			const provider = makeProvider({ clock: () => 9_999_999_999_999 });
			provider.saveTokens({ access_token: "old", refresh_token: "r", token_type: "bearer", expires_in: 1 });
			(provider as unknown as { lastSaveAt: number }).lastSaveAt = 0;
			(provider as unknown as { persisted: { tokenObtainedAt?: number } }).persisted.tokenObtainedAt = 0;

			let refreshCount = 0;
			provider.refreshImpl = async () => {
				refreshCount++;
				return { access_token: "fresh", refresh_token: "r", token_type: "bearer", expires_in: 7200 };
			};

			const stop = provider.startProactiveRefresh(20);
			await new Promise((r) => setTimeout(r, 60));
			stop();

			expect(refreshCount).toBeGreaterThanOrEqual(1);
		});

		test("terminal refresh failure stops the interval (no further ticks)", async () => {
			const provider = makeProvider({ clock: () => 9_999_999_999_999 });
			provider.saveTokens({ access_token: "old", refresh_token: "r", token_type: "bearer", expires_in: 1 });
			(provider as unknown as { lastSaveAt: number }).lastSaveAt = 0;
			(provider as unknown as { persisted: { tokenObtainedAt?: number } }).persisted.tokenObtainedAt = 0;

			let refreshCount = 0;
			provider.refreshImpl = async () => {
				refreshCount++;
				throw new Error("refresh chain expired");
			};

			const stop = provider.startProactiveRefresh(20);
			await new Promise((r) => setTimeout(r, 120));
			stop();

			// The interval should have stopped itself after the first failure, so
			// even though we waited long enough for ~6 ticks at 20ms, refreshCount
			// is 1 (not 6).
			expect(refreshCount).toBe(1);
		});

		test("stop function clears the interval (no refreshes after stop)", async () => {
			const provider = makeProvider({ clock: () => 9_999_999_999_999 });
			provider.saveTokens({ access_token: "old", refresh_token: "r", token_type: "bearer", expires_in: 1 });
			(provider as unknown as { lastSaveAt: number }).lastSaveAt = 0;
			(provider as unknown as { persisted: { tokenObtainedAt?: number } }).persisted.tokenObtainedAt = 0;

			let refreshCount = 0;
			provider.refreshImpl = async () => {
				refreshCount++;
				return { access_token: "fresh", refresh_token: "r", token_type: "bearer", expires_in: 7200 };
			};

			const stop = provider.startProactiveRefresh(20);
			await new Promise((r) => setTimeout(r, 60));
			const countAtStop = refreshCount;
			stop();
			await new Promise((r) => setTimeout(r, 80));

			expect(refreshCount).toBe(countAtStop);
		});

		test("no-op when no tokens are persisted (ensureFreshTokens returns undefined)", async () => {
			const provider = makeProvider({ clock: () => 1_000_000 });

			let refreshCount = 0;
			provider.refreshImpl = async () => {
				refreshCount++;
				return { access_token: "should-not-happen", token_type: "bearer", expires_in: 7200 };
			};

			const stop = provider.startProactiveRefresh(20);
			await new Promise((r) => setTimeout(r, 60));
			stop();

			expect(refreshCount).toBe(0);
		});
	});

	// SIO-747: cross-process refresh lock + reload-before-refresh.
	// Two providers sharing storageNamespace+storageKey simulate two host
	// processes (workspace dev + Claude Desktop stdio) that share the on-disk
	// token file. The file lock is the cross-process coordination point that
	// the in-process refreshInFlight Promise cannot provide on its own.
	describe("cross-process refresh lock (SIO-747)", () => {
		const sharedKey = "cross-process-test-key";

		function seedExpiredOnDisk(): void {
			const path = join(STORAGE_DIR, `${sharedKey}.json`);
			require("node:fs").mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
			writeFileSync(
				path,
				JSON.stringify({
					tokens: { access_token: "R0-access", refresh_token: "R0-refresh", token_type: "Bearer", expires_in: 1 },
					tokenObtainedAt: 0,
				}),
				"utf-8",
			);
		}

		test("loser reloads after lock and skips POST when winner already rotated", async () => {
			seedExpiredOnDisk();

			const providerA = makeProvider({ key: sharedKey });
			const providerB = makeProvider({ key: sharedKey });

			let aRefreshCount = 0;
			let bRefreshCount = 0;
			providerA.refreshImpl = async () => {
				aRefreshCount++;
				await new Promise((r) => setTimeout(r, 50));
				return { access_token: "R1-access", refresh_token: "R1-refresh", token_type: "Bearer", expires_in: 7200 };
			};
			providerB.refreshImpl = async () => {
				bRefreshCount++;
				return { access_token: "B-WRONG", refresh_token: "B-WRONG", token_type: "Bearer", expires_in: 7200 };
			};

			const aPromise = providerA.publicEnsureFreshTokens();
			// Stagger B's start so A gets the lock first; B then blocks on it.
			await new Promise((r) => setTimeout(r, 5));
			const bPromise = providerB.publicEnsureFreshTokens();

			const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

			// Winner: A POSTed once and got R1.
			expect(aRefreshCount).toBe(1);
			expect(aResult?.access_token).toBe("R1-access");
			// Loser: B reloaded after acquiring the lock, saw R1 (not expired), skipped its POST.
			expect(bRefreshCount).toBe(0);
			expect(bResult?.access_token).toBe("R1-access");
		});

		test("lockedRefresh path skips POST when another process rotated the access_token", async () => {
			seedExpiredOnDisk();

			const providerA = makeProvider({ key: sharedKey });
			const providerB = makeProvider({ key: sharedKey });

			let aRefreshCount = 0;
			let bRefreshCount = 0;
			providerA.refreshImpl = async () => {
				aRefreshCount++;
				await new Promise((r) => setTimeout(r, 50));
				return { access_token: "R1-access", refresh_token: "R1-refresh", token_type: "Bearer", expires_in: 7200 };
			};
			providerB.refreshImpl = async () => {
				bRefreshCount++;
				return { access_token: "B-WRONG", refresh_token: "B-WRONG", token_type: "Bearer", expires_in: 7200 };
			};

			// A goes through the proactive/lazy refresh path, B simulates the proxy's
			// post-401 defense-in-depth path which calls lockedRefresh directly.
			const aPromise = providerA.publicEnsureFreshTokens();
			await new Promise((r) => setTimeout(r, 5));
			const bPromise = providerB.publicLockedRefresh();

			const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

			expect(aRefreshCount).toBe(1);
			expect(aResult?.access_token).toBe("R1-access");
			// B entered with persisted access_token = "R0-access"; after acquiring
			// the lock and reloading, on-disk access_token is "R1-access" (different),
			// so B returns the on-disk token without POSTing.
			expect(bRefreshCount).toBe(0);
			expect(bResult.access_token).toBe("R1-access");
		});

		test("stale lock with dead PID is reclaimed", async () => {
			seedExpiredOnDisk();

			// Pre-create a stale lock attributed to a PID that cannot exist.
			// process.kill(99999999, 0) reliably throws ESRCH on macOS/Linux.
			const lockPath = join(STORAGE_DIR, `${sharedKey}.json.lock`);
			writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: Date.now() }), {
				encoding: "utf-8",
				mode: 0o600,
			});
			expect(existsSync(lockPath)).toBe(true);

			const provider = makeProvider({ key: sharedKey });
			let refreshCount = 0;
			provider.refreshImpl = async () => {
				refreshCount++;
				return { access_token: "fresh", refresh_token: "rot", token_type: "Bearer", expires_in: 7200 };
			};

			const result = await provider.publicEnsureFreshTokens();

			expect(result?.access_token).toBe("fresh");
			expect(refreshCount).toBe(1);
			expect(existsSync(lockPath)).toBe(false);
		});

		test("stale lock older than threshold is reclaimed even if PID is alive", async () => {
			seedExpiredOnDisk();

			// Hand-write a lock owned by *this* test process (alive) but with an
			// acquiredAt far in the past. The age-based reclaim path must still fire.
			const lockPath = join(STORAGE_DIR, `${sharedKey}.json.lock`);
			const ancientAcquiredAt = Date.now() - REFRESH_LOCK_STALE_THRESHOLD_MS - 5_000;
			writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: ancientAcquiredAt }), {
				encoding: "utf-8",
				mode: 0o600,
			});

			const provider = makeProvider({ key: sharedKey });
			let refreshCount = 0;
			provider.refreshImpl = async () => {
				refreshCount++;
				return { access_token: "fresh", refresh_token: "rot", token_type: "Bearer", expires_in: 7200 };
			};

			const result = await provider.publicEnsureFreshTokens();

			expect(result?.access_token).toBe("fresh");
			expect(refreshCount).toBe(1);
		});

		test(
			"contender throws OAuthRefreshLockTimeoutError when lock is held past timeout",
			async () => {
				seedExpiredOnDisk();

				// Holder acquires and never releases until the test ends.
				const holder = makeProvider({ key: sharedKey });
				const release = await holder.publicAcquireRefreshLock();

				try {
					const contender = makeProvider({ key: sharedKey });
					contender.refreshImpl = async () => {
						throw new Error("refresh must not be reached when the lock is contended");
					};

					// Drive ensureFreshTokens; expect the lock acquire to time out.
					// REFRESH_LOCK_TIMEOUT_MS is 10s in production; bun:test default
					// timeout is 5s, so we need to extend this test's timeout.
					await expect(contender.publicEnsureFreshTokens()).rejects.toBeInstanceOf(OAuthRefreshLockTimeoutError);
				} finally {
					release();
				}
			},
			REFRESH_LOCK_TIMEOUT_MS + 5_000,
		);

		test("AgentCore single-process case: lock is uncontended, no perceptible latency", async () => {
			seedExpiredOnDisk();

			const provider = makeProvider({ key: sharedKey });
			provider.refreshImpl = async () => ({
				access_token: "fresh",
				refresh_token: "rot",
				token_type: "Bearer",
				expires_in: 7200,
			});

			const t0 = Date.now();
			const result = await provider.publicEnsureFreshTokens();
			const elapsed = Date.now() - t0;

			expect(result?.access_token).toBe("fresh");
			// First-attempt openSync('wx') succeeds; the only real work is the
			// refreshImpl resolution. Generous bound to avoid flaky CI.
			expect(elapsed).toBeLessThan(500);
		});

		test("release is idempotent (does not throw if lock file already removed)", async () => {
			seedExpiredOnDisk();
			const provider = makeProvider({ key: sharedKey });
			const release = await provider.publicAcquireRefreshLock();

			const lockPath = join(STORAGE_DIR, `${sharedKey}.json.lock`);
			rmSync(lockPath);
			expect(existsSync(lockPath)).toBe(false);

			expect(() => release()).not.toThrow();
		});
	});

	// SIO-702: stale-wipe guard
	describe("invalidateCredentials stale-wipe guard (SIO-702)", () => {
		test("ignores invalidate('tokens') within STALE_INVALIDATION_WINDOW_MS of saveTokens", async () => {
			const warnLogs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
			const captureLogger = {
				info: () => {},
				warn: (obj: Record<string, unknown>, msg: string) => {
					warnLogs.push({ obj, msg });
				},
				error: () => {},
			};
			const provider = new TestProvider({
				storageNamespace: TEST_NAMESPACE,
				storageKey: "test-key",
				callbackPort: 9999,
				onRedirect: () => {},
				logger: captureLogger,
				clock: makeAdvancingClock(100),
			});

			provider.saveTokens({ access_token: "fresh", token_type: "bearer", expires_in: 7200 });
			provider.invalidateCredentials("tokens");

			const onDisk = JSON.parse(readFileSync(join(STORAGE_DIR, "test-key.json"), "utf-8")) as {
				tokens?: { access_token?: string };
			};
			expect(onDisk.tokens?.access_token).toBe("fresh");
			expect(warnLogs).toHaveLength(1);
			expect(warnLogs[0]?.msg).toContain("stale-wipe guard");
		});

		test("honours invalidate('tokens') after the window elapses", async () => {
			const provider = makeProvider({ clock: makeAdvancingClock(STALE_INVALIDATION_WINDOW_MS + 100) });
			provider.saveTokens({ access_token: "fresh", token_type: "bearer", expires_in: 7200 });
			provider.invalidateCredentials("tokens");

			const onDisk = JSON.parse(readFileSync(join(STORAGE_DIR, "test-key.json"), "utf-8")) as {
				tokens?: unknown;
				tokenObtainedAt?: number;
			};
			expect(onDisk.tokens).toBeUndefined();
			expect(onDisk.tokenObtainedAt).toBeUndefined();
		});

		test("invalidate('all') bypasses the guard", async () => {
			const provider = makeProvider({ clock: makeAdvancingClock(100) });
			provider.saveClientInformation({ client_id: "c1" });
			provider.saveTokens({ access_token: "fresh", token_type: "bearer", expires_in: 7200 });
			provider.invalidateCredentials("all");

			expect(await provider.tokens()).toBeUndefined();
			expect(provider.clientInformation()).toBeUndefined();
		});

		test("invalidate('client') and 'verifier' are unaffected by the token-save timestamp", () => {
			const provider = makeProvider({ clock: makeAdvancingClock(100) });
			provider.saveClientInformation({ client_id: "c1" });
			provider.saveCodeVerifier("v");
			provider.saveTokens({ access_token: "fresh", token_type: "bearer" });

			provider.invalidateCredentials("client");
			expect(provider.clientInformation()).toBeUndefined();

			provider.invalidateCredentials("verifier");
			expect(() => provider.codeVerifier()).toThrow();
		});

		test("guard window is exclusive: skew constants exposed for downstream tuning", () => {
			expect(STALE_INVALIDATION_WINDOW_MS).toBeGreaterThan(0);
			expect(TOKEN_EXPIRY_SKEW_MS).toBeGreaterThan(0);
		});
	});
});
