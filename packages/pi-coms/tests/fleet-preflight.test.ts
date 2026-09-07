// tests/fleet-preflight.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { FleetAws } from "../scripts/fleet/aws.ts";
import { missingOnHub } from "../scripts/fleet/hub.ts";
import { parseManifest } from "../scripts/fleet/manifest.ts";
import { formatPreflight, preflight, preflightPassed } from "../scripts/fleet/preflight.ts";
import { rolloutCommands } from "../scripts/fleet/rollout.ts";

const manifest = parseManifest(readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8"));

type Overrides = Partial<{ [K in keyof FleetAws]: FleetAws[K] }>;

// A healthy fake: every profile resolves, every principal exists, routes go
// through a TGW, one organization, Bedrock visible, adopt roles trust the analyzer.
function fakeAws(overrides: Overrides = {}): FleetAws {
	const base: FleetAws = {
		callerIdentity: async (profile) => ({
			account: profile.includes("prd") ? "222222222222" : "111111111111",
			arn: `arn:aws:sts::x:assumed-role/${profile}`,
		}),
		parameterExists: async () => true,
		listParameterNames: async () => [],
		putSecureParameter: async () => {},
		subnetRoutes: async (_p, _r, subnetId) => ({
			vpcId: "vpc-1",
			cidr: subnetId.includes("oit")
				? subnetId.includes("prd")
					? "10.10.2.0/23"
					: "10.0.2.0/23"
				: subnetId.includes("prd")
					? "10.10.0.0/23"
					: "10.0.0.0/23",
			transitGatewayRoute: true,
		}),
		organizationId: async () => "o-example",
		inferenceProfileVisible: async () => true,
		roleTrust: async (profile) =>
			profile.includes("prd")
				? {
						arn: `arn:aws:iam::222222222222:role/DevOpsAgentReadOnly`,
						statements: [{ sid: "AnalyzerTrust", principals: ["arn:aws:iam::333333333333:role/DevOpsAgentCoreRole"] }],
						tags: {},
					}
				: undefined,
		bucketExists: async () => true,
		createStateBucket: async () => {},
		instanceIdByName: async () => "i-0123",
		runShell: async () => "cmd-1",
	};
	return { ...base, ...overrides };
}

describe("fleet preflight decision table (SIO-1653)", () => {
	test("a healthy fleet passes every check and the table names each one", async () => {
		const rows = await preflight(manifest, ["eu-oit-dev", "eu-oit-prd"], fakeAws());
		expect(preflightPassed(rows)).toBe(true);
		expect(rows.filter((r) => r.spoke === "eu-oit-prd").map((r) => r.check)).toEqual([
			"credentials",
			"hub principal",
			"tgw route",
			"hub allow-list",
			"organization",
			"bedrock model",
			"adopt role",
		]);
		expect(rows.filter((r) => r.spoke === "eu-oit-dev").map((r) => r.check)).toContain("create role");
		expect(formatPreflight(rows)).toContain("ok   eu-oit-prd");
	});

	test("an expired profile stops that spoke after the credentials row and touches nothing else", async () => {
		const calls: string[] = [];
		const aws = fakeAws({
			callerIdentity: async (profile) => {
				if (profile === "eu-oit-prd")
					throw new Error("ExpiredToken: The security token included in the request is expired");
				return { account: "111111111111", arn: "x" };
			},
			parameterExists: async (profile) => {
				calls.push(profile);
				return true;
			},
		});
		const rows = await preflight(manifest, ["eu-oit-prd", "eu-oit-dev"], aws);
		const prd = rows.filter((r) => r.spoke === "eu-oit-prd");
		expect(prd).toHaveLength(1);
		expect(prd[0]).toMatchObject({ check: "credentials", ok: false });
		expect(prd[0]?.detail).toContain("expired or invalid credentials");
		expect(calls).not.toContain("eu-oit-prd");
		expect(preflightPassed(rows)).toBe(false);
	});

	test("a wrong account behind a profile is refused", async () => {
		const text = readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8").replace(
			"profile: eu-oit-dev\n    subnet_id",
			'profile: eu-oit-dev\n    account_id: "999999999999"\n    subnet_id',
		);
		const rows = await preflight(parseManifest(text), ["eu-oit-dev"], fakeAws());
		expect(rows[0]).toMatchObject({ check: "credentials", ok: false });
		expect(rows[0]?.detail).toContain("manifest says 999999999999");
	});

	test("a missing TGW route, a foreign CIDR and a missing principal each fail their own row", async () => {
		const aws = fakeAws({
			parameterExists: async () => false,
			subnetRoutes: async () => ({ vpcId: "vpc-1", cidr: "10.99.5.0/24", transitGatewayRoute: false }),
		});
		const rows = await preflight(manifest, ["eu-oit-dev"], aws);
		const byCheck = Object.fromEntries(rows.map((r) => [r.check, r]));
		expect(byCheck["hub principal"]).toMatchObject({ ok: false });
		expect(byCheck["hub principal"]?.detail).toContain("fleet tokens ensure eu-oit-dev");
		expect(byCheck["tgw route"]).toMatchObject({ ok: false });
		expect(byCheck["hub allow-list"]).toMatchObject({ ok: false });
		expect(byCheck["manifest cidr"]).toMatchObject({ ok: false });
	});

	// The dev accounts were deployed before the fleet CLI existed: their
	// DevOpsAgentReadOnly trusts the LOCAL pi-agent instance role with the
	// devops-agent-dev-access ExternalId and carries no analyzer statement.
	// That is the role this fleet adopts, so refusing it was a false negative
	// (observed against 352896877281 and 120999474587, 2026-09-07).
	test("adopt mode accepts a role trusted by this account's own pi-agent-agent", async () => {
		const aws = fakeAws({
			roleTrust: async () => ({
				arn: "arn:aws:iam::120999474587:role/DevOpsAgentReadOnly",
				statements: [{ sid: "TrustLocalPiAgent", principals: ["arn:aws:iam::120999474587:role/pi-agent-agent"] }],
				tags: {},
			}),
		});
		const rows = await preflight(manifest, ["eu-oit-prd"], aws);
		expect(rows.find((r) => r.check === "adopt role")).toMatchObject({ ok: true });
	});

	// The widening must stay narrow: anything that is neither the analyzer nor
	// pi-agent-agent still fails, on dev and prd alike. This is the check that
	// stops `adopt` clobbering a same-named role belonging to something else.
	test("adopt mode still refuses an unrecognised principal", async () => {
		for (const principal of [
			"arn:aws:iam::1:role/SomeOtherTeamRole",
			"arn:aws:iam::1:role/pi-agent",
			"arn:aws:iam::1:user/a-human",
		]) {
			const aws = fakeAws({
				roleTrust: async () => ({
					arn: "arn:aws:iam::1:role/DevOpsAgentReadOnly",
					statements: [{ sid: "Other", principals: [principal] }],
					tags: {},
				}),
			});
			const rows = await preflight(manifest, ["eu-oit-prd"], aws);
			expect(rows.find((r) => r.check === "adopt role")).toMatchObject({ ok: false });
		}
	});

	// "create" asks whether THIS fleet may keep managing the role, not whether the
	// role is absent. A fleet pi-coms deployed itself has the role present AND in
	// terraform state; requiring absence blocked that steady state entirely, while
	// `adopt` would have stopped managing the vendored policies and destroyed 207
	// read actions. The module stamps ManagedBy=terraform + Project=pi-coms-net on
	// what it creates, so those tags answer ownership.
	test("create mode accepts a role this fleet already manages", async () => {
		const aws = fakeAws({
			roleTrust: async () => ({
				arn: "arn:aws:iam::120999474587:role/DevOpsAgentReadOnly",
				statements: [{ sid: "TrustLocalPiAgent", principals: ["arn:aws:iam::120999474587:role/pi-agent-agent"] }],
				tags: { ManagedBy: "terraform", Project: "pi-coms-net", Stack: "oit-dev" },
			}),
		});
		const rows = await preflight(manifest, ["eu-oit-dev"], aws);
		expect(rows.find((r) => r.check === "create role")).toMatchObject({ ok: true });
	});

	test("create mode still refuses a same-named role this fleet does not own", async () => {
		// Both tags must match: a role tagged by some other terraform stack, or
		// carrying only one of the two, is somebody else's and needs `adopt`.
		const cases: Array<Record<string, string>> = [
			{},
			{ ManagedBy: "terraform" },
			{ Project: "pi-coms-net" },
			{ ManagedBy: "terraform", Project: "some-other-stack" },
			{ ManagedBy: "cloudformation", Project: "pi-coms-net" },
		];
		for (const tags of cases) {
			const aws = fakeAws({
				roleTrust: async () => ({
					arn: "arn:aws:iam::1:role/DevOpsAgentReadOnly",
					statements: [{ sid: "Other", principals: ["arn:aws:iam::1:role/something"] }],
					tags,
				}),
			});
			const rows = await preflight(manifest, ["eu-oit-dev"], aws);
			expect(rows.find((r) => r.check === "create role")).toMatchObject({ ok: false });
		}
	});

	test("adopt mode refuses a role without the analyzer's trust statement, create mode refuses an existing role", async () => {
		const aws = fakeAws({
			roleTrust: async () => ({
				arn: "arn:aws:iam::1:role/DevOpsAgentReadOnly",
				statements: [{ sid: "Other", principals: ["arn:aws:iam::1:role/something"] }],
				tags: {},
			}),
		});
		const rows = await preflight(manifest, ["eu-oit-prd", "eu-oit-dev"], aws);
		expect(rows.find((r) => r.spoke === "eu-oit-prd" && r.check === "adopt role")).toMatchObject({ ok: false });
		expect(rows.find((r) => r.spoke === "eu-oit-dev" && r.check === "create role")).toMatchObject({ ok: false });
	});

	test("a different organization fails; an unreadable org is skipped", async () => {
		const differ = await preflight(
			manifest,
			["eu-oit-dev"],
			fakeAws({ organizationId: async (profile) => (profile === "eu-oit-dev" ? "o-a" : "o-b") }),
		);
		expect(differ.find((r) => r.check === "organization")).toMatchObject({ ok: false });
		const skipped = await preflight(manifest, ["eu-oit-dev"], fakeAws({ organizationId: async () => undefined }));
		expect(skipped.find((r) => r.check === "organization")).toMatchObject({ ok: true });
	});
});

