// src/oauth/doctor.ts

import { existsSync, readFileSync } from "node:fs";
import type { PersistedOAuthState } from "./base-provider.ts";
import { getOAuthStoragePath } from "./base-provider.ts";

// SIO-894: read-only OAuth health diagnostic. Answers "is OAuth the problem?"
// without opening a browser or mutating any state. Built because seedOAuth's
// "already authorized" and hasSeededTokens' file-presence check tell an operator
// nothing about scope, expiry, or live status -- so "token already exists" hid a
// healthy token while a separate PAT-scope failure was the real fault.

export type CheckStatus = "pass" | "fail" | "warn" | "info";

export interface DiagnosticCheck {
	name: string;
	status: CheckStatus;
	detail: string;
}

export interface DiagnoseOAuthResult {
	namespace: string;
	tokenFilePath: string;
	checks: DiagnosticCheck[];
	healthy: boolean;
}

export interface DiagnoseOAuthOptions {
	namespace: string;
	// Storage key the provider seeds under (GitLab: instanceUrl, Atlassian: mcpEndpoint).
	key: string;
	// Base URL for the live token probes (e.g. https://gitlab.com).
	instanceUrl: string;
	// Path to POST an MCP `initialize` against, relative to instanceUrl.
	// GitLab proxies /api/v4/mcp; omit to skip the endpoint reachability check.
	mcpProbePath?: string;
	// GitLab exposes /oauth/token/info for live introspection; omit to skip.
	tokenInfoPath?: string;
	// SIO-894: GitLab code-analysis tools use a separate Personal Access Token
	// (PRIVATE-TOKEN header), not OAuth. When provided, the doctor probes it so a
	// 403-from-a-tool failure can be pinned to the PAT rather than to OAuth.
	personalAccessToken?: string;
	// Override for tests; defaults to global fetch.
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	// Test seam: production reads ~/.mcp-auth/<ns>/<key>.json; tests inject state
	// without touching the real home dir. Returns null when no token file exists.
	loadStateFn?: (namespace: string, key: string) => PersistedOAuthState | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Never print a secret: collapse to prefix + length so an operator can still
// eyeball "is this the token I expect" without leaking it into a terminal log.
function maskToken(value: string | undefined): string {
	if (!value) return "absent";
	if (value.length <= 8) return `present (len=${value.length})`;
	return `${value.slice(0, 4)}...${value.slice(-2)} (len=${value.length})`;
}

function readTokenFile(path: string): PersistedOAuthState | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PersistedOAuthState;
	} catch {
		return null;
	}
}

async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(id);
	}
}

