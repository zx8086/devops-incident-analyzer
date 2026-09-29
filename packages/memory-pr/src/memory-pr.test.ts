// memory-pr/src/memory-pr.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { CreatedPullRequest, GitHubClient, GitHubFile } from "./github-client.ts";
import { createFetchGitHubClient, STALE_BRANCH_MS } from "./github-client.ts";
import { _setMemoryPrClientForTesting, fetchBaseFileContent, openMemoryPr } from "./index.ts";
import { scanContent, scanFiles } from "./secret-scan.ts";
import { MemoryPrProposalSchema } from "./types.ts";

// Records the sequence of client calls so tests can assert ordering and the
// absence of any merge operation (the interface has no merge method at all).
function makeFakeClient(fileContent: string | null = "base file content"): { client: GitHubClient; calls: string[] } {
	const calls: string[] = [];
	const client: GitHubClient = {
		async getBaseSha(base) {
			calls.push(`getBaseSha:${base}`);
			return "basesha";
		},
		async getFileContent(path, ref) {
			calls.push(`getFileContent:${path}:${ref}`);
			return fileContent;
		},
		async createCommitWithFiles(opts: { baseSha: string; files: GitHubFile[]; message: string }) {
			calls.push(`createCommit:${opts.files.map((f) => f.path).join(",")}`);
			return "commitsha";
		},
		async createBranch(branch, commitSha) {
			calls.push(`createBranch:${branch}:${commitSha}`);
			return "created" as const;
		},
		async findPullRequest(head, base) {
			calls.push(`findPullRequest:${head}->${base}`);
			return null;
		},
		async createPullRequest(opts): Promise<CreatedPullRequest> {
			calls.push(`createPR:${opts.head}->${opts.base}`);
			return { url: "https://github.com/o/r/pull/7", number: 7 };
		},
		async addLabels(prNumber, labels) {
			calls.push(`addLabels:${prNumber}:${labels.join(",")}`);
		},
	};
	return { client, calls };
}

const validProposal = {
	kind: "wiki-page" as const,
	branch: "agent/learn/kafka-lag",
	title: "Wiki: kafka lag",
	body: "compiled page proposal",
	files: [{ path: "agents/incident-analyzer/memory/wiki/pages/kafka-lag.md", contents: "# Kafka Lag\nclean content" }],
};

const enabledEnv = { MEMORY_PR_ENABLED: "true", GITHUB_TOKEN: "t", MEMORY_PR_REPO: "o/r", MEMORY_PR_BASE: "main" };

describe("MemoryPrProposalSchema", () => {
	test("requires an agent/learn/ branch", () => {
		expect(MemoryPrProposalSchema.safeParse({ ...validProposal, branch: "main" }).success).toBe(false);
		expect(MemoryPrProposalSchema.safeParse(validProposal).success).toBe(true);
	});

	test("requires at least one file", () => {
		expect(MemoryPrProposalSchema.safeParse({ ...validProposal, files: [] }).success).toBe(false);
	});
});

describe("secret-scan", () => {
	test("flags a GitHub token", () => {
		const findings = scanContent("x.md", `token: ghp_${"a".repeat(36)}`);
		expect(findings.some((f) => f.kind === "github_token")).toBe(true);
	});

	test("flags an AWS access key id and a private key block", () => {
		expect(scanContent("a", "AKIAIOSFODNN7EXAMPLE").some((f) => f.kind === "aws_access_key_id")).toBe(true);
		expect(scanContent("b", "-----BEGIN RSA PRIVATE KEY-----").some((f) => f.kind === "private_key_block")).toBe(true);
	});

	test("clean content yields no findings", () => {
		expect(scanFiles([{ path: "x.md", contents: "# A normal wiki page about kafka lag." }])).toEqual([]);
	});

	test("findings never include the matched secret value", () => {
		const findings = scanContent("x", `password = ${"s3cr3tvalue".repeat(3)}`);
		for (const f of findings) {
			expect(f.hint).not.toContain("s3cr3tvalue");
		}
	});
});

