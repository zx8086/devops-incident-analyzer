// shared/src/__tests__/sandbox-exec.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	IN_THREAD_LIMITS,
	resolveSandboxWorkerUrl,
	runInSandbox,
	SANDBOX_MAX_CODE_BYTES,
	type SandboxEvidence,
	WORKER_LIMITS,
} from "../sandbox-exec.ts";

// SIO-1776. This file IS the security boundary's acceptance suite: EVIDENCE_EXEC_ENABLED may
// not be turned on anywhere unless it passes. Every case runs on BOTH engine modes, because
// a bundled build falls back to in-thread and that path must be exactly as closed.

const hits = Array.from({ length: 900 }, (_, i) => ({
	_id: `d${i}`,
	_source: { service: i % 3 ? "prana-order" : "prana-import-export", msg: i % 7 ? "ok" : "FOP ValidationException" },
}));
const evidence: SandboxEvidence[] = [
	{ id: "e1", tool: "elasticsearch_search", json: JSON.stringify({ hits: { hits } }) },
	{ id: "e2", tool: "aws_logs_get_query_results", json: JSON.stringify({ results: [{ count: 46 }] }) },
];

const MODES = [
	{ name: "worker", options: {} },
	{ name: "in-thread", options: { forceInThread: true } },
] as const;

test("the worker file resolves in this checkout, so the worker path below is really exercised", () => {
	expect(resolveSandboxWorkerUrl()?.pathname.endsWith("sandbox-worker.mjs")).toBe(true);
});

test("the guest stack limit stays far below the host's native stack", () => {
	// Node aborted the WASM module at 512 KB, and at 128 KB from a deep host stack. Raising
	// this is a security change: re-run the depth measurements on SIO-1776 first.
	expect(WORKER_LIMITS.stackBytes).toBeLessThanOrEqual(64 * 1024);
	expect(IN_THREAD_LIMITS.stackBytes).toBeLessThanOrEqual(64 * 1024);
});

