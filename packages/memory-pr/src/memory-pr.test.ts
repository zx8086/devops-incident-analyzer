// memory-pr/src/memory-pr.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { CreatedPullRequest, GitHubClient, GitHubFile } from "./github-client.ts";
import { openMemoryPr } from "./index.ts";
import { scanContent, scanFiles } from "./secret-scan.ts";
import { MemoryPrProposalSchema } from "./types.ts";

// Records the sequence of client calls so tests can assert ordering and the
// absence of any merge operation (the interface has no merge method at all).
function makeFakeClient(): { client: GitHubClient; calls: string[] } {
	const calls: string[] = [];
	const client: GitHubClient = {
		async getBaseSha(base) {
			calls.push(`getBaseSha:${base}`);
			return "basesha";
		},
		async createCommitWithFiles(opts: { baseSha: string; files: GitHubFile[]; message: string }) {
			calls.push(`createCommit:${opts.files.map((f) => f.path).join(",")}`);
			return "commitsha";
		},
		async createBranch(branch, commitSha) {
			calls.push(`createBranch:${branch}:${commitSha}`);
		},
		async createPullRequest(opts): Promise<CreatedPullRequest> {
			calls.push(`createPR:${opts.head}->${opts.base}`);
			return { url: "https://github.com/o/r/pull/7", number: 7 };
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
});
