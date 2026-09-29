// memory-pr/src/github-client.ts
//
// SIO-849: minimal typed GitHub client over the REST Git Data + Pulls API using
// fetch (no @octokit dependency). The interface deliberately exposes ONLY the
// create-side operations needed to open a review PR. It has no merge / auto-merge
// method, so "never auto-merge" is enforced structurally: the capability does
// not exist on the client the agent holds.

export interface GitHubFile {
	path: string;
	contents: string;
}

export interface CreatedPullRequest {
	url: string;
	number: number;
}

export interface GitHubClient {
	// Resolve the head commit sha of a base branch.
	getBaseSha(base: string): Promise<string>;
	// SIO-1346: fetch a file's content at ref. Returns null when the path does not
	// exist there. Read-only -- exists so proposals that EDIT a shared file (the
	// skill-promotion agent.yaml insertion) can build the edit from the base
	// branch's live content instead of a stale local snapshot.
	getFileContent(path: string, ref: string): Promise<string | null>;
	// Create a single commit containing all files on top of baseSha. Returns the
	// new commit sha. Does not move any ref.
	createCommitWithFiles(opts: { baseSha: string; files: GitHubFile[]; message: string }): Promise<string>;
	// Create the branch ref at commitSha ("created"), or report that it already
	// exists ("exists"). Refs are never moved or force-reset (Codex SIO-1896:
	// GitHub's ref API has no compare-and-swap, so any move-then-check races a
	// concurrent caller); creation itself is atomic and is the only ownership test.
	createBranch(branch: string, commitSha: string): Promise<"created" | "exists">;
	// The newest PR whose head is this branch, in any state (Greptile PR #924): an
	// open one is reused by a retry, a closed or merged one refuses it (SIO-1357
	// fail-closed on repeated closure), and only a branch with no PR at all is a
	// partial attempt that createBranch may move.
	// Scoped to the configured base (Codex SIO-1896): a PR from the same branch
	// into another base is not this promotion. Without a base: any PR on the head.
	findPullRequest(head: string, base?: string): Promise<(CreatedPullRequest & { state: "open" | "closed" }) | null>;
	// Open a PR from head into base.
	createPullRequest(opts: { title: string; head: string; base: string; body: string }): Promise<CreatedPullRequest>;
	// Add labels to an existing PR. Separate from createPullRequest because the
	// Pulls API cannot set labels at creation time -- labels go through the
	// Issues API on the PR's number (CodeRabbit, PR #568).
	addLabels(prNumber: number, labels: string[]): Promise<void>;
}

export interface GitHubClientConfig {
	token: string;
	// "owner/repo"
	repo: string;
	apiBaseUrl?: string;
}

const DEFAULT_API = "https://api.github.com";

async function ghFetch<T>(config: GitHubClientConfig, method: string, path: string, body?: unknown): Promise<T> {
	const url = `${config.apiBaseUrl ?? DEFAULT_API}${path}`;
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${config.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
	}
	return (await res.json()) as T;
}

// fetch-based implementation. Uses the Git Data API to build a commit out of
// blobs + a tree, then creates the branch ref and the PR.
export function createFetchGitHubClient(config: GitHubClientConfig): GitHubClient {
	const repoPath = `/repos/${config.repo}`;
	const findPr = async (head: string, base?: string) => {
		const owner = config.repo.split("/")[0] ?? "";
		// newest first (GitHub sorts by created desc), any state
		const query = `state=all&per_page=1&head=${encodeURIComponent(`${owner}:${head}`)}${base ? `&base=${encodeURIComponent(base)}` : ""}`;
		const prs = await ghFetch<Array<{ html_url: string; number: number; state: "open" | "closed" }>>(
			config,
			"GET",
			`${repoPath}/pulls?${query}`,
		);
		const pr = prs[0];
		return pr ? { url: pr.html_url, number: pr.number, state: pr.state } : null;
	};
	return {
		async getBaseSha(base) {
			const ref = await ghFetch<{ object: { sha: string } }>(config, "GET", `${repoPath}/git/ref/heads/${base}`);
			return ref.object.sha;
		},

		// Written against fetch directly (not ghFetch) because 404 is an expected
		// outcome here (file absent at ref), not an error.
		async getFileContent(path, ref) {
			const encoded = path.split("/").map(encodeURIComponent).join("/");
			const url = `${config.apiBaseUrl ?? DEFAULT_API}${repoPath}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
			const res = await fetch(url, {
				headers: {
					Authorization: `Bearer ${config.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
			if (res.status === 404) return null;
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(
					`GitHub API GET ${repoPath}/contents/${path} failed: ${res.status} ${res.statusText} ${text}`.trim(),
				);
			}
			const body = (await res.json()) as { content?: string };
			if (typeof body.content !== "string") {
				throw new Error(
					`GitHub API GET ${repoPath}/contents/${path} returned no file content (directory or submodule?)`,
				);
			}
			return Buffer.from(body.content, "base64").toString("utf8");
		},

		async createCommitWithFiles({ baseSha, files, message }) {
			const baseCommit = await ghFetch<{ tree: { sha: string } }>(config, "GET", `${repoPath}/git/commits/${baseSha}`);
			const treeItems = await Promise.all(
				files.map(async (file) => {
					const blob = await ghFetch<{ sha: string }>(config, "POST", `${repoPath}/git/blobs`, {
						content: file.contents,
						encoding: "utf-8",
					});
					return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
				}),
			);
			const tree = await ghFetch<{ sha: string }>(config, "POST", `${repoPath}/git/trees`, {
				base_tree: baseCommit.tree.sha,
				tree: treeItems,
			});
			const commit = await ghFetch<{ sha: string }>(config, "POST", `${repoPath}/git/commits`, {
				message,
				tree: tree.sha,
				parents: [baseSha],
			});
			return commit.sha;
		},

		async createBranch(branch, commitSha) {
			try {
				await ghFetch(config, "POST", `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitSha });
				return "created";
			} catch (error) {
				// Only GitHub's own "Reference already exists" is an existing ref; any
				// other 422 (an invalid ref name, say) propagates (Codex SIO-1896).
				if (error instanceof Error && / 422 /.test(error.message) && /Reference already exists/.test(error.message)) {
					return "exists";
				}
				throw error;
			}
		},

		async findPullRequest(head, base) {
			return findPr(head, base);
		},

		async createPullRequest({ title, head, base, body }) {
			const pr = await ghFetch<{ html_url: string; number: number }>(config, "POST", `${repoPath}/pulls`, {
				title,
				head,
				base,
				body,
				draft: true,
			});
			return { url: pr.html_url, number: pr.number };
		},

		async addLabels(prNumber, labels) {
			await ghFetch(config, "POST", `${repoPath}/issues/${prNumber}/labels`, { labels });
		},
	};
}
