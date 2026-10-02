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

// SIO-1916: the console's extension set is fixed by the recipe (--no-extensions),
// and from Pi 0.99.0 that flag also disables the built-ins. Pin the three that
// make up MCP support (one per way a tool can reach the model: direct, deferred,
// codemode), and that the adapter Pi's built-in support replaced is not loaded:
// an extension that registers /mcp takes the built-in's place.
describe("coms recipe extension set", () => {
	const flagsStart = JUSTFILE.indexOf("    PI_RESOURCE_FLAGS=(");
	const flagsEnd = JUSTFILE.indexOf("\n    )", flagsStart);
	const flags = JUSTFILE.slice(flagsStart, flagsEnd)
		.split("\n")
		.map((l) => l.trim());

	test("block was found in the justfile", () => {
		expect(flagsStart).toBeGreaterThan(0);
		expect(flagsEnd).toBeGreaterThan(flagsStart);
		expect(flags).toContain("--no-extensions");
	});

	test("names all three MCP built-ins back in, so no exposure is unreachable", () => {
		expect(flags).toContain("-e builtin:mcp");
		expect(flags).toContain("-e builtin:tool-search");
		expect(flags).toContain("-e builtin:codemode");
	});

	test("does not load pi-mcp-adapter", () => {
		expect(flags.some((l) => l.includes("pi-mcp-adapter"))).toBe(false);
	});
});

// SIO-1916: the recipe's own version check, run under bash with a stubbed `pi`.
describe("coms recipe Pi version check", () => {
	const vStart = JUSTFILE.indexOf('    PI_VERSION="$(pi --version');
	const vEnd = JUSTFILE.indexOf("    fi\n", vStart) + "    fi\n".length;
	const block = `${JUSTFILE.slice(vStart, vEnd).replace(/^ {4}/gm, "")}echo OK\n`;

	function runWithPi(stub: string | null) {
		const bin = mkdtempSync(join(dir, "pi-"));
		if (stub !== null) {
			writeFileSync(join(bin, "pi"), `#!/bin/sh\n${stub}\n`);
			chmodSync(join(bin, "pi"), 0o755);
		}
		const proc = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", block], {
			env: { PATH: `${bin}:/usr/bin:/bin` },
		});
		return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
	}

	test("block was found in the justfile", () => {
		expect(vStart).toBeGreaterThan(0);
		expect(block).toContain("sort -V");
	});

	test.each(["0.99.0", "0.99.2", "0.100.0", "1.2.0"])("Pi %s is accepted", (v) => {
		const r = runWithPi(`echo ${v}`);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("OK");
	});

	test.each(["0.87.1", "0.98.9"])("Pi %s is refused with the upgrade command", (v) => {
		const r = runWithPi(`echo ${v}`);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`found: ${v}`);
		expect(r.err).toContain("npm install -g @earendil-works/pi-coding-agent");
	});

	test("no pi on PATH, or one that prints nothing, is refused rather than passed", () => {
		for (const stub of [null, "exit 1", "true"]) {
			const r = runWithPi(stub);
			expect(r.code).toBe(1);
			expect(r.err).toContain("found: none");
		}
	});
});
