// apps/web/src/lib/server/iac-reconcile-cron.test.ts
import { describe, expect, test } from "bun:test";
import { scheduleToIntervalMs } from "./iac-reconcile-cron.ts";

describe("scheduleToIntervalMs", () => {
	test("default */30 schedule -> 30 minutes", () => {
		expect(scheduleToIntervalMs("*/30 * * * *")).toBe(30 * 60_000);
	});

	test("*/15 step -> 15 minutes", () => {
		expect(scheduleToIntervalMs("*/15 * * * *")).toBe(15 * 60_000);
	});

	test("every-minute * -> 60s", () => {
		expect(scheduleToIntervalMs("* * * * *")).toBe(60_000);
	});

	test("tolerates surrounding whitespace", () => {
		expect(scheduleToIntervalMs("  */5 * * * *  ")).toBe(5 * 60_000);
	});

	test("unsupported expression falls back to 30m and invokes the callback", () => {
		let warned: string | undefined;
		const result = scheduleToIntervalMs("0 9 * * MON-FRI", (s) => {
			warned = s;
		});
		expect(result).toBe(30 * 60_000);
		expect(warned).toBe("0 9 * * MON-FRI");
	});

	test("garbage input falls back to 30m without throwing", () => {
		expect(scheduleToIntervalMs("not-a-cron")).toBe(30 * 60_000);
	});

	test("zero / negative steps are rejected -> 30m fallback", () => {
		expect(scheduleToIntervalMs("*/0 * * * *")).toBe(30 * 60_000);
	});
});
