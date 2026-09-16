// scripts/monitor/checks/queues.ts
import {
	GetQueueAttributesCommand,
	type GetQueueAttributesCommandOutput,
	ListQueuesCommand,
	type ListQueuesCommandOutput,
	QueueAttributeName,
} from "@aws-sdk/client-sqs";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1748: sqs:ListQueues/GetQueueAttributes were granted and unread.
//
// A queue holding messages is a queue doing its job, so depth is not a signal
// and is never reported on its own. What IS unambiguous is a dead-letter
// queue: a queue is a DLQ only because some other queue names it as its
// redrive target, and a message only arrives there after that queue's consumer
// failed it maxReceiveCount times. Depth on a DLQ therefore means messages
// have already been lost to a failure that has finished happening. That is a
// semantic discriminator, not a threshold, so it needs no baseline and no
// duration gate.
//
// Deliberately NOT here: source-queue backlog. "Behind" is only meaningful
// against that queue's own normal, and a batch queue that always trails by an
// hour is not an incident. That needs a self-baseline over the age of the
// oldest message, which is a CloudWatch metric (AWS/SQS
// ApproximateAgeOfOldestMessage) rather than a queue attribute -- so it is a
// GetMetricData walk in the checks/ingestion.ts shape, built on the rate this
// check's shadow run measures rather than on a guessed threshold.
const REALERT_MS = 86_400_000;
const PAGE = 1000;
const ATTRS: QueueAttributeName[] = [
	QueueAttributeName.QueueArn,
	QueueAttributeName.ApproximateNumberOfMessages,
	QueueAttributeName.ApproximateNumberOfMessagesNotVisible,
	QueueAttributeName.RedrivePolicy,
];

export type CheckQueuesOpts = { now?: number };

type QueueFacts = {
	url: string;
	arn: string | null;
	depth: number;
	inFlight: number;
	redriveTo: string | null;
	maxReceiveCount: number | null;
};

function nameOf(url: string): string {
	return url.split("/").pop() ?? url;
}

export function parseRedrive(raw: string | undefined): { arn: string | null; maxReceiveCount: number | null } {
	if (!raw) return { arn: null, maxReceiveCount: null };
	try {
		const p = JSON.parse(raw) as { deadLetterTargetArn?: string; maxReceiveCount?: number | string };
		return {
			arn: p.deadLetterTargetArn ?? null,
			maxReceiveCount: p.maxReceiveCount === undefined ? null : Number(p.maxReceiveCount),
		};
	} catch {
		// A redrive policy we cannot parse means we cannot classify that queue's
		// target as a DLQ. Staying silent is correct: inventing a DLQ from a
		// malformed policy would report on a queue that may be nothing of the sort.
		return { arn: null, maxReceiveCount: null };
	}
}

// Which queues are dead-letter queues, derived from what points AT them.
// Exported so the real-corpus test can drive it with production RedrivePolicy
// strings instead of a fake SQS client.
export function dlqSourcesByArn(
	queues: { url: string; redriveTo: string | null; maxReceiveCount: number | null }[],
): Map<string, { name: string; maxReceiveCount: number | null }[]> {
	const sourcesOf = new Map<string, { name: string; maxReceiveCount: number | null }[]>();
	for (const q of queues) {
		if (!q.redriveTo) continue;
		sourcesOf.set(q.redriveTo, [
			...(sourcesOf.get(q.redriveTo) ?? []),
			{ name: nameOf(q.url), maxReceiveCount: q.maxReceiveCount },
		]);
	}
	return sourcesOf;
}

export async function checkQueues(
	client: AwsClient,
	state: MonitorState,
	opts: CheckQueuesOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];

	const urls: string[] = [];
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(
			new ListQueuesCommand({ MaxResults: PAGE, NextToken: nextToken }),
		)) as ListQueuesCommandOutput;
		urls.push(...(resp.QueueUrls ?? []));
		nextToken = resp.NextToken;
	} while (nextToken);

	const queues: QueueFacts[] = [];
	for (const url of urls) {
		const resp = (await client.send(
			new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ATTRS }),
		)) as GetQueueAttributesCommandOutput;
		const a = resp.Attributes ?? {};
		const redrive = parseRedrive(a.RedrivePolicy);
		queues.push({
			url,
			arn: a.QueueArn ?? null,
			depth: Number(a.ApproximateNumberOfMessages ?? 0),
			inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
			redriveTo: redrive.arn,
			maxReceiveCount: redrive.maxReceiveCount,
		});
	}

	// A DLQ is defined by being pointed AT, so the set is built from every other
	// queue's redrive policy rather than from a name convention -- a queue called
	// "-dlq" that nothing redrives into is not a DLQ, and one called anything at
	// all that something redrives into is.
	const sourcesOf = dlqSourcesByArn(queues);

	const stillFailing = new Set<string>();
	for (const q of queues) {
		if (!q.arn) continue;
		const sources = sourcesOf.get(q.arn);
		if (!sources || q.depth === 0) continue;
		const name = nameOf(q.url);
		const key = `queues:${name}:dlq-depth`;
		stillFailing.add(key);
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "queues");
		findings.push({
			family: "queues",
			severity: "warn",
			resource: name,
			summary: `Dead-letter queue ${name} holds ${q.depth} message${q.depth === 1 ? "" : "s"} redriven from ${sources.map((s) => s.name).join(", ")}`,
			dedup_key: key,
			evidence: {
				queueUrl: q.url,
				queueArn: q.arn,
				depth: q.depth,
				inFlight: q.inFlight,
				// Naming the source queues points the diagnosis straight at the
				// consumer that failed, which is never the DLQ itself.
				redrivenFrom: sources,
			},
			at,
		});
	}

	// Recovery: a drained DLQ re-arms, so the next batch of failures alerts at
	// once rather than waiting out the re-alert window.
	for (const key of state.alertKeys("queues:")) {
		if (!stillFailing.has(key)) state.clearAlerts(key);
	}
	return findings;
}
