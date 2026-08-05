// packages/agent/src/eval/fixture-recorder.test.ts
//
// SIO-1379: the recorder must be observationally invisible to the agent -- identical results,
// identical errors, soft-fail on any write problem -- and the output store must round-trip
// through JSONL including torn-line tolerance. No network, no MCP, no OpenAI.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { applyToolMiddleware } from "../mcp-bridge.ts";
import {
	appendRecordedOutput,
	currentExampleTag,
	exampleKey,
	fixturesDir,
	readRecordedOutputs,
	recordingToolMiddleware,
	runWithExampleTag,
	updateManifest,
} from "./fixture-recorder.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fixture-recorder-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fakeTool(overrides: Partial<Record<string, unknown>> = {}): StructuredToolInterface {
	return {
		name: "fake_tool",
		description: "a fake tool",
		invoke: async (input: unknown) => ({ echoed: input }),
		...overrides,
	} as unknown as StructuredToolInterface;
}

function readJsonlRecords(filePath: string): Array<Record<string, unknown>> {
	return readFileSync(filePath, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("exampleKey (SIO-1379)", () => {
	test("is stable, 16 hex chars, and distinct per query", () => {
		const a = exampleKey("query A");
		expect(a).toBe(exampleKey("query A"));
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(a).not.toBe(exampleKey("query B"));
	});
});

describe("runWithExampleTag (SIO-1379)", () => {
	test("tags calls inside the scope and falls back to untagged outside it", async () => {
		expect(currentExampleTag()).toBe("untagged");
		const seen = await runWithExampleTag("abc123", async () => currentExampleTag());
		expect(seen).toBe("abc123");
		expect(currentExampleTag()).toBe("untagged");
	});
});

describe("fixturesDir (SIO-1379)", () => {
	test("EVAL_FIXTURES_DIR overrides the default in-tree location", () => {
		expect(fixturesDir({ EVAL_FIXTURES_DIR: "/tmp/somewhere" } as NodeJS.ProcessEnv)).toBe("/tmp/somewhere");
		expect(fixturesDir({} as NodeJS.ProcessEnv).endsWith("fixtures")).toBe(true);
	});
});

describe("recordingToolMiddleware (SIO-1379)", () => {
	test("returns the tool's result unchanged and appends an audit record", async () => {
		const dir = tempDir();
		const wrapped = recordingToolMiddleware({ dir, leg: "test-leg" })("elastic-mcp", fakeTool());
		const result = await wrapped.invoke({ q: "hello" } as never);
		expect(result).toEqual({ echoed: { q: "hello" } });
		const records = readJsonlRecords(join(dir, "tool-calls-test-leg.jsonl"));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			example: "untagged",
			server: "elastic-mcp",
			tool: "fake_tool",
			args: { q: "hello" },
			result: { echoed: { q: "hello" } },
		});
		expect(typeof records[0]?.ms).toBe("number");
	});

	test("records the ALS example tag when invoked inside a tagged scope", async () => {
		const dir = tempDir();
		const wrapped = recordingToolMiddleware({ dir, leg: "test-leg" })("kafka-mcp", fakeTool());
		await runWithExampleTag("deadbeef00000000", () => wrapped.invoke({} as never));
		const records = readJsonlRecords(join(dir, "tool-calls-test-leg.jsonl"));
		expect(records[0]?.example).toBe("deadbeef00000000");
	});

	test("rethrows the tool's own error unchanged and records it", async () => {
		const dir = tempDir();
		const boom = new Error("upstream exploded");
		const failing = fakeTool({
			invoke: async () => {
				throw boom;
			},
		});
		const wrapped = recordingToolMiddleware({ dir, leg: "test-leg" })("aws-mcp", failing);
		let caught: unknown;
		try {
			await wrapped.invoke({} as never);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(boom);
		const records = readJsonlRecords(join(dir, "tool-calls-test-leg.jsonl"));
		expect(records[0]?.error).toBe("upstream exploded");
		expect(records[0]?.result).toBeUndefined();
	});

	test("soft-fails when the fixtures dir is unwritable -- the result is unaffected", async () => {
		// Point the recorder's dir AT A FILE so mkdir/append inside it must fail.
		const dir = tempDir();
		const fileAsDir = join(dir, "not-a-dir");
		writeFileSync(fileAsDir, "occupied");
		const wrapped = recordingToolMiddleware({ dir: fileAsDir, leg: "test-leg" })("gitlab-mcp", fakeTool());
		const result = await wrapped.invoke({ ok: true } as never);
		expect(result).toEqual({ echoed: { ok: true } });
	});

	test("delegates non-invoke properties to the underlying tool", () => {
		const wrapped = recordingToolMiddleware({ dir: tempDir(), leg: "test-leg" })("couchbase-mcp", fakeTool());
		expect(wrapped.name).toBe("fake_tool");
		expect(wrapped.description).toBe("a fake tool");
	});
});

describe("output store round-trip (SIO-1379)", () => {
	test("appendRecordedOutput -> readRecordedOutputs, last record per key wins", () => {
		const dir = tempDir();
		appendRecordedOutput(dir, "leg-a", "the query", { response: "first" });
		appendRecordedOutput(dir, "leg-a", "the query", { response: "second" });
		appendRecordedOutput(dir, "leg-a", "another query", { response: "other" });
		const outputs = readRecordedOutputs(dir, "leg-a");
		expect(outputs.size).toBe(2);
		expect(outputs.get(exampleKey("the query"))).toEqual({ response: "second" });
		expect(outputs.get(exampleKey("another query"))).toEqual({ response: "other" });
	});

	test("legs are isolated files", () => {
		const dir = tempDir();
		appendRecordedOutput(dir, "leg-a", "q", { response: "a" });
		appendRecordedOutput(dir, "leg-b", "q", { response: "b" });
		expect(readRecordedOutputs(dir, "leg-a").get(exampleKey("q"))).toEqual({ response: "a" });
		expect(readRecordedOutputs(dir, "leg-b").get(exampleKey("q"))).toEqual({ response: "b" });
	});

	test("a torn/corrupt line is skipped without poisoning later lines", () => {
		const dir = tempDir();
		appendRecordedOutput(dir, "leg-a", "good query", { response: "kept" });
		const filePath = join(dir, "outputs-leg-a.jsonl");
		const intact = readFileSync(filePath, "utf-8");
		writeFileSync(filePath, `{"key":"tor${intact}`);
		const outputs = readRecordedOutputs(dir, "leg-a");
		expect(outputs.get(exampleKey("good query"))).toBeUndefined();
		// Append another good record after the torn one; it must load.
		appendRecordedOutput(dir, "leg-a", "second query", { response: "loaded" });
		expect(readRecordedOutputs(dir, "leg-a").get(exampleKey("second query"))).toEqual({ response: "loaded" });
	});

	test("a missing store throws with a record-first instruction", () => {
		expect(() => readRecordedOutputs(tempDir(), "never-recorded")).toThrow(/EVAL_FIXTURE_MODE=record/);
	});
});

describe("MANIFEST.json (SIO-1379)", () => {
	test("tracks per-leg record counts and a bounded query preview, no payload content", () => {
		const dir = tempDir();
		const longQuery = "x".repeat(300);
		updateManifest(dir, "leg-a", longQuery);
		updateManifest(dir, "leg-a", longQuery);
		updateManifest(dir, "leg-b", longQuery);
		const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf-8")) as Record<
			string,
			{ queryPreview: string; legs: Record<string, number> }
		>;
		const entry = manifest[exampleKey(longQuery)];
		expect(entry?.legs).toEqual({ "leg-a": 2, "leg-b": 1 });
		expect(entry?.queryPreview.length).toBe(100);
	});
});

describe("applyToolMiddleware (SIO-1379, mcp-bridge seam)", () => {
	test("no middleware returns the exact same tools array", () => {
		const tools = [fakeTool()];
		expect(applyToolMiddleware(undefined, "elastic-mcp", tools)).toBe(tools);
	});

	test("middleware is applied per tool with the server name", () => {
		const seen: string[] = [];
		const tools = [fakeTool({ name: "a" }), fakeTool({ name: "b" })];
		const wrapped = applyToolMiddleware(
			(serverName, tool) => {
				seen.push(`${serverName}:${tool.name}`);
				return tool;
			},
			"kafka-mcp",
			tools,
		);
		expect(wrapped).toHaveLength(2);
		expect(seen).toEqual(["kafka-mcp:a", "kafka-mcp:b"]);
	});
});

// SIO-1379: toolMiddleware is an eval-only seam. Production wiring gets no recording, ever --
// this pins that the web app's MCP config never sets the field (the compile-time type allows
// it, so a content check is the enforcement).
describe("production wiring stays middleware-free (SIO-1379)", () => {
	test("apps/web/src/lib/server/agent.ts never references toolMiddleware", () => {
		const productionWiring = readFileSync(
			join(import.meta.dir, "../../../../apps/web/src/lib/server/agent.ts"),
			"utf-8",
		);
		expect(productionWiring).toContain("createMcpClient");
		expect(productionWiring).not.toContain("toolMiddleware");
	});
});
