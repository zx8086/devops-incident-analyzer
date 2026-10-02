// agent/src/iac/renovate-marker-resolution.test.ts
//
// SIO-1918: resolveRenovateMarker reads the Dependency Dashboard through the native
// gitlab proxy tools. It called gitlab_get_issue, which GitLab 19.4 unlisted; the proxy
// stopped registering it, callGitlabProxyTool answered "[... unavailable ...]", that parsed
// as an empty description, and every Renovate turn ended in "No pending Renovate update".
// The pure parsers were unit-tested and stayed green throughout, so this drives the node
// itself against a tool registry shaped like the one the server serves today.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
// Spread the real module and override only getToolsForDataSource, as
// resolve-identifiers.test.ts does, so the override cannot poison sibling exports.
import * as realBridge from "../mcp-bridge.ts";

type StubTool = { name: string; invoke: (args: unknown) => Promise<unknown> };
let gitlabTools: StubTool[] = [];

mock.module("../mcp-bridge.ts", () => ({
	...realBridge,
	getToolsForDataSource: (dataSourceId: string) => (dataSourceId === "gitlab" ? gitlabTools : []),
}));

import { RENOVATE_DASHBOARD_TITLE, resolveRenovateMarker } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

afterAll(() => {
	mock.module("../mcp-bridge.ts", () => ({ ...realBridge }));
});

// Response shapes captured live from gitlab.com on 2026-10-02 (project and issue of the
// real dashboard), trimmed to two entries. Note what differs from the tool this replaced:
// the work item's `iid` is a STRING and `id` is a global id; `description` is unchanged.
const SEARCH_RESPONSE = JSON.stringify([
	{ id: 197582291, iid: 11, project_id: 82850717, title: RENOVATE_DASHBOARD_TITLE, description: "(also carried here)" },
]);
const WORK_ITEM_RESPONSE = JSON.stringify({
	id: "gid://gitlab/WorkItem/197582291",
	iid: "11",
	title: RENOVATE_DASHBOARD_TITLE,
	description:
		"## Awaiting Schedule\n\n" +
		" - [ ] <!-- unschedule-branch=renovate/ap-cld-checkpoint -->chore(deps): [ap-cld] checkpoint to v1.49.2\n" +
		" - [ ] <!-- unschedule-branch=renovate/eu-b2b-kubernetes -->chore(deps): [eu-b2b] kubernetes to v1.85.4\n",
	state: "OPEN",
	widgets: [],
});

function stateFor(deployment: string, integration: string): IacStateType {
	return { renovateTarget: { deployment, integration } } as unknown as IacStateType;
}

describe("resolveRenovateMarker reads the dashboard through gitlab_get_work_item (SIO-1918)", () => {
	let calls: Array<{ name: string; args: unknown }> = [];

	beforeEach(() => {
		calls = [];
		const tool = (name: string, reply: string): StubTool => ({
			name,
			invoke: async (args) => {
				calls.push({ name, args });
				return reply;
			},
		});
		// What the server serves today: no gitlab_get_issue.
		gitlabTools = [tool("gitlab_search", SEARCH_RESPONSE), tool("gitlab_get_work_item", WORK_ITEM_RESPONSE)];
	});

	test("one matching entry resolves to its marker and the issue iid", async () => {
		const out = await resolveRenovateMarker(stateFor("ap-cld", "checkpoint"));

		expect(out.renovateIssueIid).toBe(11);
		expect(out.renovateMarker?.marker).toBe("renovate/ap-cld-checkpoint");
		expect(calls.map((c) => c.name)).toEqual(["gitlab_search", "gitlab_get_work_item"]);
		// The upstream schema names the project `project_id` here, not `id` as get_issue did.
		expect(calls[1]?.args).toEqual({ project_id: expect.any(String), work_item_iid: 11 });
	});

	test("the description really is read: a target with no entry reports no match", async () => {
		const out = await resolveRenovateMarker(stateFor("eu-b2b", "checkpoint"));
		expect(out.renovateMarker).toBeUndefined();
		expect(out.renovateCandidates).toEqual([]);
	});

	test("with only the unlisted gitlab_get_issue registered, nothing resolves", async () => {
		// The pre-SIO-1918 world inverted: proves the node no longer depends on the old name.
		gitlabTools = [gitlabTools[0] as StubTool, { name: "gitlab_get_issue", invoke: async () => WORK_ITEM_RESPONSE }];
		const out = await resolveRenovateMarker(stateFor("ap-cld", "checkpoint"));
		expect(out.renovateMarker).toBeUndefined();
		expect(calls.map((c) => c.name)).toEqual(["gitlab_search"]);
	});
});
