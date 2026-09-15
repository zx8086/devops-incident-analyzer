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
	const lines = bootstrapSource.split("\n");
	// Scoped to the `{ ... } > "$ENV_FILE"` block, not the whole file. An
	// unanchored search also matched commented-out lines and unrelated echoes,
	// so a `# echo "export CTX_MODE_ENABLED=..."` anywhere in the bootstrap
	// would make that key "authoritative" and report every host legitimately
	// using it as DRIFT -- the exact false positive that would invite deleting
	// a load-bearing override file.
	const start = lines.findIndex((l) => /^\s*\{\s*$/.test(l));
	const end = lines.findIndex((l, i) => i > start && /\}\s*>\s*"\$ENV_FILE"/.test(l));
	if (start === -1 || end === -1) {
		throw new Error('could not locate the { ... } > "$ENV_FILE" block in the bootstrap');
	}
	const keys = new Set<string>();
	for (const line of lines.slice(start + 1, end)) {
		if (/^\s*#/.test(line)) continue; // a commented-out echo is not a written key
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
// discarded, but note the split of responsibility: the HOST already stripped
// them (see READ_LOCAL_ENV_COMMAND) so a value never reaches SSM's command
// output. This function only re-parses the key list, and is the unit under
// test for the shapes the host-side sed has to handle.
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

// Emits KEY NAMES ONLY. The values never leave the host, because SSM keeps
// StandardOutputContent in the command invocation and anyone with
// ssm:GetCommandInvocation can read it back afterwards -- `cat`-ing a 0600
// operator file would copy per-host secrets into a queryable AWS log. The sed
// keeps the `KEY=` shape parseEnvKeys expects, with an empty value.
export const READ_LOCAL_ENV_COMMAND = [
	"sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\\2=/p' /home/piagent/.coms-env.local 2>/dev/null || true",
	"[ -f /home/piagent/.coms-env.local ] || echo __NO_LOCAL_ENV__",
];

// The sentinel keeps "file absent" distinct from "file empty": an empty
// override is clean, but so is a missing one, and conflating them would hide a
// host whose file was emptied rather than removed.
export function parseRemoteRead(stdout: string): string | null {
	return stdout.includes("__NO_LOCAL_ENV__") ? null : stdout;
}
