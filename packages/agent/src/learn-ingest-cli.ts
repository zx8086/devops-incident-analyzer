#!/usr/bin/env bun
// agent/src/learn-ingest-cli.ts
//
// SIO-1892: `bun run --filter @devops-agent/agent learn:ingest -- --file drafts.json --agent incident-analyzer [--dry-run]`
// Reads the fleet harvest (or any file of candidate drafts) and records each
// qualifying draft as a candidate fact under the agent's identity, for the
// SIO-1891 review pane to approve. main() is guarded by import.meta.main.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface IngestArgs {
	file: string;
	agent: string;
	dryRun: boolean;
}

export function parseIngestArgs(argv: string[]): IngestArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			file: { type: "string" },
			agent: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
		allowPositionals: false,
	});
	if (!values.file) throw new Error("missing required --file <drafts.json>");
	return { file: values.file, agent: values.agent ?? "incident-analyzer", dryRun: values["dry-run"] ?? false };
}

async function main(): Promise<void> {
	const args = parseIngestArgs(process.argv.slice(2));
	const { HarvestFileSchema, ingestCandidates } = await import("./learn-ingest.ts");
	const file = HarvestFileSchema.parse(JSON.parse(readFileSync(args.file, "utf8")));
	const report = await ingestCandidates(file.candidates, args.agent, { dryRun: args.dryRun });
	for (const name of report.stored) console.log(`${args.dryRun ? "would store" : "stored"}  ${name}`);
	for (const s of report.skipped) console.log(`skipped ${s.name}: ${s.reason}`);
	console.log(`${report.stored.length} stored, ${report.skipped.length} skipped (agent ${args.agent})`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
