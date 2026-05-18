// apps/web/src/lib/components/ElasticFindingsCard.test.ts
// SIO-785 follow-up (2026-05-18): minimal Elastic findings card.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import ElasticFindingsCard from "./ElasticFindingsCard.svelte";

describe("ElasticFindingsCard.svelte", () => {
	test("renders nothing when findings has no syntheticMonitors", () => {
		const { body } = render(ElasticFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("Elastic findings");
	});

	test("renders nothing when syntheticMonitors is empty", () => {
		const { body } = render(ElasticFindingsCard, { props: { findings: { syntheticMonitors: [] } } });
		expect(body).not.toContain("Elastic findings");
	});

	test("renders monitor with up status (green dot) and timestamp", () => {
		const { body } = render(ElasticFindingsCard, {
			props: {
				findings: {
					syntheticMonitors: [
						{
							name: "ksql-prd-healthcheck",
							status: "up",
							observedAt: "2026-05-18T07:23:18.000Z",
							geo: "eu-central-1a",
						},
					],
				},
			},
		});
		expect(body).toContain("Elastic findings");
		expect(body).toContain("Synthetic monitors");
		expect(body).toContain("ksql-prd-healthcheck");
		expect(body).toContain("eu-central-1a");
		expect(body).toContain("2026-05-18 07:23");
		expect(body).toContain("bg-green-500");
	});

	test("renders down status with red dot", () => {
		const { body } = render(ElasticFindingsCard, {
			props: {
				findings: {
					syntheticMonitors: [{ name: "connect-prd", status: "down" }],
				},
			},
		});
		expect(body).toContain("connect-prd");
		expect(body).toContain("bg-red-500");
	});

	test("renders multiple monitors with mixed statuses", () => {
		const { body } = render(ElasticFindingsCard, {
			props: {
				findings: {
					syntheticMonitors: [
						{ name: "monitor-a", status: "up" },
						{ name: "monitor-b", status: "down" },
						{ name: "monitor-c", status: "degraded" },
					],
				},
			},
		});
		expect(body).toContain("monitor-a");
		expect(body).toContain("monitor-b");
		expect(body).toContain("monitor-c");
		expect(body).toContain("bg-green-500");
		expect(body).toContain("bg-red-500");
		expect(body).toContain("bg-amber-500");
	});
});