describe("hub expectations and rollout commands", () => {
	const card = (name: string, status: "online" | "stale" | "offline", purpose = "") => ({
		session_id: "s",
		name,
		purpose,
		model: "none",
		color: "#000",
		cwd: "/",
		project: "default",
		explicit: false,
		started_at: "t",
		context_used_pct: 0,
		queue_depth: 0,
		status,
	});

	test("missingOnHub wants agent and monitor online and the persona in the purpose", () => {
		const agents = [
			card("eu-oit-dev", "online", "Read-only agent persona=pi-fleet-v0.1.0"),
			card("monitor-eu-oit-dev", "online"),
		];
		expect(missingOnHub(agents, "eu-oit-dev", { persona: "0.1.0" })).toEqual([]);
		expect(missingOnHub(agents, "eu-oit-dev", { persona: "0.2.0" })).toEqual([
			"eu-oit-dev purpose lacks persona=pi-fleet-v0.2.0 (Read-only agent persona=pi-fleet-v0.1.0)",
		]);
		expect(missingOnHub([card("eu-oit-dev", "stale")], "eu-oit-dev", {})).toEqual([
			"eu-oit-dev is stale",
			"monitor-eu-oit-dev not registered",
		]);
	});

	test("a normal rollout uses pi-coms-update (it writes the reload sentinel); a token change re-runs the bootstrap with the sentinel touched", () => {
		expect(rolloutCommands({ tokenChanged: false })).toEqual(["/usr/local/bin/pi-coms-update"]);
		expect(rolloutCommands({ tokenChanged: true })[0]).toBe("touch /home/piagent/.pi-agent-reload");
		expect(rolloutCommands({ tokenChanged: true })[2]).toBe("bash /var/lib/cloud/instance/user-data.txt");
	});
});
