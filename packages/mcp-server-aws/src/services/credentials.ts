// src/services/credentials.ts
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsConfig } from "../config/schemas.ts";

// One place where AssumeRole is wired. Every SDK client below gets this provider.
// The SDK caches assumed credentials and refreshes them automatically before expiry.
export function buildAssumedCredsProvider(config: AwsConfig): ReturnType<typeof fromTemporaryCredentials> {
	return fromTemporaryCredentials({
		params: {
			RoleArn: config.assumedRoleArn,
			ExternalId: config.externalId,
			RoleSessionName: "aws-mcp-server",
			DurationSeconds: 3600,
		},
		clientConfig: { region: config.region },
		// Base creds default to the SDK's standard chain (env vars / shared config /
		// instance metadata). AgentCore: execution role; locally: dev profile.
	});
}