for (const { name, options } of MODES) {
	const run = (code: string, ev: SandboxEvidence[] = evidence) => runInSandbox(code, ev, options);

	describe(`runInSandbox (${name})`, () => {
		test("reports the mode it actually ran in", async () => {
			expect((await run("return 1;")).mode).toBe(name);
		});

		test("derives an answer from captured evidence: only the answer comes back", async () => {
			const r = await run(
				`const c = {}; for (const h of evidence.get("e1").hits.hits) if (h._source.msg !== "ok") c[h._source.service] = (c[h._source.service] || 0) + 1; return c;`,
			);
			expect(r.error).toBeUndefined();
			expect(JSON.parse(r.stdout)).toEqual({ "prana-import-export": 43, "prana-order": 86 });
			expect(r.stdout.length).toBeLessThan(100);
		});

		test("evidence.list names every item; a join across two results works", async () => {
			const r = await run(
				`return { ids: evidence.list().map((e) => e.id + ":" + e.tool), es: evidence.get("e1").hits.hits.length, cw: evidence.get("e2").results[0].count, missing: typeof evidence.get("nope") };`,
			);
			expect(JSON.parse(r.stdout)).toEqual({
				ids: ["e1:elasticsearch_search", "e2:aws_logs_get_query_results"],
				es: 900,
				cw: 46,
				missing: "undefined",
			});
		});

		test("print output precedes the return value", async () => {
			expect((await run(`print("a", { b: 1 }); print("c"); return "done";`)).stdout).toBe('a {"b":1}\nc\ndone');
		});

		test("no host globals exist in the guest", async () => {
			const names = [
				"process",
				"require",
				"fetch",
				"Bun",
				"Deno",
				"WebAssembly",
				"XMLHttpRequest",
				"setTimeout",
				"setInterval",
				"queueMicrotask",
				"module",
				"__dirname",
			];
			const r = await run(
				`return ${JSON.stringify(names)}.filter((n) => { try { return typeof (0, eval)(n) !== "undefined"; } catch { return false; } });`,
			);
			expect(JSON.parse(r.stdout)).toEqual([]);
		});

		test("the constructor escape stays inside the guest global", async () => {
			const r = await run(
				`const g = ({}).constructor.constructor("return this")(); return [typeof g.process, typeof g.require, g === globalThis];`,
			);
			expect(JSON.parse(r.stdout)).toEqual(["undefined", "undefined", true]);
		});

		test("a secret in the host environment is unreachable from anything the guest can walk to", async () => {
			process.env.SANDBOX_TEST_SECRET = "s3cr3t-must-not-leak";
			try {
				const r = await run(
					`const seen = []; const walk = (o, d) => { if (d > 3 || !o) return; for (const k of Object.getOwnPropertyNames(o)) { try { const v = o[k]; if (typeof v === "string") seen.push(v); else if (typeof v === "object" || typeof v === "function") walk(v, d + 1); } catch {} } }; walk(globalThis, 0); return { leaked: seen.join("|").includes("s3cr3t"), walked: seen.length };`,
				);
				const out = JSON.parse(r.stdout) as { leaked: boolean; walked: number };
				expect(out.leaked).toBe(false);
				expect(out.walked).toBeGreaterThan(100); // the walk really covered the global graph
			} finally {
				delete process.env.SANDBOX_TEST_SECRET;
			}
		});

		test("a dynamic import goes nowhere", async () => {
			const r = await run(
				`let loaded = false; import("node:fs").then(() => { loaded = true; }, () => {}); return loaded;`,
			);
			expect(r.stdout).toBe("false");
		});

		test("an infinite loop is interrupted at the deadline and reported as such", async () => {
			const r = await run("while (true) {}");
			expect(r.interrupted).toBe(true);
			expect(r.durationMs).toBeLessThan(4_500);
		}, 10_000);

		test("a memory bomb ends in out-of-memory and the host keeps working", async () => {
			const r = await run(`const a = []; while (true) a.push(new Array(1e6).fill("x".repeat(100)));`);
			expect(r.error).toBeDefined();
			expect(r.outOfMemory === true || r.interrupted === true || r.hostFailure === true).toBe(true);
			expect((await run("return 1 + 1;")).stdout).toBe("2");
		}, 15_000);

		test("runaway recursion is a clean guest error, never a host failure", async () => {
			const r = await run("const f = () => f(); f();");
			expect(r.error).toContain("stack overflow");
			expect(r.hostFailure).toBeUndefined();
			expect((await run("return 1 + 1;")).stdout).toBe("2");
		});

		test("ordinary recursion and nested JSON still fit inside the small stack", async () => {
			const r = await run(
				`const depth = (n) => (n === 0 ? 0 : 1 + depth(n - 1)); return [depth(300), Array.isArray(JSON.parse("[".repeat(200) + "]".repeat(200)))];`,
			);
			expect(JSON.parse(r.stdout)).toEqual([300, true]);
		});

		test("output is capped, cut at a line boundary, and flagged", async () => {
			const r = await run(`for (let i = 0; i < 5000; i++) print("line " + i);`);
			expect(r.truncated).toBe(true);
			expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(WORKER_LIMITS.stdoutBytes);
			expect(r.stdout.endsWith("[output truncated]")).toBe(true);
			expect(r.stdout).toMatch(/line \d+\n\[output truncated\]$/);
		});

		// Greptile, PR #811: a byte-index cut inside a multi-byte code point decoded to U+FFFD
		// (3 bytes), so one long non-ASCII line came out corrupted AND up to 2 bytes over the cap.
		test("the cap holds for multi-byte output and never splits a code point", async () => {
			for (const ch of ["é", "€", "😀"]) {
				for (const pad of [0, 1, 2, 3]) {
					const r = await run(`return "a".repeat(${pad}) + ${JSON.stringify(ch)}.repeat(5000);`);
					expect(r.truncated).toBe(true);
					expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(WORKER_LIMITS.stdoutBytes);
					expect(r.stdout).not.toContain("\uFFFD");
				}
			}
		}, 30_000);

		test("nothing survives between calls: not a global, not a mutation of the evidence", async () => {
			expect(
				(await run(`globalThis.leak = 1; evidence.get("e1").hits.hits.length = 0; return "mutated";`)).stdout,
			).toBe("mutated");
			expect((await run(`return [evidence.get("e1").hits.hits.length, typeof globalThis.leak];`)).stdout).toBe(
				'[900,"undefined"]',
			);
		});

		test("the evidence API cannot be replaced from the guest", async () => {
			const r = await run(`try { evidence.get = () => "pwned"; } catch {} return typeof evidence.get("e1");`);
			expect(r.stdout).toBe("object");
		});

		test("a guest exception is an error result carrying its message", async () => {
			const r = await run(`throw new TypeError("bad transform");`);
			expect(r.error).toBe("TypeError: bad transform");
			expect(r.hostFailure).toBeUndefined();
		});

		test("a result that is not JSON is handed over as the string it is", async () => {
			const markdown = [
				{ id: "e1", tool: "capella_get_fatal_requests", json: "## Fatal requests\n\nNone in the window." },
			];
			const r = await run(`const t = evidence.get("e1"); return [typeof t, t.split("\\n")[0]];`, markdown);
			expect(JSON.parse(r.stdout)).toEqual(["string", "## Fatal requests"]);
		});

		test("oversized code is refused before anything runs", async () => {
			const r = await run(`return 1; //${"x".repeat(SANDBOX_MAX_CODE_BYTES)}`);
			expect(r.error).toContain("exceeds");
		});

		test("evidence text that tries to break out of its JSON string is just data", async () => {
			const hostile = [{ id: "e1", tool: "t", json: JSON.stringify({ note: '"}); globalThis.pwned = true; ({"' }) }];
			const r = await run(`return [evidence.get("e1").note.length > 0, typeof globalThis.pwned];`, hostile);
			expect(r.stdout).toBe('[true,"undefined"]');
		});
	});
}

// The web app's dev host is Node (`vite dev`); bun test cannot execute that half.
// The probe imports the TypeScript engine directly, which needs Node's native type stripping
// (on by default from 22.18). Older or absent node skips: the repo runtime is Bun.
function nodeAvailable(): boolean {
	const node = Bun.which("node");
	if (!node) return false;
	const [major = 0, minor = 0] = Bun.spawnSync([node, "--version"])
		.stdout.toString()
		.trim()
		.replace(/^v/, "")
		.split(".")
		.map(Number);
	return major > 22 || (major === 22 && minor >= 18);
}

test.skipIf(!nodeAvailable())(
	"under a real node: worker and in-thread both run, and the event loop is not blocked by a spinning guest",
	async () => {
		{
			const probe = join(import.meta.dir, "fixtures/sandbox-node-probe.mjs");
			const run = Bun.spawnSync(["node", probe], { cwd: join(import.meta.dir, "..") });
			const out = JSON.parse(run.stdout.toString().trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
			expect(out).toMatchObject({
				runtime: "node",
				workerMode: "worker",
				workerAnswer: "2",
				inThreadAnswer: "2",
				recursion: "clean",
				spinInterrupted: true,
			});
			// A spinning guest in a worker must not stall the main loop (in-thread it blocks ~2 s).
			expect(out.maxLagMs as number).toBeLessThan(250);
		}
	},
	20_000,
);
