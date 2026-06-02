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

// GitLab REST helper. Returns parsed JSON text or a clear message when the token
// is absent (so the agent surfaces "configure GITLAB_PERSONAL_ACCESS_TOKEN").
export async function gitlabFetch(
	baseUrl: string,
	token: string | undefined,
	apiPath: string,
	init?: RequestInit,
): Promise<string> {
	if (!token) return "[gitlab token not configured: set GITLAB_PERSONAL_ACCESS_TOKEN]";
	try {
		const res = await fetch(`${baseUrl}/api/v4${apiPath}`, {
			...init,
			headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json", ...(init?.headers ?? {}) },
		});
		const text = await res.text();
		return `[${res.status}] ${text}`;
	} catch (err) {
		return `[gitlab request failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}
