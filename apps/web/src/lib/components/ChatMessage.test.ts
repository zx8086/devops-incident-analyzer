// apps/web/src/lib/components/ChatMessage.test.ts
// SIO-785 follow-up: card is promoted from CompletedProgress diagnostic panel
// into the main ChatMessage bubble, immediately after the markdown report and
// before the Completed-in-Xs accordion. These tests lock in placement so a
// future refactor doesn't quietly move the card back.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import type { ChatMessage as ChatMessageType } from "$lib/stores/agent.svelte";
import ChatMessage from "./ChatMessage.svelte";

const baseAssistant: ChatMessageType = {
	role: "assistant",
	content: "## Incident Report\n\nDetails follow.",
	responseTime: 12345,
	toolsUsed: ["kafka_list_consumer_groups"],
	completedNodes: new Map([["aggregate", { duration: 1234 }]]),
};

describe("ChatMessage placement", () => {
	test("renders KafkaFindingsCard when message.dataSourceFindings has kafka findings", () => {
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map([
				[
					"kafka",
					{
						status: "success",
						kafkaFindings: {
							consumerGroups: [{ id: "notification-service", state: "STABLE", totalLag: 0 }],
						},
					},
				],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).toContain("Kafka findings");
		expect(body).toContain("notification-service");
	});

	test("does NOT render KafkaFindingsCard when message has no dataSourceFindings", () => {
		const { body } = render(ChatMessage, { props: { message: baseAssistant, index: 0 } });
		expect(body).not.toContain("Kafka findings");
	});

	test("does NOT render KafkaFindingsCard when kafka entry has no kafkaFindings", () => {
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map([["kafka", { status: "success" }]]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).not.toContain("Kafka findings");
	});

	test("KafkaFindingsCard appears BEFORE the Completed diagnostic panel", () => {
		// SIO-784 + SIO-785 follow-up: card lives inline with the assistant's
		// report, NOT inside the collapsed Completed diagnostic accordion.
		// Order matters: the card belongs with findings; the accordion is debug.
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map([
				[
					"kafka",
					{
						status: "success",
						kafkaFindings: {
							consumerGroups: [{ id: "notification-service", state: "STABLE", totalLag: 0 }],
						},
					},
				],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		const cardIdx = body.indexOf("Kafka findings");
		// The Completed accordion button always contains the substring "Completed".
		const completedIdx = body.indexOf("Completed");
		expect(cardIdx).toBeGreaterThan(-1);
		expect(completedIdx).toBeGreaterThan(-1);
		expect(cardIdx).toBeLessThan(completedIdx);
	});

	test("renders CouchbaseFindingsCard when message has couchbase findings", () => {
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map([
				[
					"couchbase",
					{
						status: "success",
						couchbaseFindings: {
							slowQueries: [{ statement: "SELECT FROM bucket OFFSET 100000", avgServiceTime: "9.93s" }],
						},
					},
				],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).toContain("Couchbase findings");
		expect(body).toContain("SELECT FROM bucket");
	});

	test("renders GitLabFindingsCard when message has gitlab findings", () => {
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map([
				[
					"gitlab",
					{
						status: "success",
						gitlabFindings: {
							mergedRequests: [{ id: 361, title: "Merge release/AMS-2026", merged_at: "2026-05-05T14:23:18Z" }],
						},
					},
				],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).toContain("GitLab findings");
		expect(body).toContain("2026-05-05");
	});

	test("renders ElasticFindingsCard when message has elastic findings", () => {
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map([
				[
					"elastic",
					{
						status: "success",
						elasticFindings: {
							syntheticMonitors: [{ name: "ksql-prd-healthcheck", status: "up" }],
						},
					},
				],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).toContain("Elastic findings");
		expect(body).toContain("ksql-prd-healthcheck");
	});

	test("renders multiple findings cards in stable order (kafka, couchbase, gitlab, elastic)", () => {
		const message: ChatMessageType = {
			...baseAssistant,
			dataSourceFindings: new Map<string, import("$lib/stores/agent-reducer").DataSourceFindings>([
				["kafka", { status: "success", kafkaFindings: { cluster: { provider: "msk", brokerCount: 3 } } }],
				[
					"couchbase",
					{ status: "success", couchbaseFindings: { slowQueries: [{ statement: "SELECT X", avgServiceTime: "1s" }] } },
				],
				[
					"gitlab",
					{
						status: "success",
						gitlabFindings: { mergedRequests: [{ id: 1, title: "T", merged_at: "2026-05-05T00:00:00Z" }] },
					},
				],
				["elastic", { status: "success", elasticFindings: { syntheticMonitors: [{ name: "m", status: "up" }] } }],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		const kafkaIdx = body.indexOf("Kafka findings");
		const couchIdx = body.indexOf("Couchbase findings");
		const gitlabIdx = body.indexOf("GitLab findings");
		const elasticIdx = body.indexOf("Elastic findings");
		expect(kafkaIdx).toBeGreaterThan(-1);
		expect(couchIdx).toBeGreaterThan(kafkaIdx);
		expect(gitlabIdx).toBeGreaterThan(couchIdx);
		expect(elasticIdx).toBeGreaterThan(gitlabIdx);
	});

	test("KafkaFindingsCard appears AFTER the markdown content", () => {
		// Card is a sibling of the markdown content's container, rendered after it.
		const message: ChatMessageType = {
			...baseAssistant,
			content: "## Incident Report\n\nMARKDOWN_MARKER",
			dataSourceFindings: new Map([
				[
					"kafka",
					{
						status: "success",
						kafkaFindings: {
							consumerGroups: [{ id: "notification-service", state: "STABLE", totalLag: 0 }],
						},
					},
				],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		const markdownIdx = body.indexOf("MARKDOWN_MARKER");
		const cardIdx = body.indexOf("Kafka findings");
		expect(markdownIdx).toBeGreaterThan(-1);
		expect(cardIdx).toBeGreaterThan(-1);
		expect(cardIdx).toBeGreaterThan(markdownIdx);
	});
});

// SIO-934: the CompletedProgress trace chip must render whenever the message has ANY
// content for it -- crucially including pipeline nodes alone (an elastic-iac turn carries
// completedNodes but no responseTime/toolsUsed/dataSources). The old gate omitted
// completedNodes/outcome, so those turns showed no trace at all. ChatMessage now just
// gates on !isStreaming and lets CompletedProgress.hasContent decide.
describe("CompletedProgress trace gate (SIO-934)", () => {
	test("renders the trace chip for a completedNodes-only message (no responseTime/tools/findings)", () => {
		const message: ChatMessageType = {
			role: "assistant",
			content: "MR opened: https://gitlab.example/mr/1",
			completedNodes: new Map([
				["parseIntent", { duration: 1200 }],
				["openMr", { duration: 800 }],
			]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		// Default outcome chip label.
		expect(body).toContain("Completed");
	});

	test("renders the amber 'Blocked' chip for a blocked outcome with nodes", () => {
		const message: ChatMessageType = {
			role: "assistant",
			content: "No change needed.",
			completedNodes: new Map([["draftChange", { duration: 1224 }]]),
			outcome: "blocked",
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).toContain("Blocked");
		// A blocked turn must NOT show the green "Completed" label.
		expect(body).not.toContain("Completed");
	});

	test("renders the 'Plan rejected' chip for a rejected resume turn", () => {
		// Mirrors a resumeIac turn after the user rejects the plan-review gate.
		const message: ChatMessageType = {
			role: "assistant",
			content: "Plan rejected. No merge request opened.",
			completedNodes: new Map([
				["parseIntent", { duration: 900 }],
				["reviewPlan", { duration: 1500 }],
			]),
			responseTime: 8000,
			outcome: "rejected",
		};
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).toContain("Plan rejected");
	});

	test("renders NO trace chip for an empty assistant message (no nodes/time/tools/findings)", () => {
		// Guards against over-loosening the gate: a bare message must not sprout a chip.
		const message: ChatMessageType = { role: "assistant", content: "Just a sentence." };
		const { body } = render(ChatMessage, { props: { message, index: 0 } });
		expect(body).not.toContain("Completed");
		expect(body).not.toContain("Blocked");
	});

	test("renders no trace chip while streaming even when nodes exist", () => {
		const message: ChatMessageType = {
			role: "assistant",
			content: "streaming...",
			completedNodes: new Map([["parseIntent", { duration: 900 }]]),
		};
		const { body } = render(ChatMessage, { props: { message, index: 0, isStreaming: true, isLast: true } });
		expect(body).not.toContain("Completed");
	});
});
