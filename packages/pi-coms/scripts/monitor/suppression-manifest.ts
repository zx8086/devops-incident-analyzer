// scripts/monitor/suppression-manifest.ts
import * as fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// SIO-1868: the committed half of the suppression ledger. A fleet-wide
// suppression belongs in a reviewed diff, not in N chat commands that die with
// the instance they were typed on.
//
// `accounts` scopes an entry to named accounts (matched against
// PI_MONITOR_ACCOUNT_NAME) so one file serves the whole fleet: the Karpenter
// churn entries apply to the EKS accounts without silencing the same rule in an
// account that has no Kubernetes at all, where it would be a real finding.
//
// A reason is MANDATORY, exactly as it is for the chat command. The weekly
// review prints it back, and "why is this masked" with no answer is how a
// ledger rots into a place noise goes to be forgotten.
const EntrySchema = z.object({
	pattern: z.string().trim().min(1).describe("SQL LIKE pattern matched against a finding's dedup_key"),
	reason: z.string().trim().min(1).describe("Why this is accepted noise; printed by the weekly suppression review"),
	accounts: z
		.array(z.string().trim().min(1))
		.optional()
		.describe("Account names this applies to (PI_MONITOR_ACCOUNT_NAME); omitted means every account"),
});

const ManifestSchema = z.object({ suppressions: z.array(EntrySchema) });

export type SuppressionManifestEntry = z.infer<typeof EntrySchema>;

export function selectForAccount(
	entries: SuppressionManifestEntry[],
	accountName: string | undefined,
): { pattern: string; reason: string }[] {
	return entries
		.filter((e) => {
			if (!e.accounts || e.accounts.length === 0) return true;
			// An unnamed host cannot match a scoped entry. Falling through to
			// "applies everywhere" would suppress on every account that has not set
			// PI_MONITOR_ACCOUNT_NAME yet, which is the opposite of scoping.
			return accountName !== undefined && e.accounts.includes(accountName);
		})
		.map((e) => ({ pattern: e.pattern, reason: e.reason }));
}

export type LoadResult =
	| { ok: true; entries: SuppressionManifestEntry[] }
	| { ok: false; reason: "missing" | "unreadable" | "invalid"; detail: string };

// Tagged failures rather than a bare null: the caller logs "no manifest" and
// "manifest is corrupt" very differently, and a monitor that silently treats a
// broken file as an empty one would drop every file suppression at once.
export function loadSuppressionManifest(filePath: string): LoadResult {
	let raw: string;
	try {
		if (!fs.existsSync(filePath)) return { ok: false, reason: "missing", detail: filePath };
		raw = fs.readFileSync(filePath, "utf8");
	} catch (e) {
		return { ok: false, reason: "unreadable", detail: e instanceof Error ? e.message : String(e) };
	}
	let doc: unknown;
	try {
		doc = parse(raw);
	} catch (e) {
		return { ok: false, reason: "invalid", detail: e instanceof Error ? e.message : String(e) };
	}
	// An empty file parses to null, which is a legitimate "no suppressions".
	if (doc == null) return { ok: true, entries: [] };
	const parsed = ManifestSchema.safeParse(doc);
	if (!parsed.success) {
		return { ok: false, reason: "invalid", detail: parsed.error.issues.map((i) => i.message).join("; ") };
	}
	return { ok: true, entries: parsed.data.suppressions };
}
