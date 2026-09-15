// scripts/fleet/config-drift.ts
import { readFileSync } from "node:fs";
import * as path from "node:path";

// SIO-1747: both systemd units source .coms-env and THEN .coms-env.local, so a
// hand-written key silently wins over the terraform-rendered one. That is the
// point of the file for a genuine per-host flag (CTX_MODE_ENABLED and the
// inbound-policy knobs), and a problem for a key the bootstrap also writes:
// the fleet manifest is masked with nothing to say so. Five prd spokes drifted
// this way for a week and were only found by reading files on the hosts.

// Derived from the bootstrap, never a second hard-coded list: a copy would
// drift from the original exactly as the hosts did. Matches the `echo "export
// KEY='...'"` lines of the block that writes $ENV_FILE.
export function bootstrapWrittenKeys(bootstrapSource: string): string[] {
	const keys = new Set<string>();
	for (const line of bootstrapSource.split("\n")) {
		// Only the .coms-env writer block uses this shape; the .local file is
		// never written by the bootstrap, so nothing else can match.
		const m = /echo\s+"export\s+([A-Z][A-Z0-9_]*)=/.exec(line);
		if (m) keys.add(m[1]);
	}
	return [...keys].sort();
}

export function bootstrapPath(): string {
	return path.resolve(import.meta.dir, "..", "..", "deploy", "bootstrap", "agent-bootstrap.sh");
}

export function loadBootstrapKeys(file: string = bootstrapPath()): string[] {
	return bootstrapWrittenKeys(readFileSync(file, "utf-8"));
}

// `export KEY=value` / `KEY=value`, skipping blanks and comments. Values are
// deliberately discarded: this reports WHICH keys shadow, never their contents,
// because the file is 0600 and may hold per-host secrets.
export function parseEnvKeys(contents: string): string[] {
	const keys: string[] = [];
	for (const raw of contents.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
		if (m && !keys.includes(m[1])) keys.push(m[1]);
	}
	return keys;
}

export type DriftVerdict =
	| { state: "clean"; reason: "no override file" | "only per-host keys"; localKeys: string[] }
	| { state: "shadowed"; shadowed: string[]; localKeys: string[] };

// A key is drift only when the bootstrap ALSO writes it. Anything else in the
// file is the override mechanism working as designed and must not be flagged --
// a false positive here invites someone to delete a file that is load-bearing.
export function classify(localContents: string | null, bootstrapKeys: readonly string[]): DriftVerdict {
	if (localContents === null) return { state: "clean", reason: "no override file", localKeys: [] };
	const localKeys = parseEnvKeys(localContents);
	const shadowed = localKeys.filter((k) => bootstrapKeys.includes(k));
	if (shadowed.length === 0) return { state: "clean", reason: "only per-host keys", localKeys };
	return { state: "shadowed", shadowed, localKeys };
}

export function formatVerdict(spoke: string, verdict: DriftVerdict): string {
	const label = spoke.padEnd(28);
	if (verdict.state === "clean") {
		const extra = verdict.localKeys.length > 0 ? ` (per-host: ${verdict.localKeys.join(", ")})` : "";
		return `config ${label} ok${extra}`;
	}
	// Names the keys, not just a count: the operator has to know whether the
	// file is safe to delete, and deleting it blind is what would have taken
	// five prd digests back to UTC @daily (SIO-1746).
	return `config ${label} DRIFT ${verdict.shadowed.length} key(s) shadowed by .coms-env.local: ${verdict.shadowed.join(", ")}`;
}

export const READ_LOCAL_ENV_COMMAND = ["cat /home/piagent/.coms-env.local 2>/dev/null || echo __NO_LOCAL_ENV__"];

// The sentinel keeps "file absent" distinct from "file empty": an empty
// override is clean, but so is a missing one, and conflating them would hide a
// host whose file was emptied rather than removed.
export function parseRemoteRead(stdout: string): string | null {
	return stdout.includes("__NO_LOCAL_ENV__") ? null : stdout;
}
