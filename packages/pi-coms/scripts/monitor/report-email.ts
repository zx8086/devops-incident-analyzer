// scripts/monitor/report-email.ts
// SIO-1821: the daily digest and the weekly suppression review also reach an
// inbox, via a project-owned SNS topic with an email subscription.
//
// This is a FAN-OUT, never a replacement. The hub mailbox stays the system of
// record: it is durable (sqlite store-and-forward), has a 14-day TTL and the
// queueUnsent retry behind it. SNS is a fire-and-forget bus with NO retention
// of its own (verified against a live topic: the attribute does not exist on a
// standard topic, and the FIFO ArchivePolicy replays only to SQS/Firehose,
// never re-sending email). So a failed publish costs one email and nothing
// else, and must never surface as an error.
//
// SES was rejected deliberately: it is in sandbox with zero verified identities
// in both probed accounts, so it cannot mail anyone today, and the digest is
// plain text that needs none of its strengths.

import { PublishCommand } from "@aws-sdk/client-sns";

// Structural subset of the SNS client, matching the AwsClient idiom used by the
// checks: the command decides the shape, so nothing here needs the real SDK.
export interface SnsLike {
	send(cmd: unknown): Promise<unknown>;
}

// SNS hard limits.
const MAX_SUBJECT = 100;
const MAX_MESSAGE = 262_144;

// An SNS TOPIC arn specifically: five colon-separated fields after "arn:aws:sns".
// A subscription ARN has a sixth and would be accepted by a looser check, then
// fail on every publish.
const TOPIC_ARN = /^arn:aws[\w-]*:sns:[a-z0-9-]+:\d{12}:[\w-]+$/;

// A misconfigured variable disables the feature rather than breaking the
// monitor: losing the email is recoverable, losing the digest is not.
export function snsTopicFromEnv(value: string | undefined): string | null {
	const arn = (value ?? "").trim();
	if (arn === "") return null;
	return TOPIC_ARN.test(arn) ? arn : null;
}

// The report's first line is `[sev] aws-<account> <what>`, which is exactly what
// an inbox list view should show without the reader opening the mail.
export function subjectFor(text: string): string {
	const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
	const subject = firstLine === "" ? "pi-coms monitor report" : firstLine;
	// Newlines are refused by SNS outright; the slice is belt-and-braces since
	// firstLine cannot contain one.
	const flat = subject.replace(/\s+/g, " ");
	return flat.length <= MAX_SUBJECT ? flat : `${flat.slice(0, MAX_SUBJECT - 3)}...`;
}

export async function publishReportToSns(sns: SnsLike, topicArn: string | null, text: string): Promise<void> {
	if (!topicArn) return;
	const marker = "\n\n[truncated: report exceeds the SNS message limit; full text is in the hub mailbox]";
	const message = text.length <= MAX_MESSAGE ? text : text.slice(0, MAX_MESSAGE - marker.length) + marker;
	try {
		await sns.send(new PublishCommand({ TopicArn: topicArn, Subject: subjectFor(text), Message: message }));
	} catch {
		// Deliberately silent to the caller. The mailbox copy has already been
		// sent (or queued) by the time this runs, so an SNS failure must not
		// fail the digest, and a throw here would abort the daily cycle.
	}
}