describe("openMemoryPr gating", () => {
	const prevKill = process.env.AGENT_KILL_SWITCH;
	afterEach(() => {
		if (prevKill === undefined) delete process.env.AGENT_KILL_SWITCH;
		else process.env.AGENT_KILL_SWITCH = prevKill;
	});

	test("skips when MEMORY_PR_ENABLED is not set (no client calls)", async () => {
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(validProposal, { client, env: { MEMORY_PR_ENABLED: "false" } });
		expect(result.status).toBe("skipped");
		expect(calls).toEqual([]);
	});

	test("skips when the kill switch is active", async () => {
		process.env.AGENT_KILL_SWITCH = "true";
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(validProposal, { client, env: enabledEnv });
		expect(result.status).toBe("skipped");
		expect(calls).toEqual([]);
	});

	test("blocks when branch equals base", async () => {
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(
			{ ...validProposal, branch: "agent/learn/x" },
			{ client, env: { ...enabledEnv, MEMORY_PR_BASE: "agent/learn/x" } },
		);
		expect(result.status).toBe("blocked");
		expect(calls).toEqual([]);
	});

	test("blocks when a file contains a secret (no GitHub write)", async () => {
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(
			{ ...validProposal, files: [{ path: "x.md", contents: `ghp_${"a".repeat(36)}` }] },
			{ client, env: enabledEnv },
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("secret");
		expect(calls).toEqual([]);
	});
});

describe("openMemoryPr happy path", () => {
	test("creates commit -> branch -> PR in order and never merges", async () => {
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(validProposal, { client, env: enabledEnv });
		expect(result.status).toBe("opened");
		expect(result.url).toContain("/pull/7");
		expect(calls).toEqual([
			"findPullRequest:agent/learn/kafka-lag->main",
			"getBaseSha:main",
			"createCommit:agents/incident-analyzer/memory/wiki/pages/kafka-lag.md",
			"createBranch:agent/learn/kafka-lag:commitsha",
			"createPR:agent/learn/kafka-lag->main",
		]);
		// Structural guarantee: no merge/auto-merge call exists in the sequence.
		expect(calls.some((c) => /merge/i.test(c))).toBe(false);
	});

	test("skips when token/repo are not configured even if enabled", async () => {
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(validProposal, { client, env: { MEMORY_PR_ENABLED: "true" } });
		expect(result.status).toBe("skipped");
		expect(calls).toEqual([]);
	});

	// CodeRabbit PR #568: labels used to be accepted by the schema but silently
	// discarded -- they now reach GitHub via the Issues API after PR creation.
	// Greptile PR #924: an opened-but-unrecorded promotion is retried; the retry
	// must find the PR the first attempt opened, not fail on its branch.
	test("reuses an already-open PR for the branch and writes nothing", async () => {
		const { client, calls } = makeFakeClient();
		client.findPullRequest = async (head, base) => {
			calls.push(`findPullRequest:${head}->${base}`);
			return { url: "https://github.com/o/r/pull/7", number: 7, state: "open" };
		};
		const result = await openMemoryPr({ ...validProposal, labels: ["learning-review"] }, { env: enabledEnv, client });
		expect(result).toMatchObject({ status: "opened", url: "https://github.com/o/r/pull/7", number: 7 });
		// Codex SIO-1896: a reused PR still gets the proposal labels (best-effort)
		expect(calls).toEqual(["findPullRequest:agent/learn/kafka-lag->main", "addLabels:7:learning-review"]);
	});

	// Codex SIO-1896: a branch a concurrent attempt just created is left alone.
	test("a busy branch skips without opening a PR, so the caller can retry later", async () => {
		const { client, calls } = makeFakeClient();
		client.createBranch = async (branch) => {
			calls.push(`createBranch:${branch}`);
			return "busy";
		};
		const result = await openMemoryPr(validProposal, { env: enabledEnv, client });
		expect(result).toMatchObject({ status: "skipped", reason: expect.stringContaining("in progress") });
		expect(calls.some((c) => c.startsWith("createPR"))).toBe(false);
	});

	test("a branch taken by a PR into another base blocks and writes nothing more", async () => {
		const { client, calls } = makeFakeClient();
		client.createBranch = async (branch) => {
			calls.push(`createBranch:${branch}`);
			return "taken";
		};
		const result = await openMemoryPr(validProposal, { env: enabledEnv, client });
		expect(result).toMatchObject({ status: "blocked", reason: expect.stringContaining("another base") });
		expect(calls.some((c) => c.startsWith("createPR"))).toBe(false);
	});

	// Codex SIO-1896: "taken" can also mean a concurrent caller opened the intended
	// same-base PR after the first lookup; that PR is reused, not reported blocked.
	test("a branch taken by a same-base PR opened meanwhile is reused as opened", async () => {
		const { client, calls } = makeFakeClient();
		let looked = 0;
		client.findPullRequest = async (head, base) => {
			calls.push(`findPullRequest:${head}->${base}`);
			looked += 1;
			return looked === 1 ? null : { url: "https://github.com/o/r/pull/9", number: 9, state: "open" };
		};
		client.createBranch = async () => "taken";
		const result = await openMemoryPr({ ...validProposal, labels: ["l"] }, { env: enabledEnv, client });
		expect(result).toMatchObject({ status: "opened", url: "https://github.com/o/r/pull/9", number: 9 });
		expect(calls.filter((c) => c.startsWith("findPullRequest"))).toEqual([
			"findPullRequest:agent/learn/kafka-lag->main",
			"findPullRequest:agent/learn/kafka-lag->main",
		]);
		expect(calls).toContain("addLabels:9:l");
		expect(calls.some((c) => c.startsWith("createPR"))).toBe(false);
	});

	test("a PR the concurrent attempt opened first is returned instead of a failure", async () => {
		const { client } = makeFakeClient();
		let looked = 0;
		client.findPullRequest = async () => {
			looked += 1;
			return looked === 1 ? null : { url: "https://github.com/o/r/pull/8", number: 8, state: "open" };
		};
		client.createPullRequest = async () => {
			throw new Error(
				"GitHub API POST /repos/o/r/pulls failed: 422 Unprocessable Entity A pull request already exists",
			);
		};
		const result = await openMemoryPr(validProposal, { env: enabledEnv, client });
		expect(result).toMatchObject({ status: "opened", url: "https://github.com/o/r/pull/8", number: 8 });
		expect(looked).toBe(2);
	});

	// SIO-1357 stays fail-closed: a branch whose PR was closed or merged is done.
	test("a closed or merged PR on the branch blocks a new one and writes nothing", async () => {
		const { client, calls } = makeFakeClient();
		client.findPullRequest = async (head, base) => {
			calls.push(`findPullRequest:${head}->${base}`);
			return { url: "https://github.com/o/r/pull/6", number: 6, state: "closed" };
		};
		const result = await openMemoryPr(validProposal, { env: enabledEnv, client });
		expect(result).toMatchObject({ status: "blocked", reason: expect.stringContaining("#6") });
		expect(calls).toEqual(["findPullRequest:agent/learn/kafka-lag->main"]);
	});

	test("forwards proposal labels to the opened PR", async () => {
		const { client, calls } = makeFakeClient();
		const result = await openMemoryPr(
			{ ...validProposal, labels: ["hil-learning", "skill-promotion"] },
			{ client, env: enabledEnv },
		);
		expect(result.status).toBe("opened");
		expect(calls.at(-1)).toBe("addLabels:7:hil-learning,skill-promotion");
	});

	test("a labeling failure still reports the PR as opened (best-effort)", async () => {
		const { client } = makeFakeClient();
		client.addLabels = async () => {
			throw new Error("labels API down");
		};
		const result = await openMemoryPr({ ...validProposal, labels: ["hil-learning"] }, { client, env: enabledEnv });
		expect(result.status).toBe("opened");
		expect(result.url).toContain("/pull/7");
	});
});

// SIO-1346: base-branch reads for proposals that edit an existing file.
// Greptile PR #924: the fetch client behind openMemoryPr's idempotency.
describe("createFetchGitHubClient branch and PR lookup", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const client = createFetchGitHubClient({ token: "t", repo: "o/r", apiBaseUrl: "https://gh.test" });

	// The existing ref's commit age decides: old = abandoned partial attempt
	// (moved), young = a concurrent caller's branch (busy, untouched).
	function refStub(commitDate: string, foreignPr = false) {
		const seen: Array<{ method: string; url: string; body: string | null }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const u = String(url);
			seen.push({ method, url: u, body: typeof init?.body === "string" ? init.body : null });
			if (method === "POST") {
				return new Response('{"message":"Reference already exists"}', {
					status: 422,
					statusText: "Unprocessable Entity",
				});
			}
			if (u.includes("/pulls?")) {
				return new Response(
					foreignPr ? '[{"html_url":"https://github.com/o/r/pull/5","number":5,"state":"open"}]' : "[]",
					{ status: 200 },
				);
			}
			if (u.endsWith("/git/ref/heads/agent/learn/x")) return new Response('{"object":{"sha":"old1"}}', { status: 200 });
			if (u.endsWith("/git/commits/old1")) {
				return new Response(JSON.stringify({ committer: { date: commitDate } }), { status: 200 });
			}
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		return seen;
	}

	test("createBranch creates a fresh ref", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 201 })) as unknown as typeof fetch;
		expect(await client.createBranch("agent/learn/x", "abc")).toBe("created");
	});

	test("createBranch moves an abandoned ref (422, old commit) to the new commit with force", async () => {
		const seen = refStub(new Date(Date.now() - STALE_BRANCH_MS - 1000).toISOString());
		expect(await client.createBranch("agent/learn/x", "abc")).toBe("moved");
		expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
			"POST https://gh.test/repos/o/r/git/refs",
			"GET https://gh.test/repos/o/r/pulls?state=all&per_page=1&head=o%3Aagent%2Flearn%2Fx",
			"GET https://gh.test/repos/o/r/git/ref/heads/agent/learn/x",
			"GET https://gh.test/repos/o/r/git/commits/old1",
			"PATCH https://gh.test/repos/o/r/git/refs/heads/agent/learn/x",
		]);
		expect(JSON.parse(seen[4]?.body ?? "{}")).toEqual({ sha: "abc", force: true });
	});

	// Codex SIO-1896: a PR into ANY base owns the ref, however old; never move it.
	test("createBranch never moves a ref that a PR into another base uses", async () => {
		const seen = refStub(new Date(Date.now() - STALE_BRANCH_MS - 1000).toISOString(), true);
		expect(await client.createBranch("agent/learn/x", "abc")).toBe("taken");
		expect(seen.some((s) => s.method === "PATCH")).toBe(false);
	});

	test("createBranch leaves a young ref alone (422, recent commit) and reports busy", async () => {
		const seen = refStub(new Date().toISOString());
		expect(await client.createBranch("agent/learn/x", "abc")).toBe("busy");
		expect(seen.some((s) => s.method === "PATCH")).toBe(false);
	});

	test("createBranch rethrows any other failure", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
		await expect(client.createBranch("agent/learn/x", "abc")).rejects.toThrow(/500/);
	});

	test("findPullRequest asks for the newest PR on owner:branch into the base, in any state", async () => {
		let url = "";
		globalThis.fetch = (async (u: string | URL | Request) => {
			url = String(u);
			return new Response(JSON.stringify([{ html_url: "https://github.com/o/r/pull/3", number: 3, state: "closed" }]), {
				status: 200,
			});
		}) as typeof fetch;
		expect(await client.findPullRequest("agent/learn/x", "main")).toEqual({
			url: "https://github.com/o/r/pull/3",
			number: 3,
			state: "closed",
		});
		expect(url).toBe("https://gh.test/repos/o/r/pulls?state=all&per_page=1&head=o%3Aagent%2Flearn%2Fx&base=main");
		globalThis.fetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
		expect(await client.findPullRequest("agent/learn/x", "main")).toBeNull();
	});
});

