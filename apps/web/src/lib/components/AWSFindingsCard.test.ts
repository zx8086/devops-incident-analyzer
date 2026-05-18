// apps/web/src/lib/components/AWSFindingsCard.test.ts
// SIO-785 Phase 2: typed AWS findings render inline in chat.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import AWSFindingsCard from "./AWSFindingsCard.svelte";

describe("AWSFindingsCard.svelte", () => {
	test("renders nothing when findings has no alarms", () => {
		const { body } = render(AWSFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("AWS findings");
	});

	test("renders nothing when alarms is empty array", () => {
		const { body } = render(AWSFindingsCard, { props: { findings: { alarms: [] } } });
		expect(body).not.toContain("AWS findings");
	});

	test("renders one alarm with name + state + namespace + reason", () => {
		const { body } = render(AWSFindingsCard, {
			props: {
				findings: {
					alarms: [
						{
							name: "msk-cpu",
							state: "ALARM",
							reason: "Threshold > 80%",
							namespace: "AWS/Kafka",
						},
					],
				},
			},
		});
		expect(body).toContain("AWS findings");
		expect(body).toContain("CloudWatch alarms");
		expect(body).toContain("msk-cpu");
		expect(body).toContain("ALARM");
		expect(body).toContain("AWS/Kafka");
		expect(body).toContain("Threshold");
		expect(body).toContain("80%");
	});

	test("sorts ALARM first, then INSUFFICIENT_DATA, then OK", () => {
		const { body } = render(AWSFindingsCard, {
			props: {
				findings: {
					alarms: [
						{ name: "ok-one", state: "OK" },
						{ name: "alarm-two", state: "ALARM" },
						{ name: "insuff-three", state: "INSUFFICIENT_DATA" },
					],
				},
			},
		});
		const idxAlarm = body.indexOf("alarm-two");
		const idxInsuff = body.indexOf("insuff-three");
		const idxOk = body.indexOf("ok-one");
		expect(idxAlarm).toBeGreaterThan(-1);
		expect(idxInsuff).toBeGreaterThan(idxAlarm);
		expect(idxOk).toBeGreaterThan(idxInsuff);
	});

	test("renders state aggregate header (e.g. 1 ALARM · 2 OK)", () => {
		const { body } = render(AWSFindingsCard, {
			props: {
				findings: {
					alarms: [
						{ name: "a", state: "ALARM" },
						{ name: "b", state: "OK" },
						{ name: "c", state: "OK" },
					],
				},
			},
		});
		expect(body).toMatch(/1\s*ALARM/);
		expect(body).toMatch(/2\s*OK/);
	});

	test("uses correct status dot class per state", () => {
		const { body } = render(AWSFindingsCard, {
			props: {
				findings: {
					alarms: [
						{ name: "alarm-row", state: "ALARM" },
						{ name: "ok-row", state: "OK" },
						{ name: "insuff-row", state: "INSUFFICIENT_DATA" },
					],
				},
			},
		});
		// The card uses Tailwind utility classes; assert presence of each color class
		expect(body).toContain("bg-red-500");
		expect(body).toContain("bg-green-500");
		expect(body).toContain("bg-slate-400");
	});
});
