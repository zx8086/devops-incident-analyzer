// apps/web/src/lib/server/landing-zone-config.ts

import { z } from "zod";

const accountIdSchema = z.string().regex(/^\d{12}$/, "must be a 12-digit AWS account ID");
const accountListSchema = z.array(accountIdSchema).max(100);

export function landingZoneTopologyAccounts(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.LANDING_ZONE_TOPOLOGY_ACCOUNT_IDS?.trim();
	if (!raw) return [];
	const accountIds = raw
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return [...new Set(accountListSchema.parse(accountIds))].sort();
}
