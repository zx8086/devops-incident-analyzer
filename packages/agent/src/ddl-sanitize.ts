// agent/src/ddl-sanitize.ts
// SIO-1243: deterministic sanity checks on CREATE INDEX DDL that reaches a human.
//
// The 2026-07-27 prana-order-service run emitted an Escalate recommendation whose
// `CREATE INDEX idx_dates_covering ...` listed `articleType` twice -- Couchbase rejects a
// duplicate index key, and the section it sat under is precisely the one an operator is
// expected to action verbatim. The DDL was NOT tool-computed: no advisor tool ran that turn.
// mitigation-branches.ts re-generates the report through a second LLM off a 3000-char slice
// (runBranch), and validates only the JSON SHAPE (`z.array(z.string())`) -- nothing inspects
// the string contents. So the whole emitted-command surface is unvalidated, and a duplicate
// key is a mechanical invariant, not a judgement call: dedupe deterministically rather than
// asking the model to be careful.
//
// The regexes and looksLikeKeyList moved here from aggregator.ts (they were module-private)
// so the verbatim-DDL path and this sanitizer share ONE definition and cannot drift.

// A statement is real DDL only when it has the full `CREATE INDEX <name> ON <keyspace>(<keys>)`
// shape with a key-list-looking paren group -- prose mentioning "CREATE INDEX" never matches.
// A trailing semicolon is consumed so terminated statements are reproduced verbatim.
export const CREATE_INDEX_RE = /CREATE\s+INDEX[\s\S]*?(?:;|(?=```|\n\s*\n|$))/gi;
export const CREATE_INDEX_SHAPE_RE = /^CREATE\s+INDEX\s+(?:`[^`]+`|[A-Za-z_][\w#-]*)\s+ON\s+[^(]*\(([^)]*)\)/i;

// Trailing-semicolon-insensitive so `...(a);` in prose matches `...(a)` in the answer.
export function normalizeDdl(s: string): string {
	return s.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

// A paren group counts as a key list when it is backticked/dotted/comma-separated
// (advisor output always is) or a single bare identifier. Multi-word English like
// "(not production)" is rejected so prose mimicking DDL is never emitted as SQL.
export function looksLikeKeyList(inner: string): boolean {
	const t = inner.trim();
	if (t.length === 0) return false;
	if (/[`,.[\]]/.test(t)) return true;
	return /^[\w#-]+$/.test(t);
}

// Comparison form for "is this the same index key". Backticks are quoting, not identity, and
// N1QL identifiers are case-insensitive when unquoted -- but the ORIGINAL spelling is what we
// re-emit, so this only ever decides equality. Deliberately compares the WHOLE key expression:
// `a` and `a DESC` (or `a INCLUDE MISSING`) stay distinct, because collapsing them would change
// index semantics. Only an exact repeat is removed.
function keyIdentity(rawKey: string): string {
	return rawKey.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DedupeResult {
	text: string;
	/** Normalized identities that were dropped, in the order they were found. */
	removed: string[];
}

// Remove repeated keys from every CREATE INDEX key list in `text`, preserving the FIRST
// occurrence's position and original spelling. Everything that is not a matched key list is
// returned byte-identical, so this is safe to run over arbitrary prose.
//
// Conservative by construction -- a statement is skipped (returned untouched) when:
//   * it does not match the full CREATE INDEX shape, or
//   * the paren group does not look like a key list, or
//   * the key list contains a nested `(`.
// The last case matters because CREATE_INDEX_SHAPE_RE's `[^)]*` stops at the first `)`, so a
// functional key like `LOWER(name)` would yield a TRUNCATED capture; rewriting from it would
// corrupt the statement. Functional/array-index DDL is rare here and losing dedupe on it is
// strictly better than mangling it.
export function dedupeCreateIndexKeys(text: string): DedupeResult {
	// Fast path. Must be case-INSENSITIVE to match CREATE_INDEX_RE's /i -- a substring check for
	// "CREATE"/"create" would silently skip mixed-case "Create Index".
	if (!/create\s+index/i.test(text)) return { text, removed: [] };
	const removed: string[] = [];
	// CREATE_INDEX_RE is a module-level /g regex; replace() resets lastIndex itself, but a
	// fresh instance keeps this function safe under concurrent callers.
	const scan = new RegExp(CREATE_INDEX_RE.source, CREATE_INDEX_RE.flags);
	const out = text.replace(scan, (stmt) => {
		const shape = stmt.match(CREATE_INDEX_SHAPE_RE);
		const inner = shape?.[1];
		if (!shape || inner === undefined || !looksLikeKeyList(inner)) return stmt;
		if (inner.includes("(")) return stmt;

		// Split on commas, keeping each segment's raw text (leading newline/indent included)
		// so re-joining with "," reproduces the original layout exactly for kept keys.
		// Hold the key list's trailing whitespace aside. Otherwise dropping the LAST key also
		// drops the newline before the closing paren, moving ")" onto the previous key's line.
		const trailingWs = /\s*$/.exec(inner)?.[0] ?? "";
		const body = inner.slice(0, inner.length - trailingWs.length);
		const segments = body.split(",");
		const seen = new Set<string>();
		const kept: string[] = [];
		const droppedHere: string[] = [];
		for (const seg of segments) {
			const identity = keyIdentity(seg);
			// An empty segment is a trailing comma or malformed list -- keep it verbatim rather
			// than silently "fixing" a statement we do not fully understand.
			if (identity.length === 0) {
				kept.push(seg);
				continue;
			}
			if (seen.has(identity)) {
				droppedHere.push(identity);
				continue;
			}
			seen.add(identity);
			kept.push(seg);
		}
		if (droppedHere.length === 0) return stmt;
		removed.push(...droppedHere);

		// Rewrite only the key-list paren group. `inner` is paren-free (guarded above), so the
		// last "(" inside the matched prefix is unambiguously the key list's opening paren.
		const openIdx = shape[0].lastIndexOf("(");
		return stmt.slice(0, openIdx + 1) + kept.join(",") + trailingWs + stmt.slice(openIdx + 1 + inner.length);
	});
	return { text: out, removed };
}
