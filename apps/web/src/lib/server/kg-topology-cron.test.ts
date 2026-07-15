// apps/web/src/lib/server/kg-topology-cron.test.ts
import { describe, expect, test } from "bun:test";
import { scheduleToIntervalMs } from "./kg-topology-cron.ts";

describe("scheduleToIntervalMs (kg-topology)", () => {
	test("default 0 * * * * (fixed minute, wildcard hour) -> hourly", () => {
		expect(scheduleToIntervalMs("0 * * * *")).toBe(60 * 60_000);
		expect(scheduleToIntervalMs("30 * * * *")).toBe(60 * 60_000);
	});

	test("*/30 step -> 30 minutes", () => {
		expect(scheduleToIntervalMs("*/30 * * * *")).toBe(30 * 60_000);
	});

	test("every-minute * -> 60s", () => {
		expect(scheduleToIntervalMs("* * * * *")).toBe(60_000);
	});

	test("a constrained hour is NOT treated as hourly -> fallback + callback", () => {
		let warned: string | undefined;
		const result = scheduleToIntervalMs("0 9 * * MON-FRI", (s) => {
			warned = s;
		});
		expect(result).toBe(60 * 60_000);
		expect(warned).toBe("0 9 * * MON-FRI");
	});

	test("garbage input falls back to hourly without throwing", () => {
		expect(scheduleToIntervalMs("not-a-cron")).toBe(60 * 60_000);
	});

	test("zero step is rejected -> fallback", () => {
		let warned: string | undefined;
		expect(
			scheduleToIntervalMs("*/0 * * * *", (s) => {
				warned = s;
			}),
		).toBe(60 * 60_000);
		expect(warned).toBe("*/0 * * * *");
	});
});