export async function diagnoseOAuth(options: DiagnoseOAuthOptions): Promise<DiagnoseOAuthResult> {
	const fetchFn = options.fetchFn ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const tokenFilePath = getOAuthStoragePath(options.namespace, options.key);
	const checks: DiagnosticCheck[] = [];

	const loadState = options.loadStateFn ?? ((_ns: string, _key: string) => readTokenFile(tokenFilePath));
	const state = loadState(options.namespace, options.key);

	if (!state) {
		checks.push({
			name: "token file",
			status: "fail",
			detail: `no readable token at ${tokenFilePath}; run the seed command to create one`,
		});
		return { namespace: options.namespace, tokenFilePath, checks, healthy: false };
	}

	const accessToken = state.tokens?.access_token;
	const refreshToken = state.tokens?.refresh_token;
	const clientInfo = state.clientInformation as { client_id?: string; token_endpoint_auth_method?: string } | undefined;

	checks.push({
		name: "token file",
		status: accessToken ? "pass" : "fail",
		detail:
			`path=${tokenFilePath} | access_token=${maskToken(accessToken)} | ` +
			`refresh_token=${refreshToken ? "present" : "MISSING"} | ` +
			`client_id=${maskToken(clientInfo?.client_id)} | ` +
			`auth_method=${clientInfo?.token_endpoint_auth_method ?? "?"} | ` +
			`scope=${state.tokens?.scope ?? "?"}`,
	});

	// Local expiry math from tokenObtainedAt + expires_in. Missing tokenObtainedAt
	// (legacy file) is a warn, not a fail -- the runtime self-heals on first read.
	const obtainedAt = state.tokenObtainedAt;
	const expiresIn = state.tokens?.expires_in;
	if (typeof obtainedAt === "number" && typeof expiresIn === "number") {
		const remainingSec = Math.round((obtainedAt + expiresIn * 1000 - Date.now()) / 1000);
		checks.push({
			name: "access token expiry (local)",
			status: remainingSec > 0 ? "pass" : "warn",
			detail:
				remainingSec > 0
					? `~${remainingSec}s remaining; refresh-on-read renews it transparently`
					: "access_token expired locally; runtime refreshes it on next read (refresh_token must be valid)",
		});
	} else {
		checks.push({
			name: "access token expiry (local)",
			status: "warn",
			detail: "tokenObtainedAt/expires_in missing; runtime treats as expired and refreshes once on first read",
		});
	}

	// Live introspection: the call that proves the token is accepted by the IdP
	// right now, independent of local expiry math.
	if (options.tokenInfoPath && accessToken) {
		const url = new URL(options.tokenInfoPath, options.instanceUrl).toString();
		try {
			const res = await fetchWithTimeout(
				fetchFn,
				url,
				{ method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
				timeoutMs,
			);
			if (res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					scope?: string[];
					expires_in_seconds?: number;
				};
				checks.push({
					name: "live token introspection",
					status: "pass",
					detail: `HTTP ${res.status} at ${url} | scope=${JSON.stringify(body.scope ?? [])} | expires_in_seconds=${body.expires_in_seconds ?? "?"}`,
				});
			} else {
				checks.push({
					name: "live token introspection",
					status: "fail",
					detail: `HTTP ${res.status} at ${url}; access_token rejected -- re-seed with --force`,
				});
			}
		} catch (error) {
			checks.push({
				name: "live token introspection",
				status: "fail",
				detail: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	// Endpoint reachability: the real runtime path. A 200 here means the proxied
	// MCP endpoint accepts the seeded token -- OAuth is fully functional.
	if (options.mcpProbePath && accessToken) {
		const url = new URL(options.mcpProbePath, options.instanceUrl).toString();
		const initBody = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "oauth-doctor", version: "0.1.0" },
			},
		};
		try {
			const res = await fetchWithTimeout(
				fetchFn,
				url,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
					},
					body: JSON.stringify(initBody),
				},
				timeoutMs,
			);
			checks.push({
				name: "mcp endpoint reachability",
				status: res.ok ? "pass" : "fail",
				detail: res.ok
					? `HTTP ${res.status} at ${url}; proxied MCP endpoint accepts the token`
					: `HTTP ${res.status} at ${url}; endpoint rejected the token`,
			});
		} catch (error) {
			checks.push({
				name: "mcp endpoint reachability",
				status: "fail",
				detail: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	// SIO-894: PAT vs OAuth disambiguation. GitLab code-analysis tools authenticate
	// with GITLAB_PERSONAL_ACCESS_TOKEN; an OAuth `mcp`-scoped token returning 403
	// from /api/v4/user is EXPECTED, not a fault. Probe the PAT independently so a
	// failing code-analysis tool points at the PAT, not at OAuth.
	if (options.personalAccessToken) {
		const url = new URL("/api/v4/user", options.instanceUrl).toString();
		try {
			const res = await fetchWithTimeout(
				fetchFn,
				url,
				{ method: "GET", headers: { "PRIVATE-TOKEN": options.personalAccessToken } },
				timeoutMs,
			);
			checks.push({
				name: "personal access token (code-analysis tools)",
				status: res.ok ? "pass" : "fail",
				detail: res.ok
					? `HTTP ${res.status}; PAT valid -- code-analysis tools can reach /api/v4`
					: `HTTP ${res.status}; PAT rejected -- check GITLAB_PERSONAL_ACCESS_TOKEN scope (needs read_api/read_repository)`,
			});
		} catch (error) {
			checks.push({
				name: "personal access token (code-analysis tools)",
				status: "fail",
				detail: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	// GitLab-specific PAT-vs-OAuth disambiguation note. tokenInfoPath is set only
	// by the GitLab CLI, so it gates this note off Atlassian (OAuth-only, no PAT).
	if (options.tokenInfoPath) {
		checks.push({
			name: "note",
			status: "info",
			detail:
				"OAuth (scope=mcp) authenticates the proxied /api/v4/mcp endpoint only. " +
				"Code-analysis tools use GITLAB_PERSONAL_ACCESS_TOKEN via PRIVATE-TOKEN -- a separate credential. " +
				"GET /api/v4/user with the OAuth token returning 403 is expected, not a fault.",
		});
	}

	const healthy = !checks.some((c) => c.status === "fail");
	return { namespace: options.namespace, tokenFilePath, checks, healthy };
}

// Pretty-prints a DiagnoseOAuthResult to a string (no emojis per repo policy).
export function formatDiagnosis(result: DiagnoseOAuthResult): string {
	const lines: string[] = [];
	lines.push(`OAuth diagnosis for namespace=${result.namespace}`);
	lines.push(`Verdict: ${result.healthy ? "HEALTHY" : "PROBLEM DETECTED"}`);
	lines.push("");
	for (const check of result.checks) {
		const tag = check.status.toUpperCase().padEnd(4);
		lines.push(`[${tag}] ${check.name}`);
		lines.push(`       ${check.detail}`);
	}
	return lines.join("\n");
}