describe("fetchBaseFileContent", () => {
	const prevKill = process.env.AGENT_KILL_SWITCH;
	afterEach(() => {
		if (prevKill === undefined) delete process.env.AGENT_KILL_SWITCH;
		else process.env.AGENT_KILL_SWITCH = prevKill;
		_setMemoryPrClientForTesting(null);
	});

	test("skips when MEMORY_PR_ENABLED is not set (no client calls)", async () => {
		const { client, calls } = makeFakeClient();
		const result = await fetchBaseFileContent("agents/incident-analyzer/agent.yaml", {
			client,
			env: { MEMORY_PR_ENABLED: "false" },
		});
		expect(result).toEqual({ status: "skipped", reason: "MEMORY_PR_ENABLED is not set" });
		expect(calls).toEqual([]);
	});

	test("skips when the kill switch is active", async () => {
		process.env.AGENT_KILL_SWITCH = "true";
		const { client, calls } = makeFakeClient();
		const result = await fetchBaseFileContent("agents/incident-analyzer/agent.yaml", { client, env: enabledEnv });
		expect(result.status).toBe("skipped");
		expect(calls).toEqual([]);
	});

	test("skips when token/repo are not configured even if enabled", async () => {
		const { client, calls } = makeFakeClient();
		const result = await fetchBaseFileContent("x.yaml", { client, env: { MEMORY_PR_ENABLED: "true" } });
		expect(result.status).toBe("skipped");
		expect(calls).toEqual([]);
	});

	test("returns the base branch's content on the happy path", async () => {
		const { client, calls } = makeFakeClient("skills:\n  - existing\n");
		const result = await fetchBaseFileContent("agents/incident-analyzer/agent.yaml", { client, env: enabledEnv });
		expect(result).toEqual({ status: "ok", content: "skills:\n  - existing\n" });
		expect(calls).toEqual(["getFileContent:agents/incident-analyzer/agent.yaml:main"]);
	});

	test("a missing file (404 -> null) is ok/null, not an error", async () => {
		const { client } = makeFakeClient(null);
		const result = await fetchBaseFileContent("agents/incident-analyzer/agent.yaml", { client, env: enabledEnv });
		expect(result).toEqual({ status: "ok", content: null });
	});

	test("_setMemoryPrClientForTesting is consulted when options.client is omitted", async () => {
		const { client, calls } = makeFakeClient("injected content");
		_setMemoryPrClientForTesting(client);
		const result = await fetchBaseFileContent("x.yaml", { env: enabledEnv });
		expect(result).toEqual({ status: "ok", content: "injected content" });
		expect(calls).toEqual(["getFileContent:x.yaml:main"]);
	});
});
