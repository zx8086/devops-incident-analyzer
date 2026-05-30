// src/services/client-factory.ts
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GuardDutyClient } from "@aws-sdk/client-guardduty";
import { HealthClient } from "@aws-sdk/client-health";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { RDSClient } from "@aws-sdk/client-rds";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { S3Client } from "@aws-sdk/client-s3";
import { SecurityHubClient } from "@aws-sdk/client-securityhub";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { XRayClient } from "@aws-sdk/client-xray";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "./credentials.ts";

// Module-level singleton cache keyed by `${service}:${estate}`. One client per
// (service, estate) pair per process. Each client carries its own credential
// cache via fromTemporaryCredentials, so reusing the client keeps the cache warm.
const clients = new Map<string, unknown>();

function resolveEstate(config: AwsConfig, estate: string) {
	const estateConfig = config.estates[estate];
	if (!estateConfig) {
		throw new Error(`Unknown estate "${estate}". Known: ${Object.keys(config.estates).join(", ")}`);
	}
	return estateConfig;
}

function commonConfig(config: AwsConfig, estate: string) {
	const estateConfig = resolveEstate(config, estate);
	// SIO-832: optional per-estate region override; falls back to the global AWS_REGION.
	// STS AssumeRole is region-agnostic, so the creds provider also gets the resolved
	// region for a consistent endpoint. (SIO-835: no estate sets an override today.)
	const region = estateConfig.region ?? config.region;
	return {
		region,
		credentials: buildAssumedCredsProvider(estateConfig, region),
		maxAttempts: 3,
	};
}

function lazyClient<T>(service: string, estate: string, ctor: () => T): T {
	const key = `${service}:${estate}`;
	if (!clients.has(key)) {
		clients.set(key, ctor());
	}
	return clients.get(key) as T;
}

export function getCloudFormationClient(config: AwsConfig, estate: string): CloudFormationClient {
	return lazyClient("cloudformation", estate, () => new CloudFormationClient(commonConfig(config, estate)));
}
export function getCloudWatchClient(config: AwsConfig, estate: string): CloudWatchClient {
	return lazyClient("cloudwatch", estate, () => new CloudWatchClient(commonConfig(config, estate)));
}
export function getCloudWatchLogsClient(config: AwsConfig, estate: string): CloudWatchLogsClient {
	return lazyClient("logs", estate, () => new CloudWatchLogsClient(commonConfig(config, estate)));
}
export function getCloudTrailClient(config: AwsConfig, estate: string): CloudTrailClient {
	return lazyClient("cloudtrail", estate, () => new CloudTrailClient(commonConfig(config, estate)));
}
export function getConfigServiceClient(config: AwsConfig, estate: string): ConfigServiceClient {
	return lazyClient("config", estate, () => new ConfigServiceClient(commonConfig(config, estate)));
}
export function getDynamoDbClient(config: AwsConfig, estate: string): DynamoDBClient {
	return lazyClient("dynamodb", estate, () => new DynamoDBClient(commonConfig(config, estate)));
}
export function getEc2Client(config: AwsConfig, estate: string): EC2Client {
	return lazyClient("ec2", estate, () => new EC2Client(commonConfig(config, estate)));
}
export function getEcsClient(config: AwsConfig, estate: string): ECSClient {
	return lazyClient("ecs", estate, () => new ECSClient(commonConfig(config, estate)));
}
export function getElastiCacheClient(config: AwsConfig, estate: string): ElastiCacheClient {
	return lazyClient("elasticache", estate, () => new ElastiCacheClient(commonConfig(config, estate)));
}
export function getEventBridgeClient(config: AwsConfig, estate: string): EventBridgeClient {
	return lazyClient("eventbridge", estate, () => new EventBridgeClient(commonConfig(config, estate)));
}
export function getGuardDutyClient(config: AwsConfig, estate: string): GuardDutyClient {
	return lazyClient("guardduty", estate, () => new GuardDutyClient(commonConfig(config, estate)));
}
// AWS Health API requires the us-east-1 endpoint regardless of which region the
// agent is deployed in. Override the region here, not in callers.
export function getHealthClient(config: AwsConfig, estate: string): HealthClient {
	return lazyClient("health", estate, () => new HealthClient({ ...commonConfig(config, estate), region: "us-east-1" }));
}
export function getLambdaClient(config: AwsConfig, estate: string): LambdaClient {
	return lazyClient("lambda", estate, () => new LambdaClient(commonConfig(config, estate)));
}
export function getRdsClient(config: AwsConfig, estate: string): RDSClient {
	return lazyClient("rds", estate, () => new RDSClient(commonConfig(config, estate)));
}
export function getResourceGroupsTaggingClient(config: AwsConfig, estate: string): ResourceGroupsTaggingAPIClient {
	return lazyClient("tags", estate, () => new ResourceGroupsTaggingAPIClient(commonConfig(config, estate)));
}
export function getS3Client(config: AwsConfig, estate: string): S3Client {
	return lazyClient("s3", estate, () => new S3Client(commonConfig(config, estate)));
}
export function getSecurityHubClient(config: AwsConfig, estate: string): SecurityHubClient {
	return lazyClient("securityhub", estate, () => new SecurityHubClient(commonConfig(config, estate)));
}
export function getSfnClient(config: AwsConfig, estate: string): SFNClient {
	return lazyClient("sfn", estate, () => new SFNClient(commonConfig(config, estate)));
}
export function getSnsClient(config: AwsConfig, estate: string): SNSClient {
	return lazyClient("sns", estate, () => new SNSClient(commonConfig(config, estate)));
}
export function getSqsClient(config: AwsConfig, estate: string): SQSClient {
	return lazyClient("sqs", estate, () => new SQSClient(commonConfig(config, estate)));
}
export function getStsClient(config: AwsConfig, estate: string): STSClient {
	return lazyClient("sts", estate, () => new STSClient(commonConfig(config, estate)));
}
export function getXrayClient(config: AwsConfig, estate: string): XRayClient {
	return lazyClient("xray", estate, () => new XRayClient(commonConfig(config, estate)));
}

export function _resetClientsForTests(): void {
	clients.clear();
}
