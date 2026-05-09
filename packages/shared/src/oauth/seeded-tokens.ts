// src/oauth/seeded-tokens.ts

import { existsSync, readFileSync } from "node:fs";
import { getOAuthStoragePath } from "./base-provider.ts";

// Returns true iff a seeded OAuth token file exists for namespace+key with a
// non-empty access_token. No side effects, no mkdir, no logger -- caller
// decides log severity. Path computation is shared with the writer
// (BaseOAuthClientProvider) so this predicate cannot drift from where tokens
// are actually persisted.
export function hasSeededTokens(namespace: string, key: string): boolean {
	const path = getOAuthStoragePath(namespace, key);
	if (!existsSync(path)) return false;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			tokens?: { access_token?: string };
		};
		return typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0;
	} catch {
		return false;
	}
}
