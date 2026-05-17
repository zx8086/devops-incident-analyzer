// packages/shared/src/transport/identity.ts
import { createHash, randomUUID } from "node:crypto";

export type McpRole =
	| "elastic-mcp"
	| "kafka-mcp"
	| "couchbase-mcp"
	| "konnect-mcp"
	| "gitlab-mcp"
	| "atlassian-mcp"
	| "aws-mcp"
	| "aws-proxy"
	| "kafka-proxy";

export type McpTransportMode = "stdio" | "http" | "agentcore-proxy";

export interface IdentityCard {
	instanceId: string;
	role: McpRole;
	version: string;
	bootedAt: string;
	pid: number;
	mode: McpTransportMode;
	upstreamFingerprint: string;
}

export interface BuildIdentityCardOptions {
	role: McpRole;
	version: string;
	mode: McpTransportMode;
	upstreamFingerprint: string;
}

export function buildIdentityCard(opts: BuildIdentityCardOptions): IdentityCard {
	return {
		instanceId: randomUUID(),
		role: opts.role,
		version: opts.version,
		bootedAt: new Date().toISOString(),
		pid: process.pid,
		mode: opts.mode,
		upstreamFingerprint: opts.upstreamFingerprint,
	};
}

const CREDENTIAL_KEY_RE = /password|secret|token|key/i;
const ALLOWED_KEY_RE = /^(publicKey|instanceId)$/;

// 16-hex-char fingerprint over canonical JSON with sorted keys.
// Credential-bearing keys (matching /password|secret|token|key/i) are stripped
// before hashing, except for `publicKey` and `instanceId` which are public.
export function canonicalizeUpstream(config: Record<string, unknown>): string {
	const redacted = redactCredentials(config) as Record<string, unknown>;
	const sorted = JSON.stringify(redacted, Object.keys(redacted).sort());
	return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function redactCredentials(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactCredentials);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (CREDENTIAL_KEY_RE.test(k) && !ALLOWED_KEY_RE.test(k)) continue;
			out[k] = redactCredentials(v);
		}
		return out;
	}
	return value;
}
