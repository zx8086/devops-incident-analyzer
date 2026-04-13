// shared/src/datasource.ts
import { z } from "zod";

export const ElasticDeploymentConfigSchema = z.object({
	id: z.string(),
	url: z.string().url(),
	apiKey: z.string().optional(),
	username: z.string().optional(),
	password: z.string().optional(),
	caCert: z.string().optional(),
	cloudId: z.string().optional(),
});
export type ElasticDeploymentConfig = z.infer<typeof ElasticDeploymentConfigSchema>;

export const KafkaProviderConfigSchema = z.object({
	provider: z.enum(["local", "msk", "confluent"]),
	brokers: z.array(z.string()),
	allowWrites: z.boolean(),
	allowDestructive: z.boolean(),
	schemaRegistryEnabled: z.boolean(),
	ksqlEnabled: z.boolean(),
});
export type KafkaProviderConfig = z.infer<typeof KafkaProviderConfigSchema>;

export const CapellaConfigSchema = z.object({
	hostname: z.string(),
	username: z.string(),
	password: z.string(),
	bucket: z.string(),
});
export type CapellaConfig = z.infer<typeof CapellaConfigSchema>;

export const KonnectConfigSchema = z.object({
	accessToken: z.string(),
	region: z.enum(["us", "eu", "au", "me", "in"]),
});
export type KonnectConfig = z.infer<typeof KonnectConfigSchema>;

export const GitLabConfigSchema = z.object({
	instanceUrl: z.string().url(),
	personalAccessToken: z.string().min(1),
	defaultProjectId: z.string().optional(),
});
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;

export const DATA_SOURCE_IDS = ["elastic", "kafka", "couchbase", "konnect", "gitlab"] as const;
export type DataSourceId = (typeof DATA_SOURCE_IDS)[number];
