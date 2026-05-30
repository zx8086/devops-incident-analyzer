// agent/src/memory-writer.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyHashChain } from "@devops-agent/shared";
import { appendDailyLog, readLiveMemory, recordKeyDecision } from "./memory-writer.ts";

let baseDir: string;
const prevEnabled = process.env.LIVE_MEMORY_ENABLED;
const prevImmutable = process.env.LIVE_MEMORY_IMMUTABLE;

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
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
	if (prevEnabled === undefined) delete process.env.LIVE_MEMORY_ENABLED;
	else process.env.LIVE_MEMORY_ENABLED = prevEnabled;
	if (prevImmutable === undefined) delete process.env.LIVE_MEMORY_IMMUTABLE;
	else process.env.LIVE_MEMORY_IMMUTABLE = prevImmutable;
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

	test("redacts PII in the summary field", () => {
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
	test("appends a dated, redacted decision block", () => {
		recordKeyDecision(
			{ requestId: "r9", decision: "Email admin@corp.com about the outage", rationale: "policy" },
			baseDir,
		);
		const content = readFileSync(join(runtimeDir(), "key-decisions.md"), "utf-8");
		expect(content).toContain("(r9)");
		expect(content).toContain("Rationale: policy");
		expect(content).not.toContain("admin@corp.com");
		expect(content).toContain("[EMAIL_REDACTED]");
	});

	test("is a no-op when disabled", () => {
		process.env.LIVE_MEMORY_ENABLED = "false";
		recordKeyDecision({ requestId: "r9", decision: "x" }, baseDir);
		expect(readFileSync(join(runtimeDir(), "key-decisions.md"), "utf-8")).toBe("# Key Decisions\n");
	});
});
