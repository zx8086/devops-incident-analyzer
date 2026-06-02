// src/tools/gitlab.test.ts
import { describe, expect, test } from "bun:test";
import { buildCommitFileBody } from "./gitlab.ts";

// SIO-873: the GitLab commits API needs a single "update" action with the FULL new
// file content (not a diff). This is what gitlab_commit_file POSTs.
describe("buildCommitFileBody", () => {
	test("builds a single update action with full content", () => {
		const body = buildCommitFileBody({
			branch: "agent/ap-cld-9-4-2-version-upgrade-20260602",
			commitMessage: "ap-cld: upgrade Elasticsearch 9.4.1 -> 9.4.2",
			filePath: "environments/_deployments/ap-cld.json",
			content: '{\n  "version": "9.4.2"\n}\n',
		});
		expect(body.branch).toBe("agent/ap-cld-9-4-2-version-upgrade-20260602");
		expect(body.commit_message).toContain("9.4.1 -> 9.4.2");
		expect(body.actions).toHaveLength(1);
		expect(body.actions[0]).toEqual({
			action: "update",
			file_path: "environments/_deployments/ap-cld.json",
			content: '{\n  "version": "9.4.2"\n}\n',
		});
	});
});
