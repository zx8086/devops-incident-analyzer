#!/usr/bin/env bun
// gitagent-bridge/src/export-pi-package-cli.ts
//
// SIO-1649: export an agent definition as a Pi package for the pi-coms fleet.
//
//   bun packages/gitagent-bridge/src/export-pi-package-cli.ts --out <dir>
//     [--agent pi-fleet] [--agents-dir <dir>] [--sha <sha>] [--tag pi-fleet-vX.Y.Z]
//     [--sub-agents a,b]
//
// --tag enforces version-equals-tag (the release job passes GITHUB_REF_NAME).
// main() is guarded by import.meta.main so importing this module is side-effect free.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadAgent } from "./manifest-loader.ts";
import { buildPiPackage } from "./pi-package-export.ts";
import { assertVersionMatchesTag } from "./version.ts";

export type ExportArgs = {
	agent: string;
	out: string;
	agentsDir: string;
	sha?: string;
	tag?: string;
	subAgents?: string[];
};

const DEFAULT_AGENTS_DIR = resolve(import.meta.dir, "../../../agents");

export function parseExportArgs(argv: string[]): ExportArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			agent: { type: "string", default: "pi-fleet" },
			out: { type: "string" },
			"agents-dir": { type: "string" },
			sha: { type: "string" },
			tag: { type: "string" },
			"sub-agents": { type: "string" },
		},
		allowPositionals: false,
	});
	if (!values.out) throw new Error("missing required --out <dir>");
	return {
		agent: values.agent ?? "pi-fleet",
		out: values.out,
		agentsDir: values["agents-dir"] ?? DEFAULT_AGENTS_DIR,
		...(values.sha ? { sha: values.sha } : {}),
		...(values.tag ? { tag: values.tag } : {}),
		...(values["sub-agents"] ? { subAgents: values["sub-agents"].split(",").map((s) => s.trim()) } : {}),
	};
}

export function runExport(args: ExportArgs): { version: string; count: number } {
	const root = loadAgent(join(args.agentsDir, args.agent));
	if (args.tag) assertVersionMatchesTag(root.manifest.version, args.tag);
	const pkg = buildPiPackage({
		root,
		name: args.agent,
		version: root.manifest.version,
		...(args.sha ? { sha: args.sha } : {}),
		...(args.subAgents ? { subAgents: args.subAgents } : {}),
	});
	for (const file of pkg.files) {
		const target = join(args.out, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content);
	}
	return { version: pkg.version, count: pkg.files.length };
}

function main(): void {
	const args = parseExportArgs(process.argv.slice(2));
	const result = runExport(args);
	console.log(`exported ${args.agent} v${result.version} to ${args.out} (${result.count} files)`);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error("export-pi-package failed:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
