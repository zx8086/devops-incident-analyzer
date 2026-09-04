// apps/web/src/lib/components/ActionConfirmationCard.test.ts
// SIO-1635: SSR shape checks for the pi-coms verify / investigate cards. The
// approve and dismiss handlers are runes-driven and are covered by the manual e2e.
import { describe, expect, test } from "bun:test";
import type { ActionResult, PendingAction } from "@devops-agent/shared";
import { render } from "svelte/server";
import ActionConfirmationCard from "./ActionConfirmationCard.svelte";

const noop = () => undefined;

const verifyAction: PendingAction = {
	id: "a1",
	tool: "verify-with-pi",
	params: { estate: "estate-1", target: "estate-1-agent", severity: "high", summary: "ALB 5xx spike on checkout." },
	reason: "Verify the report's AWS claims for estate estate-1.",
};

describe("ActionConfirmationCard pi-coms", () => {
	test("pending verify card shows estate, agent and summary", () => {
		const { body } = render(ActionConfirmationCard, {
			props: { action: verifyAction, onApprove: noop, onDismiss: noop },
		});
		expect(body).toContain("Verify with pi agent");
		expect(body).toContain("estate-1");
		expect(body).toContain("estate-1-agent");
		expect(body).toContain("ALB 5xx spike on checkout.");
		expect(body).toContain("Approve");
	});

	test("pending investigate card lists the open questions", () => {
		const action: PendingAction = {
			id: "a2",
			tool: "investigate-with-pi",
			params: { estate: "estate-1", focus: ["unverifiable: draining caused it", "recommended: check ECS events"] },
			reason: "r",
		};
		const { body } = render(ActionConfirmationCard, { props: { action, onApprove: noop, onDismiss: noop } });
		expect(body).toContain("Launch pi investigation");
		expect(body).toContain("Open questions");
		expect(body).toContain("unverifiable: draining caused it");
		expect(body).toContain("recommended: check ECS events");
	});

	test("verdict result renders the verdict chip, claims and evidence", () => {
		const result: ActionResult = {
			actionId: "a1",
			tool: "verify-with-pi",
			status: "success",
			result: {
				kind: "verdict",
				target: "estate-1-agent",
				estate: "estate-1",
				msg_id: "m1",
				verdict: {
					verdict: "partially_confirmed",
					summary: "Spike confirmed, cause not observed.",
					claims: [
						{ claim: "ALB 5xx spike at 10:02", status: "confirmed", evidence: "HTTPCode_ELB_5XX_Count" },
						{ claim: "target group draining caused it", status: "contradicted", evidence: "no deregistrations" },
					],
					additional_observations: ["ECS deploy at 10:00"],
					recommended_investigation: "Check ECS service events.",
				},
			},
		};
		const { body } = render(ActionConfirmationCard, {
			props: { action: verifyAction, onApprove: noop, onDismiss: noop, result },
		});
		expect(body).toContain("partially confirmed");
		expect(body).toContain("Spike confirmed, cause not observed.");
		expect(body).toContain("contradicted");
		expect(body).toContain("no deregistrations");
		expect(body).toContain("ECS deploy at 10:00");
		expect(body).toContain("Check ECS service events.");
		expect(body).not.toContain("Approve");
	});

	test("investigation result renders hypothesis, evidence and actions", () => {
		const action: PendingAction = {
			id: "a2",
			tool: "investigate-with-pi",
			params: { estate: "estate-1", focus: [] },
			reason: "r",
		};
		const result: ActionResult = {
			actionId: "a2",
			tool: "investigate-with-pi",
			status: "success",
			result: {
				kind: "investigation",
				target: "estate-1-agent",
				estate: "estate-1",
				msg_id: "m2",
				investigation: {
					summary: "All tasks replaced at once.",
					root_cause_hypothesis: "minimumHealthyPercent 0",
					evidence: [{ resource: "ecs:service/checkout", observation: "deployment config minimumHealthyPercent=0" }],
					suggested_actions: ["Set minimumHealthyPercent to 100"],
					confidence: 0.8,
				},
			},
		};
		const { body } = render(ActionConfirmationCard, { props: { action, onApprove: noop, onDismiss: noop, result } });
		expect(body).toContain("confidence 80%");
		expect(body).toContain("minimumHealthyPercent 0");
		expect(body).toContain("ecs:service/checkout");
		expect(body).toContain("Set minimumHealthyPercent to 100");
	});

	test("queued result explains the mailbox fallback", () => {
		const result: ActionResult = {
			actionId: "a1",
			tool: "verify-with-pi",
			status: "success",
			result: { kind: "queued", target: "ops", estate: "estate-1", msg_id: "m3" },
		};
		const { body } = render(ActionConfirmationCard, {
			props: { action: verifyAction, onApprove: noop, onDismiss: noop, result },
		});
		expect(body).toContain("Queued to ops mailbox");
		expect(body).toContain("m3");
	});

	test("error result falls back to the generic failure banner", () => {
		const result: ActionResult = {
			actionId: "a1",
			tool: "verify-with-pi",
			status: "error",
			error: "hub 403 not_owner",
		};
		const { body } = render(ActionConfirmationCard, {
			props: { action: verifyAction, onApprove: noop, onDismiss: noop, result },
		});
		expect(body).toContain("Failed");
		expect(body).toContain("hub 403 not_owner");
	});

	test("slack card is unchanged", () => {
		const action: PendingAction = {
			id: "s1",
			tool: "notify-slack",
			params: { channel: "#inc", message: "hello", severity: "high" },
			reason: "r",
		};
		const { body } = render(ActionConfirmationCard, { props: { action, onApprove: noop, onDismiss: noop } });
		expect(body).toContain("Send Slack Notification");
		expect(body).toContain("#inc");
	});
});
