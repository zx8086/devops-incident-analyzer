// packages/agent/src/landing-zone/telemetry.ts

import { z } from "zod";
import type { LandingZoneStateType } from "./state.ts";

const EvidenceAvailabilitySchema = z.enum(["collected", "unavailable", "skipped", "not-attempted"]);

export const LandingZoneTurnTelemetrySchema = z
	.object({
		agent: z.literal("landing-zone-terraform"),
		intent: z.enum(["learn", "understand", "review", "propose-change"]),
		repositories: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/)).max(23),
		evidenceAvailability: z
			.object({
				gitlab: EvidenceAvailabilitySchema,
				okf: EvidenceAvailabilitySchema,
				terraformDocs: EvidenceAvailabilitySchema,
				awsDocs: EvidenceAvailabilitySchema,
				awsApi: EvidenceAvailabilitySchema,
				memory: EvidenceAvailabilitySchema,
				knowledgeGraph: EvidenceAvailabilitySchema,
			})
			.strict(),
		riskTier: z.enum(["low", "medium", "high", "blocked", "unassessed"]),
		outcome: z.enum(["pending", "answered", "blocked", "failed"]),
		graphUsed: z.literal(true),
		memoryUsed: z.boolean(),
		knowledgeGraphUsed: z.boolean(),
	})
	.strict();

export type LandingZoneTurnTelemetry = z.infer<typeof LandingZoneTurnTelemetrySchema>;

function availability(value: LandingZoneStateType["gitlabEvidence"]): z.infer<typeof EvidenceAvailabilitySchema> {
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
