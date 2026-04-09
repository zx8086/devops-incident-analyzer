// agent/src/action-tools/ticket-creator.ts
import { LinearConfigSchema } from "@devops-agent/shared";
import { LinearClient } from "@linear/sdk";

const SEVERITY_PRIORITY: Record<string, number> = {
	critical: 1,
	high: 2,
	medium: 3,
	low: 4,
};

export function severityToPriority(severity: string): number {
	return SEVERITY_PRIORITY[severity] ?? 3;
}

export function isLinearConfigured(): boolean {
	return !!process.env.LINEAR_API_KEY && !!process.env.LINEAR_TEAM_ID && !!process.env.LINEAR_PROJECT_ID;
}

function getLinearConfig() {
	return LinearConfigSchema.parse({
		apiKey: process.env.LINEAR_API_KEY,
		teamId: process.env.LINEAR_TEAM_ID,
		projectId: process.env.LINEAR_PROJECT_ID,
	});
}

export function buildTicketDescription(params: {
	description: string;
	affected_services?: string[];
	datasources_queried?: string[];
}): string {
	const sections: string[] = [];

	sections.push(`## Incident Summary\n\n${params.description}`);

	if (params.affected_services && params.affected_services.length > 0) {
		const items = params.affected_services.map((s) => `- ${s}`).join("\n");
		sections.push(`## Affected Services\n\n${items}`);
	}

	if (params.datasources_queried && params.datasources_queried.length > 0) {
		const items = params.datasources_queried.map((s) => `- ${s}`).join("\n");
		sections.push(`## Datasources Analyzed\n\n${items}`);
	}

	return sections.join("\n\n");
}

export async function executeCreateTicket(params: {
	title: string;
	description: string;
	severity: string;
	affected_services?: string[];
	datasources_queried?: string[];
	reportContent?: string;
}): Promise<{ ticket_id: string; url: string }> {
	const config = getLinearConfig();
	const client = new LinearClient({ apiKey: config.apiKey });

	const body = buildTicketDescription({
		description: params.description,
		affected_services: params.affected_services,
		datasources_queried: params.datasources_queried,
	});

	try {
		const issuePayload = await client.createIssue({
			teamId: config.teamId,
			projectId: config.projectId,
			title: params.title,
			description: body,
			priority: severityToPriority(params.severity),
		});

		const issue = await issuePayload.issue;
		if (!issue) {
			return { ticket_id: "", url: "" };
		}

		if (params.reportContent) {
			const dataUri = `data:text/markdown;base64,${Buffer.from(params.reportContent).toString("base64")}`;
			await client.createAttachment({
				issueId: issue.id,
				title: "Full Incident Report",
				url: dataUri,
			});
		}

		return {
			ticket_id: issue.identifier,
			url: issue.url,
		};
	} catch {
		return { ticket_id: "", url: "" };
	}
}
