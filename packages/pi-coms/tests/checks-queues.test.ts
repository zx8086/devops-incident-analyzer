// tests/checks-queues.test.ts
import { describe, expect, test } from "bun:test";
import { checkQueues } from "../scripts/monitor/checks/queues.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const BASE = "https://sqs.eu-central-1.amazonaws.com/x";
const ARN = (n: string) => `arn:aws:sqs:eu-central-1:x:${n}`;

type Q = { name: string; depth: number; redriveTo?: string };

function fakeClient(queues: Q[]) {
	return {
		send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
			switch (cmd.constructor.name) {
				case "ListQueuesCommand":
					return { QueueUrls: queues.map((q) => `${BASE}/${q.name}`) };
				case "GetQueueAttributesCommand": {
					const name = String(cmd.input.QueueUrl).split("/").pop();
					const q = queues.find((x) => x.name === name);
					if (!q) throw new Error(`unknown queue ${name}`);
					return {
						Attributes: {
							QueueArn: ARN(q.name),
							ApproximateNumberOfMessages: String(q.depth),
							ApproximateNumberOfMessagesNotVisible: "0",
							...(q.redriveTo
								? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: ARN(q.redriveTo), maxReceiveCount: 5 }) }
								: {}),
						},
					};
				}
				default:
					throw new Error(`unexpected ${cmd.constructor.name}`);
			}
		},
	};
}

describe("queues check", () => {
	// Depth is what a working queue has. Reporting it would be the noise this
	// check exists to avoid.
	test("a busy source queue raises nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ name: "orders", depth: 4200 }]);
		expect(await checkQueues(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("depth on a redrive target is a warn", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ name: "orders", depth: 0, redriveTo: "orders-dlq" },
			{ name: "orders-dlq", depth: 7 },
		]);
		const findings = await checkQueues(client, state, { now: NOW });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.family).toBe("queues");
		expect(findings[0]?.severity).toBe("warn");
		expect(findings[0]?.resource).toBe("orders-dlq");
		// Naming the source is what points the diagnosis at the failing consumer.
		expect(findings[0]?.summary).toContain("orders");
		const evidence = findings[0]?.evidence as { redrivenFrom: { name: string }[] } | undefined;
		expect(evidence?.redrivenFrom[0]?.name).toBe("orders");
		state.close();
	});

	// A DLQ is defined by being pointed at, not by its name. This is the
	// discriminator: get it from the name and every "-dlq" scratch queue in the
	// account becomes a finding.
	test("a queue NAMED like a DLQ that nothing redrives into raises nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ name: "legacy-dlq", depth: 99 }]);
		expect(await checkQueues(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("an empty DLQ raises nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ name: "orders", depth: 12, redriveTo: "orders-dlq" },
			{ name: "orders-dlq", depth: 0 },
		]);
		expect(await checkQueues(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("a malformed redrive policy classifies nothing rather than inventing a DLQ", async () => {
		const state = new MonitorState(":memory:");
		const client = {
			send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
				if (cmd.constructor.name === "ListQueuesCommand") return { QueueUrls: [`${BASE}/a`, `${BASE}/b`] };
				const name = String(cmd.input.QueueUrl).split("/").pop();
				return {
					Attributes: {
						QueueArn: ARN(String(name)),
						ApproximateNumberOfMessages: "5",
						...(name === "a" ? { RedrivePolicy: "{not json" } : {}),
					},
				};
			},
		};
		expect(await checkQueues(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("the same DLQ alerts once, then re-arms after it drains", async () => {
		const state = new MonitorState(":memory:");
		const full = fakeClient([
			{ name: "orders", depth: 0, redriveTo: "orders-dlq" },
			{ name: "orders-dlq", depth: 7 },
		]);
		expect(await checkQueues(full, state, { now: NOW })).toHaveLength(1);
		expect(await checkQueues(full, state, { now: NOW + 900_000 })).toEqual([]);
		const drained = fakeClient([
			{ name: "orders", depth: 0, redriveTo: "orders-dlq" },
			{ name: "orders-dlq", depth: 0 },
		]);
		await checkQueues(drained, state, { now: NOW + 1_800_000 });
		expect(await checkQueues(full, state, { now: NOW + 2_700_000 })).toHaveLength(1);
		state.close();
	});
});
