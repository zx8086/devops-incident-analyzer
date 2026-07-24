// agent/src/iac/space-security.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	addRolePrivileges,
	branchSlug,
	isPrivilegeEscalation,
	parseIntentJson,
	reviewPlan,
	setSpaceFields,
} from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const SPACE = JSON.stringify(
	{
		name: "Developer eXperience",
		description: "old desc",
		color: "#9170B8",
		initials: "DX",
		disabled_features: ["siemV5", "enterpriseSearch"],
		solution: "classic",
	},
	null,
	2,
);

// A real-shaped security aggregate with roles + role_mappings + api_keys.
const SECURITY = JSON.stringify(
	{
		roles: {
			developer: {
				name: "developer",
				cluster: [],
				indices: [],
				applications: [{ application: "kibana-.kibana", privileges: ["feature_discover.read"], resources: ["*"] }],
			},
		},
		role_mappings: { developer: { name: "developer", enabled: true, roles: ["developer"], rules: { all: [] } } },
		api_keys: { SECRET_KEY: { id: "do-not-touch", encoded: "shhh" } },
	},
	null,
	2,
);

describe("setSpaceFields", () => {
	test("sets name/description/color, captures previous, preserves disabled_features + solution", () => {
		const { content, previousDescription } = setSpaceFields(SPACE, { description: "new desc", color: "#000000" });
		const parsed = JSON.parse(content) as {
			description: string;
			color: string;
			disabled_features: string[];
			solution: string;
		};
		expect(parsed.description).toBe("new desc");
		expect(parsed.color).toBe("#000000");
		expect(parsed.disabled_features).toEqual(["siemV5", "enterpriseSearch"]); // untouched
		expect(parsed.solution).toBe("classic"); // untouched
		expect(previousDescription).toBe("old desc");
	});

	test("changed=false when nothing requested + preserves formatting", () => {
		expect(setSpaceFields(SPACE, {}).changed).toBe(false);
		expect(setSpaceFields(SPACE, { color: "#111" }).content.endsWith("}\n")).toBe(true);
	});

	test("throws on non-object JSON", () => {
		expect(() => setSpaceFields("[]", { color: "#111" })).toThrow("not an object");
	});
});

describe("isPrivilegeEscalation", () => {
	test("any cluster-level grant is escalation", () => {
		expect(isPrivilegeEscalation({ cluster: ["monitor"] })).toBe(true);
	});
	test("'all' / '*' / superuser anywhere is escalation", () => {
		expect(isPrivilegeEscalation({ indexPrivileges: ["all"] })).toBe(true);
		expect(isPrivilegeEscalation({ kibanaPrivileges: ["*"] })).toBe(true);
		expect(isPrivilegeEscalation({ indexPrivileges: ["superuser"] })).toBe(true);
	});
	test("plain index/kibana reads are NOT escalation", () => {
		expect(isPrivilegeEscalation({ indexPrivileges: ["read"], kibanaPrivileges: ["feature_discover.read"] })).toBe(
			false,
		);
	});
});

describe("addRolePrivileges", () => {
	test("ADDS an index privilege without touching role_mappings or api_keys", () => {
		const { content, addedIndex, changed } = addRolePrivileges(SECURITY, "developer", {
			index: { names: ["logs-*"], privileges: ["read"] },
		});
		const parsed = JSON.parse(content) as {
			roles: { developer: { indices: Array<{ names: string[]; privileges: string[] }> } };
			role_mappings: unknown;
			api_keys: unknown;
		};
		expect(parsed.roles.developer.indices).toEqual([{ names: ["logs-*"], privileges: ["read"] }]);
		expect(addedIndex).toEqual(["read"]);
		expect(changed).toBe(true);
		// THE NON-NEGOTIABLE: secrets + mappings byte-for-byte intact
		expect(parsed.role_mappings).toEqual(JSON.parse(SECURITY).role_mappings);
		expect(parsed.api_keys).toEqual(JSON.parse(SECURITY).api_keys);
	});

	test("unions a Kibana privilege onto the existing application entry (no dup)", () => {
		const { content, addedKibana } = addRolePrivileges(SECURITY, "developer", {
			kibana: { application: "kibana-.kibana", privileges: ["feature_discover.read", "feature_dashboard.read"] },
		});
		const parsed = JSON.parse(content) as {
			roles: { developer: { applications: Array<{ privileges: string[] }> } };
		};
		// existing feature_discover.read kept; only feature_dashboard.read added
		expect(parsed.roles.developer.applications[0]?.privileges).toEqual([
			"feature_discover.read",
			"feature_dashboard.read",
		]);
		expect(addedKibana).toEqual(["feature_dashboard.read"]);
	});

	test("unions cluster privileges", () => {
		const { content, addedCluster } = addRolePrivileges(SECURITY, "developer", { cluster: ["monitor"] });
		const parsed = JSON.parse(content) as { roles: { developer: { cluster: string[] } } };
		expect(parsed.roles.developer.cluster).toEqual(["monitor"]);
		expect(addedCluster).toEqual(["monitor"]);
	});

	test("changed=false when the privilege already exists (additive no-op)", () => {
		const { changed } = addRolePrivileges(SECURITY, "developer", {
			kibana: { application: "kibana-.kibana", privileges: ["feature_discover.read"] },
		});
		expect(changed).toBe(false);
	});

	test("throws on an unknown role", () => {
		expect(() => addRolePrivileges(SECURITY, "ghost", { cluster: ["monitor"] })).toThrow("unknown role 'ghost'");
	});

	test("preserves 2-space indent + trailing newline", () => {
		const { content } = addRolePrivileges(SECURITY, "developer", { cluster: ["monitor"] });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "roles": {');
	});
});

describe("parseIntentJson — space-edit + security-edit", () => {
	test("space-edit extracts spaceName + fields", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "space-edit",
				cluster: "eu-b2b",
				spaceName: "developer-experience",
				spaceColor: "#000",
			}),
		);
		expect(req.workflow).toBe("space-edit");
		expect(req.spaceName).toBe("developer-experience");
		expect(req.spaceColor).toBe("#000");
	});
	test("security-edit extracts roleName + grants (arrays)", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "security-edit",
				cluster: "eu-b2b",
				roleName: "developer",
				grantIndexNames: ["logs-*"],
				grantIndexPrivileges: ["read"],
			}),
		);
		expect(req.workflow).toBe("security-edit");
		expect(req.roleName).toBe("developer");
		expect(req.grantIndexNames).toEqual(["logs-*"]);
		expect(req.grantIndexPrivileges).toEqual(["read"]);
	});
});

