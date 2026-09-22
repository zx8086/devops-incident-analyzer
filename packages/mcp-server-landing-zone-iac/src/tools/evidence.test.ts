import { describe, expect, test } from "bun:test";
import { findRepresentativeExamples, readPipelinePlan } from "./evidence.ts";
import type { GitLabReadClient } from "./repositories.ts";

function fakeClient(): GitLabReadClient {
	return {
		async project() {
			return { id: 42, defaultBranch: "main", headSha: "abc123", lastActivityAt: "2026-09-22T08:00:00Z" };
		},
		async tree() {
			return [
				...Array.from({ length: 6 }, (_, index) => ({ path: `accounts/app-${index + 1}.yml`, type: "blob" as const })),
				{ path: "schemas/account.schema.json", type: "blob" as const },
				{ path: "scripts/generate_tf.py", type: "blob" as const },
				{ path: "tests/account.test.ts", type: "blob" as const },
			];
		},
		async readFile(_projectPath, path) {
			return { content: `content:${path}`, blobId: `blob:${path}`, size: path.length };
		},
		async openChanges() {
			return [{ iid: 7, title: "Account schema work", webUrl: "https://gitlab.example/mr/7", updatedAt: "2026-09-22" }];
		},
		async changePaths() {
			return ["accounts/app-2.yml"];
		},
		async pipelineJobs() {
			return [
				{ id: 10, name: "validate", status: "success", webUrl: "https://gitlab.example/jobs/10" },
				{ id: 11, name: "terraform-plan", status: "success", webUrl: "https://gitlab.example/jobs/11" },
			];
		},
		async jobTrace() {
			return "Plan: 2 to add, 0 to change, 0 to destroy.";
		},
	};
}

describe("representative evidence", () => {
	test("returns schema, generator, test, five active examples, and relevant open work", async () => {
		const evidence = await findRepresentativeExamples(fakeClient(), {
			repository: "aws-lz-account-creator",
			path: "accounts",
		});

		expect(evidence.examples).toHaveLength(5);
		expect(evidence.contracts.map((item) => item.kind).sort()).toEqual(["generator", "schema", "test"]);
		expect(evidence.openChanges).toHaveLength(1);
		expect(evidence.provenance.untrustedContent).toBe(true);
		expect(evidence.provenance.ref).toBe("abc123");
	});

	test("returns only plan jobs and bounded trace evidence", async () => {
		const result = await readPipelinePlan(fakeClient(), {
			repository: "aws-lz-account-creator",
			pipelineId: 99,
		});

		expect(result.jobs).toHaveLength(1);
		expect(result.jobs[0]?.name).toBe("terraform-plan");
		expect(result.jobs[0]?.trace).toContain("0 to destroy");
	});
});
