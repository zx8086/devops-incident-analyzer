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
import { readFileSync } from "node:fs";
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
