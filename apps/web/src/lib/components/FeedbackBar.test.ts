// apps/web/src/lib/components/FeedbackBar.test.ts
// SIO-1124: the Create-ticket button renders only when a ticket provider is
// available (the onCreateTicket prop is supplied); the bar is unchanged otherwise.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import FeedbackBar from "./FeedbackBar.svelte";

const baseProps = {
	content: "## Incident Report",
	onFeedback: () => undefined,
};

describe("FeedbackBar", () => {
	test("renders the Create ticket button when onCreateTicket is provided", () => {
		const { body } = render(FeedbackBar, { props: { ...baseProps, onCreateTicket: () => undefined } });
		expect(body).toContain("Create ticket");
		expect(body).toContain("Copy");
	});

	test("omits the Create ticket button without onCreateTicket", () => {
		const { body } = render(FeedbackBar, { props: baseProps });
		expect(body).not.toContain("Create ticket");
		expect(body).toContain("Copy");
	});
});
