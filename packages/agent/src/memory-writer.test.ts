// agent/src/memory-writer.test.ts
//
// SIO-1045: this file OWNS a mock.module("./memory-backend.ts", ...) registered at file scope,
// BEFORE the static import of ./memory-writer.ts below (which statically imports selectedBackend
// from ./memory-backend.ts and branches on it). See fleet-upgrade.test.ts for the full rationale.
// This file already pins LIVE_MEMORY_BACKEND to "file" in every beforeEach (its own long-standing
// defense against env-var pollution from a sibling test), but that only protects against the ENV
// VALUE being wrong -- a sibling file's mock.module("../memory-backend.ts", () => ({ selectedBackend:
// () => "agent-memory", ... })) leaking here replaces the FUNCTION itself, ignoring env entirely and
// silently rerouting these file-path assertions to the write-behind queue. Re-exporting the real
// module verbatim closes that gap without changing this file's existing LIVE_MEMORY_BACKEND pinning.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactPiiContent, verifyHashChain } from "@devops-agent/shared";
import * as realMemoryBackendNs from "./memory-backend.ts";

// SIO-1045: a namespace import (`import * as ns`) is a LIVE VIEW -- when any file registers a
// mock.module() for this path, bun live-patches every existing namespace binding, INCLUDING this
// captured `realMemoryBackendNs` object, so re-claiming with `() => realMemoryBackendNs` would
// re-register the very poison it means to undo (a circular no-op). A value snapshot (spread into a
// plain object at load time, before any mock.module() call below runs) copies the function VALUES and
// is immune to that later live-patching.
const realMemoryBackend = { ...realMemoryBackendNs };

mock.module("./memory-backend.ts", () => realMemoryBackend);

import { appendDailyLog, readLiveMemory, recordKeyDecision } from "./memory-writer.ts";

// SIO-845: aggregator.test.ts mocks @devops-agent/shared with a passthrough
// redactPiiContent, and Bun's mock.module leaks across the run. When that mock
// is active these redaction assertions are not meaningful, so gate them on the
// real function being present. The writer's redaction call is unconditional;
// this only avoids a false failure from cross-file mock pollution.
const REDACTION_ACTIVE = redactPiiContent("123-45-6789") !== "123-45-6789";

let baseDir: string;
const prevEnabled = process.env.LIVE_MEMORY_ENABLED;
const prevImmutable = process.env.LIVE_MEMORY_IMMUTABLE;
const prevBackend = process.env.LIVE_MEMORY_BACKEND;

function runtimeDir(): string {
	return join(baseDir, "memory", "runtime");
}

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "live-memory-test-"));
	mkdirSync(runtimeDir(), { recursive: true });
	writeFileSync(join(runtimeDir(), "context.md"), "# Live Context\nestate stuff");
	writeFileSync(join(runtimeDir(), "key-decisions.md"), "# Key Decisions\n");
	writeFileSync(join(runtimeDir(), "dailylog.md"), "# Daily Log\n");
	process.env.LIVE_MEMORY_ENABLED = "true";
	delete process.env.LIVE_MEMORY_IMMUTABLE;
	// SIO-938: pin the file backend so a sibling test that sets
	// LIVE_MEMORY_BACKEND=agent-memory (process-global env) cannot reroute these
	// file-path assertions to the write-behind queue.
	delete process.env.LIVE_MEMORY_BACKEND;
	// SIO-1045: re-claim ownership before every test in this file, so it is self-claiming even if a
	// sibling suite poisoned the module between this file's load and this test's execution.
	mock.module("./memory-backend.ts", () => realMemoryBackend);
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
	if (prevEnabled === undefined) delete process.env.LIVE_MEMORY_ENABLED;
	else process.env.LIVE_MEMORY_ENABLED = prevEnabled;
	if (prevImmutable === undefined) delete process.env.LIVE_MEMORY_IMMUTABLE;
	else process.env.LIVE_MEMORY_IMMUTABLE = prevImmutable;
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	// SIO-1045: re-claim ownership after every test in this file (see the file-scope comment above).
	mock.module("./memory-backend.ts", () => realMemoryBackend);
});

