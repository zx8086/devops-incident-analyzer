// memory-pr/src/index.ts
//
// SIO-849: PR-based human-in-the-loop for durable agent learnings. A proposal
// (wiki page, promoted key-decision, or new skill) is staged on a fresh
// agent/learn/* branch and opened as a draft PR for human review. Never merges,
// never commits secrets, no-op when disabled or the kill switch is active.

import { getLogger } from "@devops-agent/observability";
import { isKillSwitchActive } from "@devops-agent/shared";
import { type CreatedPullRequest, createFetchGitHubClient, type GitHubClient } from "./github-client.ts";
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

	// Greptile PR #924: a retry whose earlier attempt opened a PR (but could not
	// record it) reuses that PR rather than failing on the existing branch. A
	// closed or merged PR on the branch refuses the write instead (SIO-1357: a
	// repeated closure of the same thread must never open a duplicate).
	// Best-effort: the PR is already open, so a labeling failure must not turn an
	// "opened" result into a thrown failure (a retry would double-open the branch).
	// Also applied to a reused PR, whose first attempt may have died before
	// labeling (Codex SIO-1896); adding a label twice is a no-op on GitHub.
	const labelBestEffort = async (pr: CreatedPullRequest) => {
		if (!parsed.labels || parsed.labels.length === 0) return;
		try {
			await client.addLabels(pr.number, parsed.labels);
		} catch (error) {
			logger.warn(
				{ url: pr.url, labels: parsed.labels, error: error instanceof Error ? error.message : String(error) },
				"memory review PR opened but labeling failed",
			);
		}
	};

	const existing = await client.findPullRequest(parsed.branch, config.base);
	if (existing?.state === "open") {
		logger.info({ url: existing.url, number: existing.number, branch: parsed.branch }, "memory review PR already open");
		await labelBestEffort(existing);
		return {
			status: "opened",
			url: existing.url,
			number: existing.number,
			reason: "an open PR for this branch already exists",
		};
	}
	if (existing) {
		return {
			status: "blocked",
			reason: `branch "${parsed.branch}" already had PR #${existing.number} (${existing.url}), now closed`,
		};
	}

	const baseSha = await client.getBaseSha(config.base);
	const commitSha = await client.createCommitWithFiles({
		baseSha,
		files: parsed.files,
		message: `${proposal.title}\n\nAutomated durable-memory proposal (${proposal.kind}). Review before merge.`,
	});
	const created = await client.createBranch(parsed.branch, commitSha);
	if (created === "busy") {
		// Codex SIO-1896: a concurrent attempt owns the branch; nothing was
		// written, and "skipped" leaves the caller free to retry later.
		return { status: "skipped", reason: `another attempt on branch "${parsed.branch}" is in progress; retry later` };
	}
	if (created === "taken") {
		// Codex SIO-1896: a concurrent caller may have opened the intended PR (same
		// base) between the first lookup and the 422; reuse it. Otherwise the branch
		// belongs to a PR into another base, or a closed one, and a retry cannot help.
		const same = await client.findPullRequest(parsed.branch, config.base);
		if (same?.state === "open") {
			logger.info(
				{ url: same.url, number: same.number, branch: parsed.branch },
				"memory review PR opened concurrently",
			);
			await labelBestEffort(same);
			return { status: "opened", url: same.url, number: same.number, reason: "opened by a concurrent attempt" };
		}
		return {
			status: "blocked",
			reason: same
				? `branch "${parsed.branch}" already had PR #${same.number} (${same.url}), now closed`
				: `branch "${parsed.branch}" is used by a PR into another base`,
		};
	}
	let pr: CreatedPullRequest;
	try {
		pr = await client.createPullRequest({
			title: proposal.title,
			head: parsed.branch,
			base: config.base,
			body: proposal.body,
		});
	} catch (error) {
		// 422 "A pull request already exists": the concurrent attempt got there
		// first; converge on its PR rather than fail.
		const raced =
			error instanceof Error && / 422 /.test(error.message)
				? await client.findPullRequest(parsed.branch, config.base)
				: null;
		if (raced?.state !== "open") throw error;
		logger.info(
			{ url: raced.url, number: raced.number, branch: parsed.branch },
			"memory review PR opened concurrently",
		);
		await labelBestEffort(raced);
		return { status: "opened", url: raced.url, number: raced.number, reason: "opened by a concurrent attempt" };
	}

	await labelBestEffort(pr);

	logger.info({ url: pr.url, number: pr.number, kind: proposal.kind }, "opened memory review PR");
	return { status: "opened", url: pr.url, number: pr.number };
}
