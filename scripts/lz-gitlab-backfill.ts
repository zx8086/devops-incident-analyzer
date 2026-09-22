// scripts/lz-gitlab-backfill.ts

import {
	createMcpClient,
	importLandingZoneGitLabHistory,
	type LandingZoneImportOptions,
	type LandingZoneImportResult,
	landingZoneGitLabImportEnabled,
	stopHealthPolling,
} from "../packages/agent/src/index.ts";
import { resolveRepository } from "../packages/mcp-server-landing-zone-iac/src/tools/repositories.ts";

export interface LandingZoneBackfillArgs {
	repository: string;
	startAt: string;
}

const MAX_BACKFILL_STEPS = 1_000;

interface BackfillDependencies {
	connect: (baseUrl: string) => Promise<void>;
	ready: () => boolean;
	importHistory: (options: LandingZoneImportOptions) => Promise<LandingZoneImportResult>;
	write: (line: string) => void;
	env: Record<string, string | undefined>;
}

function argumentValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	if (index < 0) return undefined;
	return argv[index + 1];
}

export function parseBackfillArgs(argv: string[]): LandingZoneBackfillArgs {
	const repository = argumentValue(argv, "--repository");
	const startAt = argumentValue(argv, "--start-at");
	if (!repository || !startAt || argv.length !== 4) {
		throw new Error("Usage: bun scripts/lz-gitlab-backfill.ts --repository <allowlisted> --start-at <ISO timestamp>");
	}
	const resolvedRepository = resolveRepository(repository);
	const parsed = new Date(startAt);
	if (Number.isNaN(parsed.getTime())) throw new Error("--start-at must be a valid ISO timestamp");
	return { repository: resolvedRepository.name, startAt: parsed.toISOString() };
}

function safeSummary(args: LandingZoneBackfillArgs, result: LandingZoneImportResult) {
	const outcomes: Record<string, number> = {};
	for (const outcome of result.outcomes) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
	return {
		repository: args.repository,
		outcomes: Object.fromEntries(Object.entries(outcomes).sort(([left], [right]) => left.localeCompare(right))),
		checkpoint: {
			updatedAfter: result.checkpoint?.updatedAfter ?? args.startAt,
			inProgress: Boolean(result.checkpoint?.inProgress),
			pendingCount: result.checkpoint?.pendingMrIids?.length ?? 0,
		},
	};
}

const DEFAULT_DEPENDENCIES: BackfillDependencies = {
	connect: async (baseUrl) => createMcpClient({ landingZoneIacUrl: baseUrl }),
	ready: landingZoneGitLabImportEnabled,
	importHistory: importLandingZoneGitLabHistory,
	write: (line) => process.stdout.write(`${line}\n`),
	env: process.env,
};

export async function runLandingZoneGitLabBackfill(
	args: LandingZoneBackfillArgs,
	dependencies: BackfillDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
	const baseUrl = dependencies.env.LANDING_ZONE_IAC_MCP_URL;
	if (!baseUrl) throw new Error("LANDING_ZONE_IAC_MCP_URL is required for the controlled backfill");
	await dependencies.connect(baseUrl);
	if (!dependencies.ready()) throw new Error("Landing Zone graph or required GitLab read tools are unavailable");
	let options: LandingZoneImportOptions = { repository: args.repository, startAt: args.startAt };
	const outcomes: LandingZoneImportResult["outcomes"] = [];
	for (let step = 0; step < MAX_BACKFILL_STEPS; step++) {
		const result = await dependencies.importHistory(options);
		outcomes.push(...result.outcomes);
		if (!result.checkpoint?.inProgress) {
			dependencies.write(JSON.stringify(safeSummary(args, { outcomes, checkpoint: result.checkpoint })));
			return;
		}
		options = { repository: args.repository, checkpoint: result.checkpoint };
	}
	throw new Error(`Landing Zone GitLab backfill exceeded its ${MAX_BACKFILL_STEPS}-step safety limit`);
}

async function main(): Promise<void> {
	try {
		await runLandingZoneGitLabBackfill(parseBackfillArgs(process.argv.slice(2)));
	} finally {
		stopHealthPolling();
	}
}

if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(
			`Landing Zone GitLab backfill failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
		);
		process.exit(1);
	});
}
