// memory-pr/src/secret-scan.ts
//
// SIO-849: pre-commit secret guard. Durable-memory proposals are scanned before
// any branch/commit/PR is created; a single hit aborts the whole proposal. This
// is a hard stop distinct from PII redaction (shared/pii-redactor): PII is
// redacted in-place for display, but a credential in a file slated for a public
// PR must block the operation entirely, not be silently rewritten.

export interface SecretFinding {
	kind: string;
	path: string;
	// The matched token is NOT included so the finding itself never leaks it.
	hint: string;
}

interface SecretPattern {
	kind: string;
	regex: RegExp;
}

// Conservative, high-signal patterns. False positives here are cheap (a human
// reviews the proposal anyway); false negatives leak a credential, so prefer
// over-matching for well-known token shapes.
const SECRET_PATTERNS: readonly SecretPattern[] = [
	{ kind: "github_token", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
	{ kind: "github_fine_grained_pat", regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
	{ kind: "aws_access_key_id", regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ kind: "private_key_block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
	{ kind: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{ kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	// Generic "secret/token/password = <value>" assignments with a long opaque value.
	{
		kind: "generic_assigned_secret",
		regex: /\b(?:secret|token|password|passwd|api[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{20,}['"]?/i,
	},
];

// Scans a single file's contents. Returns one finding per matched pattern kind.
export function scanContent(path: string, contents: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.regex.test(contents)) {
			findings.push({ kind: pattern.kind, path, hint: `matched ${pattern.kind} pattern` });
		}
	}
	return findings;
}

// Scans every file in a proposal. A non-empty result means the proposal must be
// aborted before any GitHub write.
export function scanFiles(files: ReadonlyArray<{ path: string; contents: string }>): SecretFinding[] {
	return files.flatMap((f) => scanContent(f.path, f.contents));
}
