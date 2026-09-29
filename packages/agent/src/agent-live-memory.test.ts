// agent/src/agent-live-memory.test.ts

// SIO-1888: buildAgentLiveMemorySection reads the NAMED agent's runtime files and
// the per-thread recall stash for the CURRENT request's thread.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "@devops-agent/shared";
import * as realPathsNs from "./paths.ts";

// Point getAgentsDir(name) at a temp agents root so no real agents/ tree is read.
const realPaths = { ...realPathsNs };
let agentsRoot = "";
mock.module("./paths.ts", () => ({
	...realPaths,
	getAgentsDir: (name = "incident-analyzer") => join(agentsRoot, name),
}));

import { buildAgentLiveMemorySection } from "./agent-live-memory.ts";
import { setEvidenceToc } from "./lifecycle.ts";

const prevEnabled = process.env.LIVE_MEMORY_ENABLED;
const prevBackend = process.env.LIVE_MEMORY_BACKEND;

function seedContext(agent: string, text: string): void {
	const dir = join(agentsRoot, agent, "memory", "runtime");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "context.md"), text);
}

beforeEach(() => {
	agentsRoot = mkdtempSync(join(tmpdir(), "agent-live-memory-"));
	process.env.LIVE_MEMORY_ENABLED = "true";
	delete process.env.LIVE_MEMORY_BACKEND;
});

afterEach(() => {
	rmSync(agentsRoot, { recursive: true, force: true });
	setEvidenceToc("t-iac", undefined);
	setEvidenceToc("t-other", undefined);
	if (prevEnabled === undefined) delete process.env.LIVE_MEMORY_ENABLED;
	else process.env.LIVE_MEMORY_ENABLED = prevEnabled;
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
});

describe("buildAgentLiveMemorySection (SIO-1888)", () => {
	test("reads the named agent's context and the current thread's recall stash", () => {
		seedContext("elastic-iac", "# IaC context\niac estate facts");
		seedContext("incident-analyzer", "# Orchestrator context\nNOT for the iac prompt");
		// The recall getter joins the recall and evidence-TOC stashes; the TOC setter is
		// the exported way to seed one for a thread.
		setEvidenceToc("t-iac", "prior turn toc for iac");
		const out = runWithRequestContext({ threadId: "t-iac", runId: "r", requestId: "q" }, () =>
			buildAgentLiveMemorySection("elastic-iac"),
		);
		expect(out).toContain("## Live Memory");
		expect(out).toContain("iac estate facts");
		expect(out).toContain("prior turn toc for iac");
		expect(out).not.toContain("NOT for the iac prompt");
	});

	test("another thread's stash never leaks in", () => {
		seedContext("elastic-iac", "iac estate facts");
		setEvidenceToc("t-other", "someone else's toc");
		const out = runWithRequestContext({ threadId: "t-iac", runId: "r", requestId: "q" }, () =>
			buildAgentLiveMemorySection("elastic-iac"),
		);
		expect(out).toContain("iac estate facts");
		expect(out).not.toContain("someone else's toc");
	});

	test("outside a request context there is no thread, so only the files render", () => {
		seedContext("landing-zone-terraform", "lz facts");
		setEvidenceToc("t-iac", "stash that needs a thread");
		const out = buildAgentLiveMemorySection("landing-zone-terraform");
		expect(out).toContain("lz facts");
		expect(out).not.toContain("stash that needs a thread");
	});

	test("an explicit threadId wins over the request context", () => {
		setEvidenceToc("t-other", "explicit thread toc");
		const out = runWithRequestContext({ threadId: "t-iac", runId: "r", requestId: "q" }, () =>
			buildAgentLiveMemorySection("pi-fleet-console", "t-other"),
		);
		expect(out).toContain("explicit thread toc");
	});

	test("returns an empty string when live memory is off and nothing was recalled", () => {
		process.env.LIVE_MEMORY_ENABLED = "false";
		expect(buildAgentLiveMemorySection("elastic-iac", "t-none")).toBe("");
	});

	test("recall alone still renders when live memory is off (agent-memory backend shape)", () => {
		process.env.LIVE_MEMORY_ENABLED = "false";
		setEvidenceToc("t-iac", "recalled only");
		expect(buildAgentLiveMemorySection("elastic-iac", "t-iac")).toContain(
			"### Recalled From Past Sessions\n\nrecalled only",
		);
	});
});
