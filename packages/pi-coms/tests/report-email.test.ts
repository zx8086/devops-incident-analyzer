// tests/report-email.test.ts
// SIO-1821: the daily digest and the weekly suppression review also go to an
// SNS topic, which fans out to an email subscription. The hub mailbox stays the
// system of record (14-day TTL + the queueUnsent retry), so this is a FAN-OUT:
// a failed publish must never lose a report or break the cycle.
import { describe, expect, test } from "bun:test";
import { publishReportToSns, snsTopicFromEnv } from "../scripts/monitor/report-email.ts";

type Sent = { TopicArn?: string; Subject?: string; Message?: string };

function fakeSns(onSend?: (input: Sent) => void) {
	const sent: Sent[] = [];
	return {
		sent,
		client: {
			async send(cmd: { input?: Sent }) {
				const input = cmd.input ?? {};
				sent.push(input);
				onSend?.(input);
				return {};
			},
		},
	};
}

const ARN = "arn:aws:sns:eu-central-1:399987695868:pi-coms-monitor-reports";

describe("snsTopicFromEnv", () => {
	test("an unset variable disables the feature", () => {
		expect(snsTopicFromEnv(undefined)).toBeNull();
		expect(snsTopicFromEnv("")).toBeNull();
		expect(snsTopicFromEnv("   ")).toBeNull();
	});

	test("a well-formed topic ARN is accepted", () => {
		expect(snsTopicFromEnv(ARN)).toBe(ARN);
		expect(snsTopicFromEnv(`  ${ARN}  `)).toBe(ARN);
	});

	// A typo must disable the feature rather than make every publish throw on a
	// production host. The monitor has no way to surface a config error except
	// its log, and losing the digest would be worse than losing the email.
	test("anything that is not an SNS topic ARN is rejected", () => {
		expect(snsTopicFromEnv("pi-coms-monitor-reports")).toBeNull();
		expect(snsTopicFromEnv("arn:aws:sqs:eu-central-1:1:queue")).toBeNull();
		expect(snsTopicFromEnv("arn:aws:sns:eu-central-1:399987695868:topic:subscription-id")).toBeNull();
	});
});

describe("publishReportToSns", () => {
	test("publishes the report body to the configured topic", async () => {
		const { client, sent } = fakeSns();
		await publishReportToSns(client, ARN, "[info] aws-123 daily digest (since 2026-09-18)\n\n- findings: none");
		expect(sent).toHaveLength(1);
		expect(sent[0].TopicArn).toBe(ARN);
		expect(sent[0].Message).toContain("- findings: none");
	});

	// The subject is what an inbox shows in its list view, so it has to carry
	// the severity and the account without the reader opening the mail.
	test("the subject names the severity and account from the report header", async () => {
		const { client, sent } = fakeSns();
		await publishReportToSns(client, ARN, "[warn] aws-399987695868 daily digest DEGRADED: 2 check error(s)\n\nbody");
		expect(sent[0].Subject).toContain("warn");
		expect(sent[0].Subject).toContain("aws-399987695868");
	});

	// SNS rejects a subject over 100 chars, and rejects newlines in it outright.
	test("the subject is capped and single-line even for a long header", async () => {
		const { client, sent } = fakeSns();
		const header = `[critical] aws-1 ${"x".repeat(300)}`;
		await publishReportToSns(client, ARN, `${header}\n\nbody`);
		const subject = sent[0].Subject ?? "";
		expect(subject.length).toBeLessThanOrEqual(100);
		expect(subject).not.toContain("\n");
	});

	test("a report with no recognisable header still gets a usable subject", async () => {
		const { client, sent } = fakeSns();
		await publishReportToSns(client, ARN, "no header here");
		expect((sent[0].Subject ?? "").length).toBeGreaterThan(0);
		expect(sent[0].Message).toBe("no header here");
	});

	// SNS caps a message at 256 KiB; a huge digest must be truncated rather
	// than rejected, and the truncation must be visible to the reader.
	test("an oversized report is truncated with a marker instead of being refused", async () => {
		const { client, sent } = fakeSns();
		await publishReportToSns(client, ARN, `[info] aws-1 digest\n\n${"y".repeat(300_000)}`);
		const msg = sent[0].Message ?? "";
		expect(msg.length).toBeLessThanOrEqual(262_144);
		expect(msg).toContain("truncated");
	});

	// The load-bearing guarantee: email is best-effort, the mailbox is not.
	test("a publish failure is swallowed, never thrown", async () => {
		const client = {
			async send() {
				throw new Error("AccessDenied: not authorized to perform sns:Publish");
			},
		};
		await expect(publishReportToSns(client, ARN, "[info] aws-1 digest")).resolves.toBeUndefined();
	});

	test("a null topic publishes nothing at all", async () => {
		const { client, sent } = fakeSns();
		await publishReportToSns(client, null, "[info] aws-1 digest");
		expect(sent).toHaveLength(0);
	});
});
