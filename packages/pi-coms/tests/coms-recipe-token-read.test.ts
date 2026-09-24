// tests/coms-recipe-token-read.test.ts
//
// SIO-1882: `just coms <hub> <cname>` used to print "no principal ... mint one"
// for ANY failed SSM read, so an expired SSO login looked like a missing
// principal. This runs the recipe's own token-read block (extracted from the
// justfile, not a copy) under bash with a stubbed `aws` for each outcome.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JUSTFILE = readFileSync(join(import.meta.dir, "../justfile"), "utf-8");
const start = JUSTFILE.indexOf('    SSM_ERR="$(mktemp)"');
const end = JUSTFILE.indexOf('    echo "coms-net: $SEL hub');
const BLOCK = `${JUSTFILE.slice(start, end).replace(/^ {4}/gm, "")}echo "TOKEN=$TOKEN"\n`;

const dir = mkdtempSync(join(tmpdir(), "coms-token-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(awsStub: string) {
	const bin = mkdtempSync(join(dir, "bin-"));
	writeFileSync(join(bin, "aws"), `#!/bin/sh\n${awsStub}\n`);
	chmodSync(join(bin, "aws"), 0o755);
	const proc = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", BLOCK], {
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			PROFILE: "acct-prd",
			REGION: "eu-central-1",
			CNAME: "simon",
			ENV_KEY: "acct-prd",
		},
	});
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("coms recipe operator-token read", () => {
	test("block was found in the justfile", () => {
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
	});

	test("valid token passes through", () => {
		const r = run(`echo '{"token":"abc123"}'`);
		expect(r.code).toBe(0);
		expect(r.out).toContain("TOKEN=abc123");
	});

	test("expired SSO reports the AWS error and the login hint, not token-create", () => {
		const r = run(`echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2; exit 255`);
		expect(r.code).toBe(1);
		expect(r.err).toContain("Token has expired");
		expect(r.err).toContain("aws sso login --profile acct-prd");
		expect(r.err).not.toContain("token-create");
	});

	test("AccessDenied reports the AWS error without the SSO hint", () => {
		const r = run(`echo "An error occurred (AccessDeniedException)" >&2; exit 254`);
		expect(r.code).toBe(1);
		expect(r.err).toContain("AccessDeniedException");
		expect(r.err).not.toContain("sso login");
		expect(r.err).not.toContain("token-create");
	});

	test("ParameterNotFound is the only case that says no principal", () => {
		const r = run(`echo "An error occurred (ParameterNotFound)" >&2; exit 254`);
		expect(r.code).toBe(1);
		expect(r.err).toContain('no principal "simon"');
	});

	test("malformed or empty-token value is reported as unusable", () => {
		for (const value of ["not-json", '{"token":""}', '{"other":"x"}']) {
			const r = run(`echo '${value}'`);
			expect(r.code).toBe(1);
			expect(r.err).toContain("is not JSON with a non-empty");
			expect(r.err).not.toContain("no principal");
		}
	});
});
