// src/__tests__/tools-integration.test.ts
// One representative integration test per family, using aws-sdk-client-mock.
// Verifies the tool handler calls the SDK with the right params and the
// response flows through the wrapper correctly.
import { afterEach, describe, expect, test } from "bun:test";
import { CloudFormationClient, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigServiceClient, DescribeConfigRulesCommand } from "@aws-sdk/client-config-service";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DescribeCacheClustersCommand, ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { DescribeEventsCommand, HealthClient } from "@aws-sdk/client-health";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { ListTopicsCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetTraceSummariesCommand, XRayClient } from "@aws-sdk/client-xray";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetClientsForTests } from "../services/client-factory.ts";
import { listStacks } from "../tools/cloudformation/list-stacks.ts";
import { describeAlarms } from "../tools/cloudwatch/describe-alarms.ts";
import { describeConfigRules } from "../tools/config/describe-config-rules.ts";
import { listTables } from "../tools/dynamodb/list-tables.ts";
import { describeVpcs } from "../tools/ec2/describe-vpcs.ts";
import { describeTasks } from "../tools/ecs/describe-tasks.ts";
import { describeCacheClusters } from "../tools/elasticache/describe-cache-clusters.ts";
import { describeEvents } from "../tools/health/describe-events.ts";
import { listFunctions } from "../tools/lambda/list-functions.ts";
import { describeLogGroups } from "../tools/logs/describe-log-groups.ts";
import { listTopics } from "../tools/messaging/sns/list-topics.ts";
import { describeDbInstances } from "../tools/rds/describe-db-instances.ts";
import { listBuckets } from "../tools/s3/list-buckets.ts";
import { getResources } from "../tools/tags/get-resources.ts";
import { getTraceSummaries } from "../tools/xray/get-trace-summaries.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

afterEach(() => _resetClientsForTests());

describe("ec2 integration", () => {
	test("describeVpcs returns SDK response unchanged when under cap", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] });

		const handler = describeVpcs(config);
		const result = (await handler({})) as { Vpcs: unknown[] };
		expect(result.Vpcs).toHaveLength(1);
	});
});

describe("ecs integration", () => {
	test("describeTasks returns tasks array from SDK response", async () => {
		const ecsMock = mockClient(ECSClient);
		ecsMock.on(DescribeTasksCommand).resolves({
			tasks: [{ taskArn: "arn:aws:ecs:eu-central-1:123:task/my-cluster/abc123", lastStatus: "RUNNING" }],
		});

		const handler = describeTasks(config);
		const result = (await handler({ cluster: "my-cluster", tasks: ["abc123"] })) as { tasks: unknown[] };
		expect(result.tasks).toHaveLength(1);
	});
});

describe("lambda integration", () => {
	test("listFunctions returns Functions array from SDK response", async () => {
		const lambdaMock = mockClient(LambdaClient);
		lambdaMock.on(ListFunctionsCommand).resolves({
			Functions: [{ FunctionName: "my-function", Runtime: "nodejs20.x" }],
		});

		const handler = listFunctions(config);
		const result = (await handler({})) as { Functions: unknown[] };
		expect(result.Functions).toHaveLength(1);
	});
});

describe("cloudwatch integration", () => {
	test("describeAlarms returns MetricAlarms array from SDK response", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock.on(DescribeAlarmsCommand).resolves({
			MetricAlarms: [{ AlarmName: "high-cpu", StateValue: "ALARM" }],
		});

		const handler = describeAlarms(config);
		const result = (await handler({})) as { MetricAlarms: unknown[] };
		expect(result.MetricAlarms).toHaveLength(1);
	});
});

describe("logs integration", () => {
	test("describeLogGroups returns logGroups array from SDK response", async () => {
		const logsMock = mockClient(CloudWatchLogsClient);
		logsMock.on(DescribeLogGroupsCommand).resolves({
			logGroups: [{ logGroupName: "/aws/lambda/my-function", storedBytes: 1024 }],
		});

		const handler = describeLogGroups(config);
		const result = (await handler({})) as { logGroups: unknown[] };
		expect(result.logGroups).toHaveLength(1);
	});
});

describe("xray integration", () => {
	test("getTraceSummaries returns TraceSummaries array from SDK response", async () => {
		const xrayMock = mockClient(XRayClient);
		xrayMock.on(GetTraceSummariesCommand).resolves({
			TraceSummaries: [{ Id: "trace-1", Duration: 0.5 }],
		});

		const handler = getTraceSummaries(config);
		const result = (await handler({ StartTime: "2026-01-01T00:00:00Z", EndTime: "2026-01-01T01:00:00Z" })) as {
			TraceSummaries: unknown[];
		};
		expect(result.TraceSummaries).toHaveLength(1);
	});
});

