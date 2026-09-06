// tests/fleet-tokens.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { FleetAws } from "../scripts/fleet/aws.ts";
import { parseManifest } from "../scripts/fleet/manifest.ts";
import { renderTfvars } from "../scripts/fleet/render.ts";
import { ensureToken, mintToken, principalRecord } from "../scripts/fleet/tokens.ts";

const manifest = parseManifest(readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8"));

function fake(state: { onHub: Set<string>; puts: Array<{ profile: string; name: string; value: string }> }): FleetAws {
	const unused = async () => {
		throw new Error("not used");
	};
	return {
		callerIdentity: unused,
		parameterExists: async (_p, _r, name) => state.onHub.has(name),
		listParameterNames: unused,
		putSecureParameter: async (profile, _r, name, value) => {
			state.puts.push({ profile, name, value });
			state.onHub.add(name);
		},
		subnetRoutes: unused,
		organizationId: unused,
		inferenceProfileVisible: unused,
		roleTrust: unused,
		bucketExists: unused,
		createStateBucket: unused,
		instanceIdByName: unused,
		runShell: unused,
	};
}

describe("fleet tokens (SIO-1653)", () => {
	test("the principal record matches token-admin.sh: token, kind agent, names [name, monitor-name]", () => {
		expect(principalRecord("eu-oit-prd", "t")).toEqual({
			token: "t",
			kind: "agent",
			names: ["eu-oit-prd", "monitor-eu-oit-prd"],
		});
		expect(mintToken()).toMatch(/^[0-9a-f]{64}$/);
		expect(mintToken()).not.toBe(mintToken());
	});

	test("ensure mints in the spoke's OWN hub directory and writes the token into the spoke tfvars only", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fleet-tokens-"));
		try {
			const state = { onHub: new Set<string>(), puts: [] as Array<{ profile: string; name: string; value: string }> };
			const result = await ensureToken(manifest, "eu-oit-prd", fake(state), {
				accountsDir: dir,
				mint: () => "f".repeat(64),
			});
			expect(result.minted).toBe(true);
			expect(result.reason).not.toContain("f".repeat(64));
			expect(state.puts).toHaveLength(1);
			expect(state.puts[0]?.profile).toBe("eu-shared-services-prd");
			expect(state.puts[0]?.name).toBe("/pi-coms/auth/eu-oit-prd");
			expect(JSON.parse(state.puts[0]?.value ?? "{}")).toEqual({
				token: "f".repeat(64),
				kind: "agent",
				names: ["eu-oit-prd", "monitor-eu-oit-prd"],
			});
			const tfvars = readFileSync(path.join(dir, "eu-oit-prd", "terraform.tfvars"), "utf-8");
			expect(tfvars).toContain(`coms_auth_token = "${"f".repeat(64)}"`);
			expect(tfvars).toContain('hub_url         = "http://10.10.0.10:8787"');
			expect(statSync(path.join(dir, "eu-oit-prd", "terraform.tfvars")).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ensure is idempotent once the principal exists and tfvars carries a token; rotate re-mints", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fleet-tokens-"));
		try {
			mkdirSync(path.join(dir, "eu-oit-dev"), { recursive: true });
			writeFileSync(
				path.join(dir, "eu-oit-dev", "terraform.tfvars"),
				renderTfvars(manifest, "eu-oit-dev").replace(
					'coms_auth_token = "<set by: just fleet tokens ensure>"',
					'coms_auth_token = "old"',
				),
			);
			const state = {
				onHub: new Set(["/pi-coms/auth/eu-oit-dev"]),
				puts: [] as Array<{ profile: string; name: string; value: string }>,
			};
			const kept = await ensureToken(manifest, "eu-oit-dev", fake(state), { accountsDir: dir });
			expect(kept.minted).toBe(false);
			expect(state.puts).toHaveLength(0);
			const rotated = await ensureToken(manifest, "eu-oit-dev", fake(state), {
				accountsDir: dir,
				rotate: true,
				mint: () => "a".repeat(64),
			});
			expect(rotated.minted).toBe(true);
			expect(readFileSync(path.join(dir, "eu-oit-dev", "terraform.tfvars"), "utf-8")).toContain(
				`coms_auth_token = "${"a".repeat(64)}"`,
			);
			expect(state.puts[0]?.profile).toBe("eu-shared-services-dev");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
