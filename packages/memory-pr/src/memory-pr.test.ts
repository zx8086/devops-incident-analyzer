// memory-pr/src/memory-pr.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { CreatedPullRequest, GitHubClient, GitHubFile } from "./github-client.ts";
import { createFetchGitHubClient } from "./github-client.ts";
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

	// Greptile PR #924 / Codex SIO-1896: nothing is reused, refreshed or moved. A
	// branch with a PR (open or closed) blocks with that PR's URL; a branch with
	// no PR at all is a retryable skip naming it; a PR a concurrent attempt
	// opened first blocks the same way rather than failing.
	test("an open PR on the branch blocks with its URL and writes nothing", async () => {
		const { client, calls } = makeFakeClient();
		client.findPullRequest = async (head, base) => {
			calls.push(`findPullRequest:${head}->${base}`);
			return { url: "https://github.com/o/r/pull/7", number: 7, state: "open" };
		};
		const result = await openMemoryPr(validProposal, { env: enabledEnv, client });
		expect(result).toMatchObject({
			status: "blocked",
			url: "https://github.com/o/r/pull/7",
			number: 7,
			reason: expect.stringContaining("open PR #7"),
		});
		expect(calls).toEqual(["findPullRequest:agent/learn/kafka-lag->main"]);
	});

	test("an existing branch: with a PR into ANY base it blocks, without one it is a retryable skip", async () => {
		const withPr = makeFakeClient();
		const lookups: Array<string | undefined> = [];
		withPr.client.findPullRequest = async (_head, base) => {
			lookups.push(base);
			// Greptile #924: a PR into another base is found only by the base-less lookup
			return base === undefined ? { url: "https://github.com/o/r/pull/9", number: 9, state: "open" } : null;
		};
		withPr.client.createBranch = async () => "exists";
		expect(await openMemoryPr(validProposal, { env: enabledEnv, client: withPr.client })).toMatchObject({
			status: "blocked",
			reason: expect.stringContaining("pull/9"),
		});
		expect(withPr.calls.some((c) => c.startsWith("createPR"))).toBe(false);
		expect(lookups).toEqual(["main", undefined]);

		const { client, calls } = makeFakeClient();
		client.createBranch = async () => "exists";
		expect(await openMemoryPr(validProposal, { env: enabledEnv, client })).toMatchObject({
			status: "skipped",
			reason: expect.stringContaining("delete the branch to retry"),
		});
		expect(calls.some((c) => c.startsWith("createPR"))).toBe(false);
	});

	test("a PR the concurrent attempt opened first blocks with its URL instead of failing", async () => {
		const { client } = makeFakeClient();
		let looked = 0;
		client.findPullRequest = async () =>
			++looked === 1 ? null : { url: "https://github.com/o/r/pull/8", number: 8, state: "open" };
		client.createPullRequest = async () => {
			throw new Error(
				"GitHub API POST /repos/o/r/pulls failed: 422 Unprocessable Entity A pull request already exists",
			);
		};
		expect(await openMemoryPr(validProposal, { env: enabledEnv, client })).toMatchObject({
			status: "blocked",
			reason: expect.stringContaining("pull/8"),
		});
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
		expect(result).toMatchObject({
			status: "blocked",
			reason: expect.stringContaining("now closed; a reviewed proposal is not re-proposed automatically"),
		});
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

	test("createBranch creates a fresh ref, reports an existing one, never moves it", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 201 })) as unknown as typeof fetch;
		expect(await client.createBranch("agent/learn/x", "abc")).toBe("created");
		const methods: string[] = [];
		globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			return new Response('{"message":"Reference already exists"}', {
				status: 422,
				statusText: "Unprocessable Entity",
			});
		}) as typeof fetch;
		expect(await client.createBranch("agent/learn/x", "abc")).toBe("exists");
		expect(methods).toEqual(["POST"]);
	});

	// Codex SIO-1896: any OTHER 422 (an invalid ref name) is an error, not "exists"
	test("createBranch propagates a 422 that is not an existing reference", async () => {
		globalThis.fetch = (async () =>
			new Response('{"message":"Reference name is not well-formed"}', {
				status: 422,
				statusText: "Unprocessable Entity",
			})) as unknown as typeof fetch;
		await expect(client.createBranch("agent/learn/foo..bar", "abc")).rejects.toThrow(/not well-formed/);
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
