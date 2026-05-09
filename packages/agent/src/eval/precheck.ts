// packages/agent/src/eval/precheck.ts
export {};

const PORTS = [9080, 9081, 9082, 9083, 9084, 9085] as const;
const NAMES = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"] as const;

const failures: string[] = [];

for (let i = 0; i < PORTS.length; i++) {
	const port = PORTS[i] as number;
	const name = NAMES[i] as string;
	try {
		const res = await fetch(`http://localhost:${port}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) {
			failures.push(
				`MCP server '${name}' (:${port}) returned ${res.status}; start it: bun run --filter @devops-agent/mcp-server-${name} dev`,
			);
		}
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		failures.push(
			`MCP server '${name}' (:${port}) unreachable (${reason}); start it: bun run --filter @devops-agent/mcp-server-${name} dev`,
		);
	}
}

if (failures.length > 0) {
	for (const f of failures) console.error(f);
	process.exit(1);
}

console.log("All 6 MCP servers reachable");