describe("branchSlug — space + security", () => {
	test("space-edit uses cluster + space + workflow", () => {
		const req: IacRequest = { workflow: "space-edit", isProd: false, cluster: "eu-b2b", spaceName: "apps" };
		expect(branchSlug(req)).toBe("eu-b2b-apps-space-edit");
	});
	test("security-edit uses cluster + role + workflow", () => {
		const req: IacRequest = { workflow: "security-edit", isProd: false, cluster: "eu-b2b", roleName: "developer" };
		expect(branchSlug(req)).toBe("eu-b2b-developer-security-edit");
	});
});

function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("draftChange -> proposeSpaceChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(SPACE).toString("base64"), encoding: "base64" })}`;

	test("happy path: edits description, commits", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "space-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				spaceName: "developer-experience",
				spaceDescription: "new",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/spaces/developer-experience.json");
	});

	test("blocks (no create) on 404 with the aggregate-form hint", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: {
				workflow: "space-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				spaceName: "nope",
				spaceColor: "#111",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("not found");
	});
});

describe("draftChange -> proposeSecurityRoleChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(SECURITY).toString("base64"), encoding: "base64" })}`;

	test("happy path: grants index read, commits; diff never echoes api_keys", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "security-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				roleName: "developer",
				grantIndexNames: ["logs-*"],
				grantIndexPrivileges: ["read"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.privilegeEscalation).toBe(false);
		// the diff lists added privileges, NOT any secret VALUE (the header may say "api_keys
		// untouched" as reassurance, but no key id/value may ever appear)
		expect(result.proposedDiff).toContain("logs-*");
		expect(result.proposedDiff).not.toContain("shhh"); // the encoded secret
		expect(result.proposedDiff).not.toContain("do-not-touch"); // the key id
		expect(result.proposedDiff).not.toContain("SECRET_KEY"); // the key name
		// committed body kept api_keys + role_mappings intact
		const written = JSON.parse(String(committed.content)) as { api_keys: unknown; role_mappings: unknown };
		expect(written.api_keys).toEqual(JSON.parse(SECURITY).api_keys);
		expect(written.role_mappings).toEqual(JSON.parse(SECURITY).role_mappings);
	});

	test("flags privilegeEscalation on a cluster grant", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "security-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				roleName: "developer",
				grantCluster: ["manage_security"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.privilegeEscalation).toBe(true);
	});

	test("clarifies on an unknown role", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "security-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				roleName: "ghost",
				grantCluster: ["monitor"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("ghost");
	});

	test("blocks when no grant given", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "security-edit" as const, isProd: false, cluster: "eu-b2b", roleName: "developer" },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("at least one privilege grant");
	});

	test("no-op when the privilege already exists", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "security-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				roleName: "developer",
				grantKibanaApplication: "kibana-.kibana",
				grantKibanaPrivileges: ["feature_discover.read"],
			},
		};
		const result = await draftChange(asIacState(state));
		// SIO-1020: a no-op surfaces as noopReason (neutral "No change needed"), not blockedReason.
		expect(result.noopReason).toContain("already has the requested privileges");
		expect(String(result.messages?.[0]?.content ?? "")).toContain("REPO file only"); // SIO-1196
		expect(result.blockedReason).toBeFalsy();
	});
});

describe("reviewPlan — space + security", () => {
	test("space: config-edit kind + MEDIUM + descriptor", async () => {
		const state = {
			iacRequest: {
				workflow: "space-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				spaceName: "apps",
				spaceColor: "#111",
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("apps");
	});

	test("security: a privilege grant surfaces a leading HIGH risk; escalation says 'human security review'", async () => {
		const base = {
			iacRequest: { workflow: "security-edit" as const, isProd: false, cluster: "eu-b2b", roleName: "developer" },
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const plain = await reviewPlan(asIacState({ ...base, privilegeEscalation: false }));
		expect(plain.risks?.[0]).toContain("privilege GRANT");
		const esc = await reviewPlan(asIacState({ ...base, privilegeEscalation: true }));
		expect(esc.risks?.[0]).toContain("PRIVILEGE ESCALATION");
		expect(esc.risks?.[0]).toContain("HUMAN SECURITY REVIEW");
	});
});
