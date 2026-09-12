// tests/fleet-rollout-token.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { FleetAws } from "../scripts/fleet/aws.ts";
import { main, parseFleetArgs } from "../scripts/fleet.ts";

// SIO-1716: the rollout used to dispatch every SSM command BEFORE requiring the
// hub token, so a missing token reported failure with the fleet already
// updating -- and a re-run double-dispatched to production hosts. These tests
// pin: nothing is dispatched when no token resolves, the token may come from the
// hub's Parameter Store under the CALLER's principal, and the env var still wins.

// The committed example manifest is the schema-valid fixture the other fleet
// tests use: two hubs (dev/prd) with distinct token_env, spokes on both.
const manifestPath = path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml");
const DEV = "PI_COMS_NET_AUTH_TOKEN_DEV";
const PRD = "PI_COMS_NET_AUTH_TOKEN_PRD";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of [DEV, PRD, "PI_COMS_OPERATOR"]) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

type Recorder = { shells: string[]; reads: string[] };

function fakeAws(rec: Recorder, params: Record<string, string> = {}): FleetAws {
	const unused = async () => {
		throw new Error("not used in this test");
	};
	return {
		callerIdentity: async (profile) => ({ account: "111111111111", arn: `arn:aws:sts::x:role/${profile}` }),
		parameterExists: async () => true,
		secureParameter: async (_p, _r, name) => {
			rec.reads.push(name);
			return params[name];
		},
		listParameterNames: async () => [],
		putSecureParameter: async () => {},
		subnetRoutes: unused,
		organizationId: unused,
		inferenceProfileVisible: unused,
		roleTrust: unused,
		bucketExists: unused,
		createStateBucket: unused,
		// A rollout resolves the host first, then runs pi-coms-update on it.
		instanceIdByName: async () => "i-0123456789abcdef0",
		// Records the dispatch, then stops the run: everything after dispatch is
		// the hub tunnel, which shells out to a real `aws ssm start-session`.
		// These tests are about what happens BEFORE anything is sent.
		runShell: async (_p, _r, instanceId) => {
			rec.shells.push(instanceId);
			throw new Error("STOP_AFTER_DISPATCH");
		},
	};
}

const rollout = (rec: Recorder, params: Record<string, string> = {}, extra: string[] = []) =>
	main(["rollout", "eu-oit-dev", "--manifest", manifestPath, ...extra], fakeAws(rec, params));

const principal = (token: string) => JSON.stringify({ token, kind: "operator", names: ["op", "ops"] });

describe("fleet rollout token resolution (SIO-1716)", () => {
	test("no token and no principal named: NOTHING is dispatched", async () => {
		const rec: Recorder = { shells: [], reads: [] };
		await expect(rollout(rec)).rejects.toThrow(new RegExp(`${DEV} is not set`));
		// The whole point of the ticket: zero SSM commands sent.
		expect(rec.shells).toEqual([]);
	});

	test("the failure names both sources and how to supply one", async () => {
		const rec: Recorder = { shells: [], reads: [] };
		await expect(rollout(rec)).rejects.toThrow(/--operator|PI_COMS_OPERATOR/);
		expect(rec.shells).toEqual([]);
	});

	test("an operator whose principal is missing on the hub dispatches nothing", async () => {
		const rec: Recorder = { shells: [], reads: [] };
		await expect(rollout(rec, {}, ["--operator", "op"])).rejects.toThrow(/Mint one: just token-create op/);
		expect(rec.reads).toEqual(["/pi-coms/auth/op"]);
		expect(rec.shells).toEqual([]);
	});

	test("--operator resolves the token from the hub's Parameter Store", async () => {
		const rec: Recorder = { shells: [], reads: [] };
		// Token resolved, so the rollout got as far as dispatching.
		await expect(rollout(rec, { "/pi-coms/auth/op": principal("t".repeat(64)) }, ["--operator", "op"])).rejects.toThrow(
			"STOP_AFTER_DISPATCH",
		);
		expect(rec.reads).toEqual(["/pi-coms/auth/op"]);
		expect(rec.shells).toEqual(["i-0123456789abcdef0"]);
	});

	test("PI_COMS_OPERATOR is used when --operator is absent", async () => {
		process.env.PI_COMS_OPERATOR = "envop";
		const rec: Recorder = { shells: [], reads: [] };
		await expect(rollout(rec, { "/pi-coms/auth/envop": principal("t".repeat(64)) })).rejects.toThrow(
			"STOP_AFTER_DISPATCH",
		);
		expect(rec.reads).toEqual(["/pi-coms/auth/envop"]);
	});

	test("the env var wins and SSM is never read", async () => {
		process.env[DEV] = "from-env";
		const rec: Recorder = { shells: [], reads: [] };
		await expect(rollout(rec, {}, ["--operator", "op"])).rejects.toThrow("STOP_AFTER_DISPATCH");
		expect(rec.reads).toEqual([]);
		expect(rec.shells).toEqual(["i-0123456789abcdef0"]);
	});

	test("a principal record carrying no token is refused, not treated as valid", async () => {
		const rec: Recorder = { shells: [], reads: [] };
		await expect(
			rollout(rec, { "/pi-coms/auth/op": JSON.stringify({ kind: "operator", names: [] }) }, ["--operator", "op"]),
		).rejects.toThrow(/missing or carries no token/);
		expect(rec.shells).toEqual([]);
	});

	test("the token value never appears in the error", async () => {
		const rec: Recorder = { shells: [], reads: [] };
		const secret = "s".repeat(64);
		// Malformed JSON so resolution fails AFTER the value was read.
		const err = await rollout(rec, { "/pi-coms/auth/op": `{"token":"${secret}"` }, ["--operator", "op"]).then(
			() => undefined,
			(e: unknown) => String(e),
		);
		expect(err).toBeDefined();
		expect(err).not.toContain(secret);
	});

	test("multi-hub: one missing token dispatches to NEITHER hub", async () => {
		process.env[DEV] = "from-env"; // dev hub resolvable, prd hub is not
		const rec: Recorder = { shells: [], reads: [] };
		await expect(
			main(["rollout", "eu-oit-dev", "eu-oit-prd", "--manifest", manifestPath], fakeAws(rec)),
		).rejects.toThrow(new RegExp(`${PRD} is not set`));
		// Before SIO-1716 the dev spoke would already have been updated.
		expect(rec.shells).toEqual([]);
	});
});

describe("parseFleetArgs --operator (SIO-1716)", () => {
	test("flag beats PI_COMS_OPERATOR", () => {
		process.env.PI_COMS_OPERATOR = "envop";
		expect(parseFleetArgs(["rollout", "--operator", "flagop"]).operator).toBe("flagop");
	});

	test("PI_COMS_OPERATOR is the fallback, and absent means undefined", () => {
		process.env.PI_COMS_OPERATOR = "envop";
		expect(parseFleetArgs(["rollout"]).operator).toBe("envop");
		delete process.env.PI_COMS_OPERATOR;
		expect(parseFleetArgs(["rollout"]).operator).toBeUndefined();
	});
});
