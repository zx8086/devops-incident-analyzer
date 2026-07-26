// packages/agent/src/eval/precheck.ts
export {};

// SIO-1224 follow-up: this used to probe a hardcoded [9080..9085] and could not pass in this dev
// environment, which made the eval -- gate 8 of docs/development/model-upgrade-checklist.md --
// unrunnable. Two things were wrong:
//
//  1. It assumed kafka on :9081. The app does not use that. KAFKA_MCP_URL points at the SigV4
//     proxy (:3000) in front of the kafka MCP runtime on AgentCore, because a LOCAL kafka MCP
//     cannot reach the MSK private brokers from a laptop at all (no VPN DNS -- every broker call
//     fails with "metadata failed 4 times" regardless of real broker health). So the probe tested
//     a path the agent never takes, while the path it DOES take went unchecked.
//  2. It never probed aws (:3001) even though the agent fans out to it.
//
// It now resolves each server's URL from the SAME env vars the app uses, and konnect is OPTIONAL:
// it is deliberately disabled here, and a precheck that hard-fails on an intentionally-off
// datasource just gets bypassed -- which is worse than one that reports it and continues.

interface Probe {
	name: string;
	url: string;
	required: boolean;
}

// Env is injected rather than read at module scope: this package's convention is that a
// module import performs no process.env access, so configuration cannot be frozen at import
// time (and the probe list stays unit-testable with a synthetic env).
function buildProbes(env: NodeJS.ProcessEnv = process.env): Probe[] {
	const envUrl = (key: string, fallbackPort: number): string => {
		const raw = env[key];
		return raw && raw !== "" ? raw : `http://localhost:${fallbackPort}`;
	};
	return [
		{ name: "elastic", url: envUrl("ELASTIC_MCP_URL", 9080), required: true },
		// Real path is the SigV4 proxy -> AgentCore, not a local broker-dialling process.
		{ name: "kafka", url: envUrl("KAFKA_MCP_URL", 3000), required: true },
		{ name: "couchbase", url: envUrl("COUCHBASE_MCP_URL", 9082), required: true },
		{ name: "gitlab", url: envUrl("GITLAB_MCP_URL", 9084), required: true },
		{ name: "atlassian", url: envUrl("ATLASSIAN_MCP_URL", 9085), required: true },
		{ name: "aws", url: envUrl("AWS_MCP_URL", 3001), required: true },
		// Intentionally disabled in this dev environment; the agent soft-skips it and a "degraded"
		// /health for konnect alone is expected. Report it, do not block on it.
		{ name: "konnect", url: envUrl("KONNECT_MCP_URL", 9083), required: false },
	];
}

const PROBES = buildProbes();

const failures: string[] = [];
const skipped: string[] = [];

for (const probe of PROBES) {
	const health = `${probe.url.replace(/\/$/, "")}/health`;
	let ok = false;
	let reason = "";
	try {
		const res = await fetch(health, { signal: AbortSignal.timeout(3000) });
		ok = res.ok;
		if (!ok) reason = `returned ${res.status}`;
	} catch (e) {
		reason = e instanceof Error ? e.message : String(e);
	}

	if (ok) continue;
	if (probe.required) {
		failures.push(`MCP server '${probe.name}' (${health}) unreachable or unhealthy (${reason})`);
	} else {
		skipped.push(`${probe.name} (${health}): ${reason}`);
	}
}

for (const s of skipped) {
	console.warn(`OPTIONAL datasource unavailable, continuing without it -- ${s}`);
}

if (failures.length > 0) {
	for (const f of failures) console.error(f);
	console.error("\nURLs come from the *_MCP_URL env vars. If one looks wrong, the env is wrong, not the server.");
	process.exit(1);
}

const requiredCount = PROBES.filter((p) => p.required).length;
const suffix = skipped.length > 0 ? ` (${skipped.length} optional unavailable)` : "";
console.log(`All ${requiredCount} required MCP servers reachable${suffix}`);
