// agent/src/action-tools/slack-notifier.ts
import { SlackConfigSchema } from "@devops-agent/shared";
import { WebClient } from "@slack/web-api";

const SEVERITY_COLORS: Record<string, string> = {
	critical: "#E01E5A",
	high: "#E87722",
	medium: "#ECB22E",
	low: "#2EB67D",
	info: "#36C5F0",
};

export function getSeverityColor(severity: string): string {
	return SEVERITY_COLORS[severity] ?? (SEVERITY_COLORS.info as string);
}

export function isSlackConfigured(): boolean {
	return !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_DEFAULT_CHANNEL;
}

function getSlackConfig() {
	return SlackConfigSchema.parse({
		botToken: process.env.SLACK_BOT_TOKEN,
		defaultChannel: process.env.SLACK_DEFAULT_CHANNEL,
	});
}

export async function executeSlackNotify(params: {
	channel: string;
	message: string;
	severity: string;
	thread_ts?: string;
	reportContent?: string;
}): Promise<{ sent: boolean; timestamp: string; channel: string }> {
	const config = getSlackConfig();
	const client = new WebClient(config.botToken);
	const channel = params.channel || config.defaultChannel;
	const color = getSeverityColor(params.severity);
	const severityLabel = params.severity.toUpperCase();

	try {
		const result = await client.chat.postMessage({
			channel,
			text: `[${severityLabel}] ${params.message}`,
			...(params.thread_ts && { thread_ts: params.thread_ts }),
			attachments: [
				{
					color,
					blocks: [
						{
							type: "section",
							text: { type: "mrkdwn", text: params.message },
						},
						{
							type: "context",
							elements: [
								{ type: "mrkdwn", text: `Severity: *${severityLabel}*` },
							],
						},
					],
				},
			],
		});

		if (params.reportContent && result.ts) {
			await client.files.uploadV2({
				channel_id: String(result.channel),
				content: params.reportContent,
				filename: "incident-report.md",
				title: "Full Incident Report",
				thread_ts: result.ts,
			});
		}

		return {
			sent: true,
			timestamp: String(result.ts ?? ""),
			channel: String(result.channel ?? ""),
		};
	} catch {
		return { sent: false, timestamp: "", channel: "" };
	}
}
