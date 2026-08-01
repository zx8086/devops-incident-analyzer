// gitagent-bridge/src/schedule.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSchedules, ScheduleDefSchema } from "./schedule.ts";

describe("ScheduleDefSchema", () => {
	const base = { id: "s" };

	test("accepts a repeat schedule with cron + workflow", () => {
		expect(ScheduleDefSchema.safeParse({ ...base, mode: "repeat", cron: "0 * * * *", workflow: "w" }).success).toBe(
			true,
		);
	});

	test("accepts a once schedule with runAt + workflow", () => {
		expect(
			ScheduleDefSchema.safeParse({ ...base, mode: "once", runAt: "2026-04-01T09:00:00Z", workflow: "w" }).success,
		).toBe(true);
	});

	// CLAUDE.md: no .default() in config schemas -- the schema stays honest about
	// what was actually in the file (mode/enabled omitted here parse as
	// undefined); loadSchedules() materializes the repeat/true defaults after a
	// successful parse (covered in the loadSchedules describe block below).
	test("mode and enabled are optional at the schema level (no schema defaults)", () => {
		const result = ScheduleDefSchema.safeParse({ ...base, cron: "0 * * * *", workflow: "w" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.mode).toBeUndefined();
			expect(result.data.enabled).toBeUndefined();
		}
	});

	test("accepts a prompt target with agent", () => {
		expect(
			ScheduleDefSchema.safeParse({ ...base, cron: "0 9 * * *", prompt: "summarize", agent: "incident-analyzer" })
				.success,
		).toBe(true);
	});

	test("rejects repeat mode with no cron", () => {
		expect(ScheduleDefSchema.safeParse({ ...base, mode: "repeat", workflow: "w" }).success).toBe(false);
	});

	test("rejects once mode with no runAt", () => {
		expect(ScheduleDefSchema.safeParse({ ...base, mode: "once", workflow: "w" }).success).toBe(false);
	});

	test("rejects both workflow and prompt set", () => {
		expect(ScheduleDefSchema.safeParse({ ...base, cron: "0 * * * *", workflow: "w", prompt: "p" }).success).toBe(false);
	});

	test("rejects neither workflow nor prompt set", () => {
		expect(ScheduleDefSchema.safeParse({ ...base, cron: "0 * * * *" }).success).toBe(false);
	});

	test("rejects unknown keys (strict)", () => {
		expect(ScheduleDefSchema.safeParse({ ...base, cron: "0 * * * *", workflow: "w", bogus: 1 }).success).toBe(false);
	});

	test("rejects a repeat schedule that also sets runAt", () => {
		expect(
			ScheduleDefSchema.safeParse({
				...base,
				mode: "repeat",
				cron: "0 * * * *",
				runAt: "2026-04-01T09:00:00Z",
				workflow: "w",
			}).success,
		).toBe(false);
	});

	test("rejects a once schedule that also sets cron", () => {
		expect(
			ScheduleDefSchema.safeParse({
				...base,
				mode: "once",
				cron: "0 * * * *",
				runAt: "2026-04-01T09:00:00Z",
				workflow: "w",
			}).success,
		).toBe(false);
	});
});

describe("loadSchedules", () => {
	test("returns an empty map when schedules/ is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-sched-none-"));
		try {
			expect(loadSchedules(dir).size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("parses every *.yaml keyed by schedule id", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-sched-"));
		mkdirSync(join(dir, "schedules"), { recursive: true });
		writeFileSync(
			join(dir, "schedules", "sweep.yaml"),
			["id: sweep", "cron: '*/30 * * * *'", "workflow: reconcile-sweep"].join("\n"),
		);
		try {
			const schedules = loadSchedules(dir);
			expect(schedules.size).toBe(1);
			expect(schedules.has("sweep")).toBe(true);
			expect(schedules.get("sweep")?.workflow).toBe("reconcile-sweep");
			expect(schedules.get("sweep")?.enabled).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("a malformed file logs via onError and is skipped, never throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-sched-bad-"));
		mkdirSync(join(dir, "schedules"), { recursive: true });
		// both workflow and prompt set -> superRefine failure
		writeFileSync(
			join(dir, "schedules", "broken.yaml"),
			["id: broken", "cron: '0 * * * *'", "workflow: w", "prompt: p"].join("\n"),
		);
		writeFileSync(join(dir, "schedules", "good.yaml"), ["id: good", "cron: '0 * * * *'", "workflow: w"].join("\n"));
		const errors: string[] = [];
		try {
			const schedules = loadSchedules(dir, (path) => errors.push(path));
			expect(schedules.size).toBe(1);
			expect(schedules.has("good")).toBe(true);
			expect(errors.some((p) => p.endsWith("broken.yaml"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("a duplicate schedule id is reported via onError and NOT overwritten", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-sched-dup-"));
		mkdirSync(join(dir, "schedules"), { recursive: true });
		writeFileSync(
			join(dir, "schedules", "a-first.yaml"),
			["id: dup", "cron: '0 * * * *'", "workflow: first-workflow"].join("\n"),
		);
		writeFileSync(
			join(dir, "schedules", "b-second.yaml"),
			["id: dup", "cron: '0 3 * * *'", "workflow: second-workflow"].join("\n"),
		);
		const errors: Array<{ path: string; message: string }> = [];
		try {
			const schedules = loadSchedules(dir, (path, error) =>
				errors.push({ path, message: error instanceof Error ? error.message : String(error) }),
			);
			expect(schedules.size).toBe(1);
			// The FIRST file enumerated wins; the id is never silently overwritten by
			// a later file (directory enumeration order must not decide the winner).
			expect(schedules.get("dup")?.workflow).toBe("first-workflow");
			expect(errors.some((e) => e.path.endsWith("b-second.yaml") && /duplicate schedule id/.test(e.message))).toBe(
				true,
			);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
