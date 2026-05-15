// src/services/client-factory.ts
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { HealthClient } from "@aws-sdk/client-health";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { RDSClient } from "@aws-sdk/client-rds";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { XRayClient } from "@aws-sdk/client-xray";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "./credentials.ts";

// Module-level singleton cache. One client per service per process.
// Each client carries its own credential cache via fromTemporaryCredentials,
// so reusing the client keeps the cache warm.
const clients = new Map<string, unknown>();

// Config is captured at first call; subsequent calls with different configs are
// ignored. Single-config-per-process is enforced at bootstrap (SIO-758).
function lazyClient<T>(key: string, ctor: () => T): T {
	if (!clients.has(key)) {
		clients.set(key, ctor());
	}
	return clients.get(key) as T;
}

function commonConfig(config: AwsConfig) {
	return {
		region: config.region,
		credentials: buildAssumedCredsProvider(config),
		maxAttempts: 3,
	};
}

export function getCloudFormationClient(config: AwsConfig): CloudFormationClient {
	return lazyClient("cloudformation", () => new CloudFormationClient(commonConfig(config)));
}
export function getCloudWatchClient(config: AwsConfig): CloudWatchClient {
	return lazyClient("cloudwatch", () => new CloudWatchClient(commonConfig(config)));
}
export function getCloudWatchLogsClient(config: AwsConfig): CloudWatchLogsClient {
	return lazyClient("logs", () => new CloudWatchLogsClient(commonConfig(config)));
}
export function getConfigServiceClient(config: AwsConfig): ConfigServiceClient {
	return lazyClient("config", () => new ConfigServiceClient(commonConfig(config)));
}
export function getDynamoDbClient(config: AwsConfig): DynamoDBClient {
	return lazyClient("dynamodb", () => new DynamoDBClient(commonConfig(config)));
}
export function getEc2Client(config: AwsConfig): EC2Client {
	return lazyClient("ec2", () => new EC2Client(commonConfig(config)));
}
export function getEcsClient(config: AwsConfig): ECSClient {
	return lazyClient("ecs", () => new ECSClient(commonConfig(config)));
}
export function getElastiCacheClient(config: AwsConfig): ElastiCacheClient {
	return lazyClient("elasticache", () => new ElastiCacheClient(commonConfig(config)));
}
export function getEventBridgeClient(config: AwsConfig): EventBridgeClient {
	return lazyClient("eventbridge", () => new EventBridgeClient(commonConfig(config)));
}
// AWS Health API requires the us-east-1 endpoint regardless of which region the
// agent is deployed in. Override the region here, not in callers.
export function getHealthClient(config: AwsConfig): HealthClient {
	return lazyClient("health", () => new HealthClient({ ...commonConfig(config), region: "us-east-1" }));
}
export function getLambdaClient(config: AwsConfig): LambdaClient {
	return lazyClient("lambda", () => new LambdaClient(commonConfig(config)));
}
export function getRdsClient(config: AwsConfig): RDSClient {
	return lazyClient("rds", () => new RDSClient(commonConfig(config)));
}
export function getResourceGroupsTaggingClient(config: AwsConfig): ResourceGroupsTaggingAPIClient {
	return lazyClient("tags", () => new ResourceGroupsTaggingAPIClient(commonConfig(config)));
}
export function getS3Client(config: AwsConfig): S3Client {
	return lazyClient("s3", () => new S3Client(commonConfig(config)));
}
export function getSfnClient(config: AwsConfig): SFNClient {
	return lazyClient("sfn", () => new SFNClient(commonConfig(config)));
}
export function getSnsClient(config: AwsConfig): SNSClient {
	return lazyClient("sns", () => new SNSClient(commonConfig(config)));
}
export function getSqsClient(config: AwsConfig): SQSClient {
	return lazyClient("sqs", () => new SQSClient(commonConfig(config)));
}
export function getXrayClient(config: AwsConfig): XRayClient {
	return lazyClient("xray", () => new XRayClient(commonConfig(config)));
}

// Test-only: reset the singleton cache.
export function _resetClientsForTests(): void {
	clients.clear();
}
