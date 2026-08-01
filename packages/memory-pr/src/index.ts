// memory-pr/src/index.ts
//
// SIO-849: PR-based human-in-the-loop for durable agent learnings. A proposal
// (wiki page, promoted key-decision, or new skill) is staged on a fresh
// agent/learn/* branch and opened as a draft PR for human review. Never merges,
// never commits secrets, no-op when disabled or the kill switch is active.

import { getLogger } from "@devops-agent/observability";
import { isKillSwitchActive } from "@devops-agent/shared";
import { createFetchGitHubClient, type GitHubClient } from "./github-client.ts";
import { scanFiles } from "./secret-scan.ts";
import { type MemoryPrProposal, MemoryPrProposalSchema, type OpenMemoryPrResult } from "./types.ts";

export { createFetchGitHubClient, type GitHubClient } from "./github-client.ts";
export { type SecretFinding, scanContent, scanFiles } from "./secret-scan.ts";
export {
	type MemoryPrFile,
	MemoryPrFileSchema,
	type MemoryPrProposal,
	MemoryPrProposalSchema,
	type OpenMemoryPrResult,
} from "./types.ts";

const logger = getLogger("memory-pr");

interface MemoryPrConfig {
	enabled: boolean;
	token?: string;
	repo?: string;
	base: string;
}

export function resolveMemoryPrConfig(env: NodeJS.ProcessEnv = process.env): MemoryPrConfig {
	const flag = env.MEMORY_PR_ENABLED;
	return {
		enabled: flag === "true" || flag === "1",
		token: env.GITHUB_TOKEN,
		repo: env.MEMORY_PR_REPO,
		base: env.MEMORY_PR_BASE && env.MEMORY_PR_BASE !== "" ? env.MEMORY_PR_BASE : "main",
	};
}

export interface OpenMemoryPrOptions {
	// Injectable for tests; defaults to the fetch client built from env config.
	client?: GitHubClient;
	env?: NodeJS.ProcessEnv;
}

// SIO-1346: module-level test seam (mirrors the agent package's
// __setAgentMemoryClient idiom). Consulted before the fetch-client fallback
// whenever options.client is omitted, so callers deep inside the graph
// (applyHeuristic -> draftSkillPr) are testable without threading options.
let testClientOverride: GitHubClient | null = null;

export function _setMemoryPrClientForTesting(client: GitHubClient | null): void {
	testClientOverride = client;
}

function resolveClient(options: OpenMemoryPrOptions, token: string, repo: string): GitHubClient {
	return options.client ?? testClientOverride ?? createFetchGitHubClient({ token, repo });
}

export type FetchBaseFileResult = { status: "ok"; content: string | null } | { status: "skipped"; reason: string };

// SIO-1346: read a file's current content from the base branch via the GitHub
// API. A proposal that EDITS a shared file (the skill-promotion path's
// agent.yaml insertion) must build the edit from this live content, never a
// local snapshot -- createCommitWithFiles replaces listed paths wholesale
// against the base tree, so a stale snapshot would clobber concurrently merged
// changes. Gates mirror openMemoryPr so callers get identical self-skip
// behavior when the flow is disabled or unconfigured.
export async function fetchBaseFileContent(
	path: string,
	options: OpenMemoryPrOptions = {},
): Promise<FetchBaseFileResult> {
	const config = resolveMemoryPrConfig(options.env);
	if (!config.enabled) {
		return { status: "skipped", reason: "MEMORY_PR_ENABLED is not set" };
	}
	if (isKillSwitchActive()) {
		return { status: "skipped", reason: "kill switch active" };
	}
	if (!config.token || !config.repo) {
		return { status: "skipped", reason: "GITHUB_TOKEN or MEMORY_PR_REPO not configured" };
	}
	const client = resolveClient(options, config.token, config.repo);
	return { status: "ok", content: await client.getFileContent(path, config.base) };
}

// Stages the proposal's files on a fresh branch and opens a draft PR. Returns a
// structured result rather than throwing for the expected "off" paths
// (disabled, kill switch, secret hit) so callers (lifecycle teardown) can treat
// them as soft outcomes.
export async function openMemoryPr(
	proposal: MemoryPrProposal,
	options: OpenMemoryPrOptions = {},
): Promise<OpenMemoryPrResult> {
	const parsed = MemoryPrProposalSchema.parse(proposal);
	const config = resolveMemoryPrConfig(options.env);

	if (!config.enabled) {
		return { status: "skipped", reason: "MEMORY_PR_ENABLED is not set" };
	}
	if (isKillSwitchActive()) {
		return { status: "skipped", reason: "kill switch active" };
	}
	// Refuse to ever write directly to the base branch.
	if (parsed.branch === config.base) {
		return { status: "blocked", reason: `refusing to write to base branch "${config.base}"` };
	}

	// Hard stop: a credential in any file aborts before any GitHub write.
	const secrets = scanFiles(parsed.files);
	if (secrets.length > 0) {
		logger.error(
			{ kinds: secrets.map((s) => s.kind), paths: secrets.map((s) => s.path) },
			"secret scan blocked memory PR",
		);
		return { status: "blocked", reason: `secret scan found ${secrets.length} potential secret(s)` };
	}

	if (!config.token || !config.repo) {
		return { status: "skipped", reason: "GITHUB_TOKEN or MEMORY_PR_REPO not configured" };
	}

	const client = resolveClient(options, config.token, config.repo);

	const baseSha = await client.getBaseSha(config.base);
	const commitSha = await client.createCommitWithFiles({
		baseSha,
		files: parsed.files,
		message: `${proposal.title}\n\nAutomated durable-memory proposal (${proposal.kind}). Review before merge.`,
	});
	await client.createBranch(parsed.branch, commitSha);
	const pr = await client.createPullRequest({
		title: proposal.title,
		head: parsed.branch,
		base: config.base,
		body: proposal.body,
	});

	logger.info({ url: pr.url, number: pr.number, kind: proposal.kind }, "opened memory review PR");
	return { status: "opened", url: pr.url, number: pr.number };
}