describe("readLiveMemory", () => {
	test("returns empty object when disabled", () => {
		process.env.LIVE_MEMORY_ENABLED = "false";
		expect(readLiveMemory(baseDir)).toEqual({});
	});

	test("reads the three runtime files when enabled", () => {
		const mem = readLiveMemory(baseDir);
		expect(mem.context).toContain("Live Context");
		expect(mem.keyDecisions).toContain("Key Decisions");
		expect(mem.dailyLog).toContain("Daily Log");
	});
});

describe("appendDailyLog", () => {
	test("is a no-op when disabled", () => {
		process.env.LIVE_MEMORY_ENABLED = "0";
		appendDailyLog({ requestId: "r1", services: ["a"], datasources: ["elastic"] }, baseDir);
		expect(readFileSync(join(runtimeDir(), "dailylog.md"), "utf-8")).toBe("# Daily Log\n");
	});

	test("appends a single line and never truncates prior content", () => {
		appendDailyLog({ requestId: "r1", services: ["svc-a"], datasources: ["elastic"], severity: "high" }, baseDir);
		appendDailyLog({ requestId: "r2", services: ["svc-b"], datasources: ["kafka"] }, baseDir);
		const content = readFileSync(join(runtimeDir(), "dailylog.md"), "utf-8");
		expect(content).toContain("# Daily Log");
		expect(content).toContain("req=r1");
		expect(content).toContain("req=r2");
		expect(content).toContain("services=[svc-a]");
		expect(content).toContain("datasources=[kafka]");
		expect(content).toContain("severity=high");
	});

	test.if(REDACTION_ACTIVE)("redacts PII in the summary field", () => {
		appendDailyLog({ requestId: "r3", services: [], datasources: [], summary: "user ssn 123-45-6789 leaked" }, baseDir);
		const content = readFileSync(join(runtimeDir(), "dailylog.md"), "utf-8");
		expect(content).not.toContain("123-45-6789");
		expect(content).toContain("[SSN_REDACTED]");
	});

	test("immutable mode produces a verifiable hash chain", () => {
		process.env.LIVE_MEMORY_IMMUTABLE = "true";
		writeFileSync(join(runtimeDir(), "dailylog.md"), "");
		appendDailyLog({ requestId: "r1", services: ["a"], datasources: ["elastic"] }, baseDir);
		appendDailyLog({ requestId: "r2", services: ["b"], datasources: ["kafka"] }, baseDir);
		const lines = readFileSync(join(runtimeDir(), "dailylog.md"), "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);
		// Each line independently re-seeds the chain (one entry per call), so each
		// line is a valid single-entry chain.
		for (const line of lines) {
			expect(verifyHashChain([line]).valid).toBe(true);
		}
	});
});

describe("recordKeyDecision", () => {
	test("appends a dated decision block with requestId and rationale", () => {
		recordKeyDecision({ requestId: "r9", decision: "Restart the consumer group", rationale: "policy" }, baseDir);
		const content = readFileSync(join(runtimeDir(), "key-decisions.md"), "utf-8");
		expect(content).toContain("(r9)");
		expect(content).toContain("Restart the consumer group");
		expect(content).toContain("Rationale: policy");
	});

	test.if(REDACTION_ACTIVE)("redacts PII in the decision text", () => {
		recordKeyDecision({ requestId: "r10", decision: "Email admin@corp.com about the outage" }, baseDir);
		const content = readFileSync(join(runtimeDir(), "key-decisions.md"), "utf-8");
		expect(content).not.toContain("admin@corp.com");
		expect(content).toContain("[EMAIL_REDACTED]");
	});

	test("is a no-op when disabled", () => {
		process.env.LIVE_MEMORY_ENABLED = "false";
		recordKeyDecision({ requestId: "r9", decision: "x" }, baseDir);
		expect(readFileSync(join(runtimeDir(), "key-decisions.md"), "utf-8")).toBe("# Key Decisions\n");
	});
});
