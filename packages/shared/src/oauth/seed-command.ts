// src/oauth/seed-command.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The seeder is exposed under two different script names depending on where it
// is invoked from: the workspace root defines `oauth:seed:<ns>` (which fans out
// via --filter), while each MCP server package defines a bare `oauth:seed`.
// Errors thrown inside a server process are read by whoever is running that
// process -- typically in the package directory, where `oauth:seed:<ns>` does
// NOT resolve and `bun run` fails with "Script not found". Resolve the name
// against the caller's cwd so the remediation is copy-pasteable as printed.
export function seedCommandFor(namespace: string, cwd: string = process.cwd()): string {
	const rootName = `oauth:seed:${namespace}`;
	const scripts = readScripts(cwd);
	if (!scripts) return `bun run ${rootName}`;
	// Prefer the root-style name when the cwd actually defines it, so running
	// from the workspace root keeps the familiar namespaced command.
	if (typeof scripts[rootName] === "string") return `bun run ${rootName}`;
	if (typeof scripts["oauth:seed"] === "string") return "bun run oauth:seed";
	return `bun run ${rootName}`;
}

function readScripts(cwd: string): Record<string, unknown> | null {
	const manifestPath = join(cwd, "package.json");
	if (!existsSync(manifestPath)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const scripts = (parsed as { scripts?: unknown }).scripts;
		if (typeof scripts !== "object" || scripts === null) return null;
		return scripts as Record<string, unknown>;
	} catch {
		// An unreadable or malformed manifest must never mask the underlying
		// OAuth error -- fall back to the root-style name.
		return null;
	}
}
