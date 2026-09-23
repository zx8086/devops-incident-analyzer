// packages/agent/src/landing-zone/telemetry.ts

import { type LandingZoneTurnTelemetry, LandingZoneTurnTelemetrySchema } from "@devops-agent/shared";
import type { LandingZoneStateType } from "./state.ts";

export type { LandingZoneTurnTelemetry };
export { LandingZoneTurnTelemetrySchema };

function availability(
	value: LandingZoneStateType["gitlabEvidence"],
): LandingZoneTurnTelemetry["evidenceAvailability"]["gitlab"] {
	return value?.status ?? "not-attempted";
}

function repositoryName(value: string): string | undefined {
	const name = value.split("/").at(-1)?.toLowerCase();
	return name && /^[a-z0-9][a-z0-9-]{0,99}$/.test(name) ? name : undefined;
}

export function projectLandingZoneTurnTelemetry(state: LandingZoneStateType): LandingZoneTurnTelemetry {
	const repositories = [
		...new Set(state.repositoryScope.map(repositoryName).filter((name): name is string => name !== undefined)),
	].sort();

	return LandingZoneTurnTelemetrySchema.parse({
		agent: "landing-zone-terraform",
		intent: state.intent,
		repositories,
		evidenceAvailability: {
			gitlab: availability(state.gitlabEvidence),
			okf: availability(state.okfEvidence),
			terraformDocs: availability(state.terraformDocsEvidence),
			awsDocs: availability(state.awsDocsEvidence),
			awsApi: availability(state.awsApiEvidence),
			memory: availability(state.memoryEvidence),
			knowledgeGraph: availability(state.knowledgeGraphEvidence),
		},
		riskTier: state.risk?.level ?? "unassessed",
		outcome: state.outcome,
		graphUsed: true,
		memoryUsed: state.memoryEvidence?.status === "collected",
		knowledgeGraphUsed: state.knowledgeGraphEvidence?.status === "collected",
	});
}
