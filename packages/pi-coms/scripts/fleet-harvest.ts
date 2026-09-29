#!/usr/bin/env bun
// packages/pi-coms/scripts/fleet-harvest.ts
//
// SIO-1892: operator CLI. Reads each spoke's checkpointed monitor state.db
// (the SIO-1745 checkpoint in the dist bucket, with the same credentials
// publish-fleet.sh uses) or local fixture files, and writes candidate drafts
// for the analyzer's `learn:ingest`. Nothing runs on a spoke and no spoke reads
// another's state. Every string in the output is redacted before it is written.
//
//   bun scripts/fleet-harvest.ts --bundle s3://bucket/fleet --spoke 111122223333/aws-spoke [--spoke ...] --out drafts.json
//   bun scripts/fleet-harvest.ts --db tests/fixtures/state.db --origin 111122223333/aws-spoke --out drafts.json
//
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_TARGET_DIR, harvest, type JournalRow } from "./monitor/harvest.ts";

export interface HarvestArgs {
	bundle?: string;
	spokes: { account: string; agent: string }[];
	dbs: { path: string; account: string; agent: string }[];
	windowDays: number;
	minOrigins: number;
	minOccurrences: number;
	out?: string;
	targetDir: string;
}

function parseSpoke(s: string): { account: string; agent: string } {
	const [account, agent] = s.split("/");
	if (!account || !agent) throw new Error(`--spoke/--origin wants <account>/<agent>, got "${s}"`);
	return { account, agent };
}

export function parseHarvestArgs(argv: string[]): HarvestArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			bundle: { type: "string" },
			spoke: { type: "string", multiple: true },
			db: { type: "string", multiple: true },
			origin: { type: "string", multiple: true },
			"window-days": { type: "string" },
			"min-origins": { type: "string" },
			"min-occurrences": { type: "string" },
			out: { type: "string" },
			"target-dir": { type: "string" },
		},
		allowPositionals: false,
	});
	const dbs = values.db ?? [];
	const origins = values.origin ?? [];
	if (dbs.length !== origins.length) throw new Error("each --db needs a matching --origin <account>/<agent>");
	const spokes = (values.spoke ?? []).map(parseSpoke);
	if (dbs.length === 0 && (!values.bundle || spokes.length === 0)) {
		throw new Error(
			"usage: --bundle s3://bucket/fleet --spoke <account>/<agent> ... | --db <state.db> --origin <account>/<agent> ...",
		);
	}
	const num = (v: string | undefined, d: number) => {
		const n = Number(v);
		return v !== undefined && Number.isFinite(n) && n > 0 ? n : d;
	};
	return {
		...(values.bundle ? { bundle: values.bundle } : {}),
		spokes,
		dbs: dbs.map((p, i) => ({ path: p, ...parseSpoke(origins[i] ?? "") })),
		windowDays: num(values["window-days"], 14),
		minOrigins: num(values["min-origins"], 2),
		minOccurrences: num(values["min-occurrences"], 3),
		...(values.out ? { out: values.out } : {}),
		targetDir: values["target-dir"] ?? DEFAULT_TARGET_DIR,
	};
}

async function readRows(dbPath: string, windowMs: number): Promise<JournalRow[]> {
	const { MonitorState } = await import("./monitor/state.ts");
	const state = new MonitorState(dbPath);
	try {
		return state.journalRows(windowMs);
	} finally {
		state.close();
	}
}

async function main(): Promise<void> {
	const args = parseHarvestArgs(process.argv.slice(2));
	const windowMs = args.windowDays * 24 * 60 * 60 * 1000;
	const inputs: { rows: JournalRow[]; origin: { account: string; agent: string } }[] = [];

	for (const db of args.dbs) {
		inputs.push({ rows: await readRows(db.path, windowMs), origin: db });
	}

	if (args.bundle && args.spokes.length > 0) {
		const { S3Client } = await import("@aws-sdk/client-s3");
		const { restoreCheckpoint, s3Store, statePrefix } = await import("./monitor/checkpoint.ts");
		const client = new S3Client({});
		const store = s3Store(client);
		const scratch = mkdtempSync(path.join(tmpdir(), "fleet-harvest-"));
		try {
			for (const spoke of args.spokes) {
				const dbPath = path.join(scratch, `${spoke.account}-${spoke.agent}.db`);
				const restored = await restoreCheckpoint(store, statePrefix(args.bundle, spoke.account, spoke.agent), dbPath);
				if (!restored.restored) {
					console.error(`${spoke.agent}: ${restored.reason}${restored.blocked ? " (blocked)" : ""}`);
					continue;
				}
				inputs.push({ rows: await readRows(dbPath, windowMs), origin: spoke });
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	const output = harvest(inputs, {
		windowDays: args.windowDays,
		thresholds: { minOrigins: args.minOrigins, minOccurrences: args.minOccurrences },
		targetDir: args.targetDir,
	});
	const json = JSON.stringify(output, null, 2);
	if (args.out) {
		writeFileSync(args.out, `${json}\n`);
		console.log(`${output.candidates.length} candidate(s) from ${output.spokes} spoke(s) -> ${args.out}`);
	} else {
		console.log(json);
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