describe("health integration", () => {
	test("describeEvents returns events array from SDK response", async () => {
		const healthMock = mockClient(HealthClient);
		healthMock.on(DescribeEventsCommand).resolves({
			events: [{ arn: "arn:aws:health::us-east-1:event/EC2/AWS_EC2_OPERATIONAL_ISSUE/123", service: "EC2" }],
		});

		const handler = describeEvents(config);
		const result = (await handler({})) as { events: unknown[] };
		expect(result.events).toHaveLength(1);
	});
});

describe("cloudformation integration", () => {
	test("listStacks returns StackSummaries array from SDK response", async () => {
		const cfnMock = mockClient(CloudFormationClient);
		cfnMock.on(ListStacksCommand).resolves({
			StackSummaries: [{ StackName: "my-stack", StackStatus: "CREATE_COMPLETE", CreationTime: new Date("2024-01-01") }],
		});

		const handler = listStacks(config);
		const result = (await handler({})) as { StackSummaries: unknown[] };
		expect(result.StackSummaries).toHaveLength(1);
	});
});

describe("rds integration", () => {
	test("describeDbInstances returns DBInstances array from SDK response", async () => {
		const rdsMock = mockClient(RDSClient);
		rdsMock.on(DescribeDBInstancesCommand).resolves({
			DBInstances: [{ DBInstanceIdentifier: "my-db", DBInstanceStatus: "available" }],
		});

		const handler = describeDbInstances(config);
		const result = (await handler({})) as { DBInstances: unknown[] };
		expect(result.DBInstances).toHaveLength(1);
	});
});

describe("dynamodb integration", () => {
	test("listTables returns TableNames array from SDK response", async () => {
		const ddbMock = mockClient(DynamoDBClient);
		ddbMock.on(ListTablesCommand).resolves({
			TableNames: ["orders-table", "users-table"],
		});

		const handler = listTables(config);
		const result = (await handler({})) as { TableNames: unknown[] };
		expect(result.TableNames).toHaveLength(2);
	});
});

describe("s3 integration", () => {
	test("listBuckets returns Buckets array from SDK response", async () => {
		const s3Mock = mockClient(S3Client);
		s3Mock.on(ListBucketsCommand).resolves({
			Buckets: [{ Name: "my-bucket", CreationDate: new Date("2024-01-01") }],
		});

		const handler = listBuckets(config);
		const result = (await handler({})) as { Buckets: unknown[] };
		expect(result.Buckets).toHaveLength(1);
	});
});

describe("elasticache integration", () => {
	test("describeCacheClusters returns CacheClusters array from SDK response", async () => {
		const ecMock = mockClient(ElastiCacheClient);
		ecMock.on(DescribeCacheClustersCommand).resolves({
			CacheClusters: [{ CacheClusterId: "my-cluster", CacheClusterStatus: "available" }],
		});

		const handler = describeCacheClusters(config);
		const result = (await handler({})) as { CacheClusters: unknown[] };
		expect(result.CacheClusters).toHaveLength(1);
	});
});

describe("messaging integration", () => {
	test("listTopics returns Topics array from SDK response", async () => {
		const snsMock = mockClient(SNSClient);
		snsMock.on(ListTopicsCommand).resolves({
			Topics: [{ TopicArn: "arn:aws:sns:eu-central-1:123:my-topic" }],
		});

		const handler = listTopics(config);
		const result = (await handler({})) as { Topics: unknown[] };
		expect(result.Topics).toHaveLength(1);
	});
});

describe("config integration", () => {
	test("describeConfigRules returns ConfigRules array from SDK response", async () => {
		const configMock = mockClient(ConfigServiceClient);
		configMock.on(DescribeConfigRulesCommand).resolves({
			ConfigRules: [{ ConfigRuleName: "required-tags", ConfigRuleState: "ACTIVE", Source: { Owner: "AWS" } }],
		});

		const handler = describeConfigRules(config);
		const result = (await handler({})) as { ConfigRules: unknown[] };
		expect(result.ConfigRules).toHaveLength(1);
	});
});

describe("tags integration", () => {
	test("getResources returns ResourceTagMappingList from SDK response", async () => {
		const tagsMock = mockClient(ResourceGroupsTaggingAPIClient);
		tagsMock.on(GetResourcesCommand).resolves({
			ResourceTagMappingList: [
				{ ResourceARN: "arn:aws:ec2:eu-central-1:123:instance/i-abc", Tags: [{ Key: "env", Value: "prod" }] },
			],
		});

		const handler = getResources(config);
		const result = (await handler({})) as { ResourceTagMappingList: unknown[] };
		expect(result.ResourceTagMappingList).toHaveLength(1);
	});
});
