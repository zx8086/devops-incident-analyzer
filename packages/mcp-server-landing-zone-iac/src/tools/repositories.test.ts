import { describe, expect, mock, test } from "bun:test";
import {
	type GitLabReadClient,
	LANDING_ZONE_REPOSITORIES,
	readRepositoryFiles,
	resolveRepository,
} from "./repositories.ts";

const activeRepositoryNames = [
	"aws-lz-account-creator",
	"aws-lz-ami",
	"aws-lz-app-proxy",
	"aws-lz-backup",
	"aws-lz-citrix",
	"aws-lz-dc",
	"aws-lz-dfs",
	"aws-lz-f5-ingress",
	"aws-lz-finops",
	"aws-lz-infra-ss-components",
	"aws-lz-logging",
	"aws-lz-monitoring",
	"aws-lz-network-core",
	"aws-lz-network-workloads",
	"aws-lz-post-vending",
	"aws-lz-security-tools",
	"aws-lz-ssm",
	"aws-lz-storage",
	"aws-lz-vending-orchestrator",
	"aws-lz-shared-tools",
	"dhco-gitlab-terraform",
	"gitlab-k8s-runners-lzv2",
	"gitlab-k8s-runners-terraform",
] as const;

describe("Landing Zone repository allowlist", () => {
	test("contains the 20 Landing Zone repositories and three adjacent platform repositories", () => {
		expect(LANDING_ZONE_REPOSITORIES).toHaveLength(23);
		expect(LANDING_ZONE_REPOSITORIES.map((repository) => repository.name).sort()).toEqual(
			[...activeRepositoryNames].sort(),
		);
	});

	test.each(activeRepositoryNames.map((name) => [name] as const))("resolves %s", (name) => {
		expect(resolveRepository(name).name).toBe(name);
	});

	test("rejects an unknown repository before calling GitLab", async () => {
		const readFile = mock(async () => ({ content: "", blobId: "unused", size: 0 }));
		const client = { readFile } as unknown as GitLabReadClient;

		await expect(readRepositoryFiles(client, { repository: "outside-catalog", paths: ["README.md"] })).rejects.toThrow(
			"Repository is not in the Landing Zone catalog",
		);
		expect(readFile).not.toHaveBeenCalled();
	});

	test("rejects sensitive paths and redacts credential-like literal values", async () => {
		const readFile = mock(async () => ({
			content:
				'token = "glpat-example"\nexport AWS_SECRET_ACCESS_KEY=aws-secret\nGITLAB_PERSONAL_ACCESS_TOKEN: gitlab-secret\nclient_secret = "oauth-secret"\nname = "safe"',
			blobId: "blob-1",
			size: 42,
		}));
		const client = {
			async project() {
				return { id: 1, defaultBranch: "main", headSha: "sha-1", lastActivityAt: "2026-09-22" };
			},
			readFile,
		} as unknown as GitLabReadClient;

		await expect(
			readRepositoryFiles(client, { repository: "aws-lz-account-creator", paths: [".env"] }),
		).rejects.toThrow("not available through the evidence facade");
		const result = await readRepositoryFiles(client, {
			repository: "aws-lz-account-creator",
			paths: ["accounts/example.yml"],
		});
		expect(result.files[0]?.content).toContain("token = [REDACTED]");
		expect(result.files[0]?.content).toContain("export AWS_SECRET_ACCESS_KEY=[REDACTED]");
		expect(result.files[0]?.content).toContain("GITLAB_PERSONAL_ACCESS_TOKEN: [REDACTED]");
		expect(result.files[0]?.content).toContain("client_secret = [REDACTED]");
		expect(result.files[0]?.content).not.toContain("glpat-example");
		expect(result.files[0]?.content).not.toContain("aws-secret");
		expect(result.files[0]?.content).not.toContain("gitlab-secret");
		expect(result.files[0]?.content).not.toContain("oauth-secret");
	});
});
