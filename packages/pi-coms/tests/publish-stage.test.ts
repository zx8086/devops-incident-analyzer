// packages/pi-coms/tests/publish-stage.test.ts
// SIO-1654: the bundle is staged from the packages/pi-coms subtree, not the
// monorepo root, with a standalone lockfile so hosts can run the frozen install.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "deploy", "publish-fleet.sh");

describe("publish-fleet.sh --stage-only", () => {
	test("stages the subtree with lockfiles, monitor deps and the version stamp", async () => {
		const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coms-stage-"));
		const proc = Bun.spawn(["bash", SCRIPT, "--stage-only"], {
			env: { ...process.env, PI_COMS_STAGE_DIR: stage },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		// bun install reports progress on stderr; only a non-zero exit is a failure.
		expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
		expect(out.trim()).toBe(stage);
		for (const f of [
			"extensions/coms-net.ts",
			"scripts/coms-net-server.ts",
			"deploy/AGENTS-spoke.md",
			"bun.lock",
			"scripts/bun.lock",
			".bundle-version",
		]) {
			expect({ f, exists: fs.existsSync(path.join(stage, f)) }).toEqual({ f, exists: true });
		}
		expect(fs.existsSync(path.join(stage, "scripts", "node_modules", "@aws-sdk"))).toBe(true);
		expect(fs.existsSync(path.join(stage, "packages"))).toBe(false);
		expect(fs.readFileSync(path.join(stage, ".bundle-version"), "utf8").trim()).toMatch(/^[0-9a-f]{7,}$/);
		fs.rmSync(stage, { recursive: true, force: true });
	}, 180_000);
});
