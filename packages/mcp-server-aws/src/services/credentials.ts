// src/services/credentials.ts
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { EstateConfig } from "../config/schemas.ts";

// One place where AssumeRole is wired. Every SDK client gets a provider built
// here. The SDK caches assumed credentials and refreshes them automatically
// before expiry. Stateless: caller decides which estate config + region.
export function buildAssumedCredsProvider(
	estate: EstateConfig,
	region: string,
): ReturnType<typeof fromTemporaryCredentials> {
	return fromTemporaryCredentials({
		params: {
			RoleArn: estate.assumedRoleArn,
			ExternalId: estate.externalId,
			RoleSessionName: "aws-mcp-server",
			DurationSeconds: 3600,
		},
		clientConfig: { region },
		// Base creds default to the SDK's standard chain (env vars / shared config /
		// instance metadata). AgentCore: execution role; locally: dev profile.
	});
}
