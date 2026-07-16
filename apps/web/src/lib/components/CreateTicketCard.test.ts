// apps/web/src/lib/components/CreateTicketCard.test.ts
// SIO-1124: SSR shape checks for the inline create-ticket form. Interactive
// behavior (debounced fetches, submit) is exercised via the route tests and
// the manual e2e; runes stores and fetch flows are not unit-testable here.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import CreateTicketCard from "./CreateTicketCard.svelte";

const providers = [{ id: "jira" as const, label: "Jira" }];

describe("CreateTicketCard", () => {
	test("renders the form with prefilled summary and description", () => {
		const { body } = render(CreateTicketCard, {
			props: {
				content: "## Kafka Lag Incident\n\nConsumer lag detected.",
				providers,
				onClose: () => undefined,
			},
		});
		expect(body).toContain("Create Jira ticket");
		expect(body).toContain("Kafka Lag Incident");
		expect(body).toContain("Consumer lag detected.");
		expect(body).toContain("Unassigned");
		expect(body).toContain("Select a project");
		expect(body).toContain("Epic");
	});

	test("renders nothing without a provider", () => {
		const { body } = render(CreateTicketCard, {
			props: { content: "report", providers: [], onClose: () => undefined },
		});
		expect(body).not.toContain("Create");
	});
});
