// src/tools/shared.ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function text(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }] };
}

export function errText(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }], isError: true };
}

// Run a child process inside the IaC workspace and return a combined transcript.
// The toolset is read/plan/branch-only; callers never pass apply/destroy verbs.
export async function run(cmd: string[], cwd: string): Promise<string> {
	try {
		const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		const tail = `\n[exit ${exitCode}]`;
		return `${stdout}${stderr ? `\n${stderr}` : ""}${tail}`.trim();
	} catch (err) {
		return `[failed to run ${cmd[0]}: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// SIO-1478: this helper had no deadline, so a stalled GitLab connection blocked
// the caller indefinitely. Observed live: gitlab_list_merge_requests_by_source_branch
// took 136,597ms against a ~250ms baseline, and because the MCP server services
// requests on one event loop, the bridge's /identity probe (1s budget) could not
// be answered and the server was marked "down" while it was merely busy.
// Matches @devops-agent/mcp-server-gitlab's 30s GITLAB_TIMEOUT default; override
// with ELASTIC_IAC_GITLAB_TIMEOUT_MS. Applied here rather than at the ~20 call
// sites so every GitLab tool is covered by construction.
const DEFAULT_GITLAB_TIMEOUT_MS = 30_000;

function gitlabTimeoutMs(): number {
	const raw = Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS;
	if (!raw) return DEFAULT_GITLAB_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GITLAB_TIMEOUT_MS;
}

// GitLab REST helper. Returns parsed JSON text or a clear message when the token
// is absent (so the agent surfaces "configure GITLAB_PERSONAL_ACCESS_TOKEN").
export async function gitlabFetch(
	baseUrl: string,
	token: string | undefined,
	apiPath: string,
	init?: RequestInit,
): Promise<string> {
	if (!token) return "[gitlab token not configured: set GITLAB_PERSONAL_ACCESS_TOKEN]";
	const timeoutMs = gitlabTimeoutMs();
	try {
		const res = await fetch(`${baseUrl}/api/v4${apiPath}`, {
			...init,
			headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json", ...(init?.headers ?? {}) },
			// A caller-supplied signal wins, so existing cancellation still works.
			signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		return `[${res.status}] ${text}`;
	} catch (err) {
		// Name the timeout explicitly: "aborted" alone reads as a bug, when the
		// actionable fact is that GitLab did not answer inside the budget.
		if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
			return `[gitlab request timed out after ${timeoutMs}ms: ${apiPath}]`;
		}
		return `[gitlab request failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}
