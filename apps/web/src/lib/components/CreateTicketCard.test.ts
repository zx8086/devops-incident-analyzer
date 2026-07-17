// apps/web/src/lib/components/CreateTicketCard.test.ts
// SIO-1124: SSR shape checks for the inline create-ticket form. Interactive
// behavior (project typeahead + local filtering, submit) is exercised via the
// route tests and the manual e2e; runes stores and fetch flows are not
// unit-testable here.
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
		// SIO-1139: the project field is now a typeahead input, not a <select>.
		expect(body).toContain("Search projects...");
		expect(body).toContain("Epic");
	});

	test("renders nothing without a provider", () => {
		const { body } = render(CreateTicketCard, {
			props: { content: "report", providers: [], onClose: () => undefined },
		});
		expect(body).not.toContain("Create");
	});

	// SIO-1139: created state is owned by the parent; a card given a created
	// ticket shows the confirmation, never the form -- an answer yields one ticket.
	test("shows the confirmation (not the form) when a ticket already exists", () => {
		const { body } = render(CreateTicketCard, {
			props: {
				content: "report",
				providers,
				createdTicket: { key: "PAY-123", url: "https://example.atlassian.net/browse/PAY-123" },
				onClose: () => undefined,
			},
		});
		expect(body).toContain("Ticket created: PAY-123");
		expect(body).toContain("View");
		expect(body).not.toContain("Search projects...");
		expect(body).not.toContain("Create Jira ticket");
	});
});
