// tests/agent-bootstrap-project-scope.test.ts
//
// Every hub read in agent-bootstrap.sh must be scoped to the agent's own
// coms-net project. GET /v1/agents defaults to the "default" project, so an
// unfiltered read looks in an empty namespace once coms_project is anything
// else -- and the three call sites fail in three different, silent ways:
//
//   - the readiness poll never sees the agent it just started, so systemd marks
//     pi-agent failed 60s after a registration that actually succeeded;
//   - the "already registered?" short-circuit never matches, so bootstrap
//     relaunches an agent that is already running;
//   - the drain-old-registration wait breaks on its first iteration and reports
//     the old name cleared while it may still hold the name.
//
// Observed 2026-09-07 on eu-oit-dev and eu-shared-services-dev after moving both
// to project pi-coms-dev: the hub listed both agents online while systemd
// reported the unit failed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = readFileSync(join(import.meta.dir, "../deploy/bootstrap/agent-bootstrap.sh"), "utf-8");

// Reads of the agent registry. Excludes /v1/agents/register and the
// /v1/agents/<session>/heartbeat writes, which are POSTs carrying their own body.
const REGISTRY_READS = /\/v1\/agents(\?[^"']*)?"/g;

describe("agent-bootstrap.sh project scoping", () => {
	test("every /v1/agents read carries the project placeholder", () => {
		const reads = [...SCRIPT.matchAll(REGISTRY_READS)].map((m) => m[0]);
		expect(reads.length).toBeGreaterThan(0);
		const unscoped = reads.filter((r) => !r.includes("project=COMS_PROJECT_PLACEHOLDER"));
		expect(unscoped).toEqual([]);
	});

	test("all three known call sites are present and scoped", () => {
		// Readiness poll, already-registered short-circuit, drain-old wait.
		const scoped = SCRIPT.match(/\/v1\/agents\?project=COMS_PROJECT_PLACEHOLDER/g) ?? [];
		expect(scoped.length).toBe(3);
	});

	// The monitor is a SEPARATE process that registers itself, reading the project
	// from .coms-env (coms-net-monitor.ts falls back to "default" when unset). With
	// it missing, the monitor landed in a different namespace from its own agent:
	// `fleet status` reported "monitor-<name> not registered" and every
	// monitor->agent send failed 404 target_not_found (observed 2026-09-07).
	test(".coms-env exports the project so the monitor shares its agent's namespace", () => {
		expect(SCRIPT).toContain("export PI_COMS_NET_PROJECT='$COMS_PROJECT'");
	});

	test("the placeholder the reads use is the one the substitution fills", () => {
		// A global sed replaces COMS_PROJECT_PLACEHOLDER with $COMS_PROJECT; if the
		// placeholder is ever renamed, the URLs must move with it.
		expect(SCRIPT).toContain("s|COMS_PROJECT_PLACEHOLDER|$COMS_PROJECT|g");
		expect(SCRIPT).toContain('--project "COMS_PROJECT_PLACEHOLDER"');
	});
});

// SIO-1788 / SIO-1793: the launcher writes mcp.json as a hand-escaped JSON string
// inside a printf, behind the CTX_MODE_ENABLED kill-switch and a check that the
// server bundle exists. A quoting slip yields a file Pi cannot parse; a
// wrong CTX_SERVER path makes the `-f` test fail and the else branch delete the
// file; either way the spoke silently starts with no ctx_* tools. So run the
// whole block (CTX_SERVER= through fi, exactly as the launcher carries it: the
// heredoc is quoted, so $HOME expands at run time) through bash in a temp HOME
// and inspect the file it leaves behind, rather than matching source text or
// injecting the path under test.
describe("agent-bootstrap.sh mcp.json entry", () => {
	const lines = SCRIPT.split("\n");
	const start = lines.findIndex((l) => l.startsWith('CTX_SERVER="$HOME/'));
	const end = lines.findIndex((l, i) => i > start && l === "fi");
	const block = lines.slice(start, end + 1).join("\n");
	const SERVER_REL = ".pi-ctx/node_modules/context-mode/server.bundle.mjs";

	function runLauncherBlock(opts: { ctxModeEnabled?: string; serverPresent: boolean; existingMcpJson?: string }) {
		const home = mkdtempSync(join(tmpdir(), "sio-1793-home-"));
		mkdirSync(join(home, ".pi/agent"), { recursive: true });
		if (opts.serverPresent) {
			mkdirSync(join(home, ".pi-ctx/node_modules/context-mode"), { recursive: true });
			writeFileSync(join(home, SERVER_REL), "// stand-in bundle\n");
		}
		if (opts.existingMcpJson !== undefined) writeFileSync(join(home, ".pi/agent/mcp.json"), opts.existingMcpJson);
		const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? "" };
		if (opts.ctxModeEnabled !== undefined) env.CTX_MODE_ENABLED = opts.ctxModeEnabled;
		const out = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", block], { env });
		const path = join(home, ".pi/agent/mcp.json");
		const mcpJson = existsSync(path) ? readFileSync(path, "utf-8") : null;
		rmSync(home, { recursive: true, force: true });
		return { exitCode: out.exitCode, stderr: out.stderr.toString(), mcpJson, home };
	}

	test("the block was found and is the launcher's, not some other CTX_SERVER line", () => {
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		expect(block).toContain('> "$HOME/.pi/agent/mcp.json"');
		expect(block).toContain('rm -f "$HOME/.pi/agent/mcp.json"');
	});

	test("enabled with the bundle present: writes valid JSON pointing at the script's own path, hiding the four maintenance tools", () => {
		const r = runLauncherBlock({ serverPresent: true });
		expect(r.exitCode).toBe(0);
		expect(r.mcpJson).not.toBeNull();
		const ctx = JSON.parse(r.mcpJson ?? "").mcpServers.ctx;
		// The path is asserted from the SCRIPT's CTX_SERVER= line, not one the test supplied.
		expect(ctx.args).toEqual([join(r.home, SERVER_REL)]);
		expect(ctx.command).toBe(join(r.home, ".bun/bin/bun"));
		// SIO-1915: Pi's built-in MCP shape. `direct` declares the tools to the model;
		// the default (`codemode`) would leave a spoke with no visible ctx tools.
		expect(ctx.exposure).toBe("direct");
		expect(ctx.toolExposure).toEqual({
			ctx_upgrade: "hidden",
			ctx_purge: "hidden",
			ctx_doctor: "hidden",
			ctx_insight: "hidden",
		});
		// The names the aws-spoke RULES.md tells the model to use must stay reachable.
		for (const kept of ["ctx_batch_execute", "ctx_execute", "ctx_search"])
			expect(ctx.toolExposure).not.toHaveProperty(kept);
		// pi-mcp-adapter keys mean nothing to the built-in support; a leftover one
		// would be a sign the entry was only half converted.
		for (const gone of ["lifecycle", "directTools", "toolPrefix", "excludeTools"]) expect(ctx).not.toHaveProperty(gone);
	});

	test.each(["false", "0"])(
		"CTX_MODE_ENABLED=%s removes a pre-existing mcp.json even though the bundle is present",
		(v) => {
			const r = runLauncherBlock({
				ctxModeEnabled: v,
				serverPresent: true,
				existingMcpJson: '{"mcpServers":{"ctx":{}}}',
			});
			expect(r.exitCode).toBe(0);
			expect(r.mcpJson).toBeNull();
		},
	);

	test("enabled but the bundle is missing: removes a pre-existing mcp.json rather than pointing Pi at a file that is not there", () => {
		const r = runLauncherBlock({ serverPresent: false, existingMcpJson: '{"mcpServers":{"ctx":{}}}' });
		expect(r.exitCode).toBe(0);
		expect(r.mcpJson).toBeNull();
	});

	test("an unrelated CTX_MODE_ENABLED value counts as enabled (kill-switch is false/0 only)", () => {
		const r = runLauncherBlock({ ctxModeEnabled: "no", serverPresent: true });
		expect(r.exitCode).toBe(0);
		expect(r.mcpJson).not.toBeNull();
	});
});

// SIO-1915: an installed pi-mcp-adapter REPLACES Pi's built-in MCP support (it
// registers /mcp) and from 3.0.0 no longer reads mcp.json, so a host upgraded in
// place would lose its ctx tools unless the bootstrap takes the adapter out.
describe("agent-bootstrap.sh removes pi-mcp-adapter", () => {
	const lines = SCRIPT.split("\n");
	const marker = lines.findIndex((l) => l.startsWith("# pi-mcp-adapter (SIO-1734) served this"));
	const start = lines.findIndex((l, i) => i > marker && l === "python3 - <<'PY'");
	const end = lines.findIndex(
		(l, i) => i > start && l.startsWith('rm -rf "$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter"'),
	);
	const block = lines.slice(start, end + 1).join("\n");

	function run(settings: string | undefined) {
		const home = mkdtempSync(join(tmpdir(), "sio-1915-home-"));
		const adapter = join(home, ".pi/agent/npm/node_modules/pi-mcp-adapter");
		mkdirSync(adapter, { recursive: true });
		writeFileSync(join(adapter, "index.ts"), "// stand-in\n");
		const settingsPath = join(home, ".pi/agent/settings.json");
		if (settings !== undefined) writeFileSync(settingsPath, settings);
		const out = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", block], {
			env: { HOME: home, PATH: process.env.PATH ?? "" },
		});
		const after = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : null;
		const adapterLeft = existsSync(adapter);
		rmSync(home, { recursive: true, force: true });
		return { exitCode: out.exitCode, stderr: out.stderr.toString(), after, adapterLeft };
	}

	test("the block was found", () => {
		expect(marker).toBeGreaterThan(0);
		expect(start).toBeGreaterThan(marker);
		expect(end).toBeGreaterThan(start);
	});

	test("drops the adapter from settings.json packages, keeps everything else, and deletes the install", () => {
		const r = run(JSON.stringify({ theme: "dark", packages: ["npm:pi-mcp-adapter", "npm:other"] }));
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
		expect(r.after).toEqual({ theme: "dark", packages: ["npm:other"] });
		expect(r.adapterLeft).toBe(false);
	});

	test("a host with no settings.json, or none naming the adapter, is left alone", () => {
		expect(run(undefined)).toMatchObject({ exitCode: 0, after: null, adapterLeft: false });
		const r = run(JSON.stringify({ packages: ["npm:other"] }));
		expect(r.exitCode).toBe(0);
		expect(r.after).toEqual({ packages: ["npm:other"] });
	});
});
