// src/__tests__/tools-smoke.test.ts
// One smoke test per tool: each tool's Zod paramsSchema parses valid input and
// rejects obviously invalid input. New families are appended below.
import { describe, expect, test } from "bun:test";
import { describeStackEventsSchema } from "../tools/cloudformation/describe-stack-events.ts";
import { describeStacksSchema } from "../tools/cloudformation/describe-stacks.ts";
import { listStacksSchema } from "../tools/cloudformation/list-stacks.ts";
import { describeAlarmsSchema } from "../tools/cloudwatch/describe-alarms.ts";
import { getMetricDataSchema } from "../tools/cloudwatch/get-metric-data.ts";
import { describeConfigRulesSchema } from "../tools/config/describe-config-rules.ts";
import { listDiscoveredResourcesSchema } from "../tools/config/list-discovered-resources.ts";
import { describeTableSchema } from "../tools/dynamodb/describe-table.ts";
import { listTablesSchema } from "../tools/dynamodb/list-tables.ts";
import { describeInstancesSchema } from "../tools/ec2/describe-instances.ts";
import { describeSecurityGroupsSchema } from "../tools/ec2/describe-security-groups.ts";
import { describeVpcsSchema } from "../tools/ec2/describe-vpcs.ts";
import { describeServicesSchema } from "../tools/ecs/describe-services.ts";
import { describeTasksSchema } from "../tools/ecs/describe-tasks.ts";
import { listClustersSchema } from "../tools/ecs/list-clusters.ts";
import { listTasksSchema } from "../tools/ecs/list-tasks.ts";
import { describeCacheClustersSchema } from "../tools/elasticache/describe-cache-clusters.ts";
import { describeReplicationGroupsSchema } from "../tools/elasticache/describe-replication-groups.ts";
import { describeEventsSchema } from "../tools/health/describe-events.ts";
import { getFunctionConfigurationSchema } from "../tools/lambda/get-function-configuration.ts";
import { listFunctionsSchema } from "../tools/lambda/list-functions.ts";
import { describeLogGroupsSchema } from "../tools/logs/describe-log-groups.ts";
import { getQueryResultsSchema } from "../tools/logs/get-query-results.ts";
import { startQuerySchema } from "../tools/logs/start-query.ts";
import { describeRuleSchema } from "../tools/messaging/eventbridge/describe-rule.ts";
import { listRulesSchema } from "../tools/messaging/eventbridge/list-rules.ts";
import { getTopicAttributesSchema } from "../tools/messaging/sns/get-topic-attributes.ts";
import { listTopicsSchema } from "../tools/messaging/sns/list-topics.ts";
import { getQueueAttributesSchema } from "../tools/messaging/sqs/get-queue-attributes.ts";
import { listQueuesSchema } from "../tools/messaging/sqs/list-queues.ts";
import { listStateMachinesSchema } from "../tools/messaging/stepfunctions/list-state-machines.ts";
import { describeDbClustersSchema } from "../tools/rds/describe-db-clusters.ts";
import { describeDbInstancesSchema } from "../tools/rds/describe-db-instances.ts";
import { getBucketLocationSchema } from "../tools/s3/get-bucket-location.ts";
import { getBucketPolicyStatusSchema } from "../tools/s3/get-bucket-policy-status.ts";
import { listBucketsSchema } from "../tools/s3/list-buckets.ts";
import { getResourcesSchema } from "../tools/tags/get-resources.ts";
import { getServiceGraphSchema } from "../tools/xray/get-service-graph.ts";
import { getTraceSummariesSchema } from "../tools/xray/get-trace-summaries.ts";

describe("ec2 tool param schemas", () => {
	test("describeVpcs accepts empty input", () => {
		expect(describeVpcsSchema.safeParse({}).success).toBe(true);
	});
	test("describeVpcs rejects non-array vpcIds", () => {
		expect(describeVpcsSchema.safeParse({ vpcIds: "vpc-1" }).success).toBe(false);
	});
	test("describeInstances accepts valid input", () => {
		expect(describeInstancesSchema.safeParse({ instanceIds: ["i-abc"] }).success).toBe(true);
	});
	test("describeInstances rejects maxResults below 5", () => {
		expect(describeInstancesSchema.safeParse({ maxResults: 1 }).success).toBe(false);
	});
	test("describeSecurityGroups accepts groupIds", () => {
		expect(describeSecurityGroupsSchema.safeParse({ groupIds: ["sg-1"] }).success).toBe(true);
	});
	test("describeSecurityGroups rejects non-array groupNames", () => {
		expect(describeSecurityGroupsSchema.safeParse({ groupNames: "default" }).success).toBe(false);
	});
});

describe("ecs tool param schemas", () => {
	test("listClusters accepts empty input", () => {
		expect(listClustersSchema.safeParse({}).success).toBe(true);
	});
	test("listClusters rejects non-integer maxResults", () => {
		expect(listClustersSchema.safeParse({ maxResults: 1.5 }).success).toBe(false);
	});
	test("describeServices accepts required fields", () => {
		expect(describeServicesSchema.safeParse({ cluster: "my-cluster", services: ["my-service"] }).success).toBe(true);
	});
	test("describeServices rejects missing services array", () => {
		expect(describeServicesSchema.safeParse({ cluster: "my-cluster" }).success).toBe(false);
	});
	test("describeTasks accepts required fields", () => {
		expect(describeTasksSchema.safeParse({ cluster: "my-cluster", tasks: ["task-id-1"] }).success).toBe(true);
	});
	test("describeTasks rejects missing cluster", () => {
		expect(describeTasksSchema.safeParse({ tasks: ["task-id-1"] }).success).toBe(false);
	});
	test("listTasks accepts required cluster", () => {
		expect(listTasksSchema.safeParse({ cluster: "my-cluster" }).success).toBe(true);
	});
	test("listTasks rejects missing cluster", () => {
		expect(listTasksSchema.safeParse({}).success).toBe(false);
	});
});

describe("lambda tool param schemas", () => {
	test("listFunctions accepts empty input", () => {
		expect(listFunctionsSchema.safeParse({}).success).toBe(true);
	});
	test("listFunctions rejects non-integer MaxItems", () => {
		expect(listFunctionsSchema.safeParse({ MaxItems: 1.5 }).success).toBe(false);
	});
	test("getFunctionConfiguration accepts FunctionName", () => {
		expect(getFunctionConfigurationSchema.safeParse({ FunctionName: "my-function" }).success).toBe(true);
	});
	test("getFunctionConfiguration rejects missing FunctionName", () => {
		expect(getFunctionConfigurationSchema.safeParse({}).success).toBe(false);
	});
});

describe("cloudwatch tool param schemas", () => {
	test("getMetricData accepts valid input", () => {
		expect(
			getMetricDataSchema.safeParse({
				MetricDataQueries: [{ Id: "m1", MetricStat: {} }],
				StartTime: "2026-01-01T00:00:00Z",
				EndTime: "2026-01-01T01:00:00Z",
			}).success,
		).toBe(true);
	});
	test("getMetricData rejects missing StartTime", () => {
		expect(
			getMetricDataSchema.safeParse({
				MetricDataQueries: [],
				EndTime: "2026-01-01T01:00:00Z",
			}).success,
		).toBe(false);
	});
	test("describeAlarms accepts empty input", () => {
		expect(describeAlarmsSchema.safeParse({}).success).toBe(true);
	});
	test("describeAlarms rejects non-array AlarmNames", () => {
		expect(describeAlarmsSchema.safeParse({ AlarmNames: "my-alarm" }).success).toBe(false);
	});
});

describe("logs tool param schemas", () => {
	test("describeLogGroups accepts empty input", () => {
		expect(describeLogGroupsSchema.safeParse({}).success).toBe(true);
	});
	test("describeLogGroups rejects non-integer limit", () => {
		expect(describeLogGroupsSchema.safeParse({ limit: 1.5 }).success).toBe(false);
	});
	test("startQuery accepts required fields", () => {
		expect(
			startQuerySchema.safeParse({
				logGroupNames: ["/aws/lambda/my-fn"],
				queryString: "fields @timestamp | limit 10",
				startTime: 1700000000000,
				endTime: 1700003600000,
			}).success,
		).toBe(true);
	});
	test("startQuery rejects non-integer startTime", () => {
		expect(
			startQuerySchema.safeParse({
				logGroupNames: ["/aws/lambda/my-fn"],
				queryString: "fields @timestamp",
				startTime: 1700000000.5,
				endTime: 1700003600000,
			}).success,
		).toBe(false);
	});
	test("getQueryResults accepts queryId", () => {
		expect(getQueryResultsSchema.safeParse({ queryId: "abc-123" }).success).toBe(true);
	});
	test("getQueryResults rejects missing queryId", () => {
		expect(getQueryResultsSchema.safeParse({}).success).toBe(false);
	});
});

describe("xray tool param schemas", () => {
	test("getServiceGraph accepts required fields", () => {
		expect(
			getServiceGraphSchema.safeParse({
				StartTime: "2026-01-01T00:00:00Z",
				EndTime: "2026-01-01T01:00:00Z",
			}).success,
		).toBe(true);
	});
	test("getServiceGraph rejects missing EndTime", () => {
		expect(getServiceGraphSchema.safeParse({ StartTime: "2026-01-01T00:00:00Z" }).success).toBe(false);
	});
	test("getTraceSummaries accepts required fields", () => {
		expect(
			getTraceSummariesSchema.safeParse({
				StartTime: "2026-01-01T00:00:00Z",
				EndTime: "2026-01-01T01:00:00Z",
			}).success,
		).toBe(true);
	});
	test("getTraceSummaries rejects missing StartTime", () => {
		expect(getTraceSummariesSchema.safeParse({ EndTime: "2026-01-01T01:00:00Z" }).success).toBe(false);
	});
});

describe("health tool param schemas", () => {
	test("describeEvents accepts empty input", () => {
		expect(describeEventsSchema.safeParse({}).success).toBe(true);
	});
	test("describeEvents rejects non-object filter", () => {
		expect(describeEventsSchema.safeParse({ filter: "services=EC2" }).success).toBe(false);
	});
});

describe("cloudformation tool param schemas", () => {
	test("listStacks accepts empty input", () => {
		expect(listStacksSchema.safeParse({}).success).toBe(true);
	});
	test("listStacks rejects non-array StackStatusFilter", () => {
		expect(listStacksSchema.safeParse({ StackStatusFilter: "CREATE_COMPLETE" }).success).toBe(false);
	});
	test("describeStacks accepts empty input", () => {
		expect(describeStacksSchema.safeParse({}).success).toBe(true);
	});
	test("describeStacks accepts StackName", () => {
		expect(describeStacksSchema.safeParse({ StackName: "my-stack" }).success).toBe(true);
	});
	test("describeStackEvents accepts required StackName", () => {
		expect(describeStackEventsSchema.safeParse({ StackName: "my-stack" }).success).toBe(true);
	});
	test("describeStackEvents rejects missing StackName", () => {
		expect(describeStackEventsSchema.safeParse({}).success).toBe(false);
	});
});

describe("rds tool param schemas", () => {
	test("describeDbInstances accepts empty input", () => {
		expect(describeDbInstancesSchema.safeParse({}).success).toBe(true);
	});
	test("describeDbInstances accepts DBInstanceIdentifier", () => {
		expect(describeDbInstancesSchema.safeParse({ DBInstanceIdentifier: "my-db" }).success).toBe(true);
	});
	test("describeDbClusters accepts empty input", () => {
		expect(describeDbClustersSchema.safeParse({}).success).toBe(true);
	});
	test("describeDbClusters rejects non-integer MaxRecords", () => {
		expect(describeDbClustersSchema.safeParse({ MaxRecords: 1.5 }).success).toBe(false);
	});
});

describe("dynamodb tool param schemas", () => {
	test("listTables accepts empty input", () => {
		expect(listTablesSchema.safeParse({}).success).toBe(true);
	});
	test("listTables rejects non-integer Limit", () => {
		expect(listTablesSchema.safeParse({ Limit: 1.5 }).success).toBe(false);
	});
	test("describeTable accepts TableName", () => {
		expect(describeTableSchema.safeParse({ TableName: "my-table" }).success).toBe(true);
	});
	test("describeTable rejects missing TableName", () => {
		expect(describeTableSchema.safeParse({}).success).toBe(false);
	});
});

describe("s3 tool param schemas", () => {
	test("listBuckets accepts empty input", () => {
		expect(listBucketsSchema.safeParse({}).success).toBe(true);
	});
	test("listBuckets passes through unexpected fields (schema not strict)", () => {
		expect(listBucketsSchema.safeParse({ unexpectedField: 123 }).success).toBe(true);
	});
	test("getBucketLocation accepts Bucket", () => {
		expect(getBucketLocationSchema.safeParse({ Bucket: "my-bucket" }).success).toBe(true);
	});
	test("getBucketLocation rejects missing Bucket", () => {
		expect(getBucketLocationSchema.safeParse({}).success).toBe(false);
	});
	test("getBucketPolicyStatus accepts Bucket", () => {
		expect(getBucketPolicyStatusSchema.safeParse({ Bucket: "my-bucket" }).success).toBe(true);
	});
	test("getBucketPolicyStatus rejects missing Bucket", () => {
		expect(getBucketPolicyStatusSchema.safeParse({}).success).toBe(false);
	});
});

describe("elasticache tool param schemas", () => {
	test("describeCacheClusters accepts empty input", () => {
		expect(describeCacheClustersSchema.safeParse({}).success).toBe(true);
	});
	test("describeCacheClusters rejects non-integer MaxRecords", () => {
		expect(describeCacheClustersSchema.safeParse({ MaxRecords: 1.5 }).success).toBe(false);
	});
	test("describeReplicationGroups accepts empty input", () => {
		expect(describeReplicationGroupsSchema.safeParse({}).success).toBe(true);
	});
	test("describeReplicationGroups accepts ReplicationGroupId", () => {
		expect(describeReplicationGroupsSchema.safeParse({ ReplicationGroupId: "my-rg" }).success).toBe(true);
	});
});

describe("messaging tool param schemas", () => {
	test("listTopics accepts empty input", () => {
		expect(listTopicsSchema.safeParse({}).success).toBe(true);
	});
	test("listTopics accepts NextToken", () => {
		expect(listTopicsSchema.safeParse({ NextToken: "token-abc" }).success).toBe(true);
	});
	test("getTopicAttributes accepts TopicArn", () => {
		expect(getTopicAttributesSchema.safeParse({ TopicArn: "arn:aws:sns:us-east-1:123:my-topic" }).success).toBe(true);
	});
	test("getTopicAttributes rejects missing TopicArn", () => {
		expect(getTopicAttributesSchema.safeParse({}).success).toBe(false);
	});
	test("listQueues accepts empty input", () => {
		expect(listQueuesSchema.safeParse({}).success).toBe(true);
	});
	test("listQueues accepts QueueNamePrefix", () => {
		expect(listQueuesSchema.safeParse({ QueueNamePrefix: "order-" }).success).toBe(true);
	});
	test("getQueueAttributes accepts required fields", () => {
		expect(
			getQueueAttributesSchema.safeParse({
				QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789/my-queue",
			}).success,
		).toBe(true);
	});
	test("getQueueAttributes rejects missing QueueUrl", () => {
		expect(getQueueAttributesSchema.safeParse({}).success).toBe(false);
	});
	test("listRules accepts empty input", () => {
		expect(listRulesSchema.safeParse({}).success).toBe(true);
	});
	test("listRules accepts EventBusName and NamePrefix", () => {
		expect(listRulesSchema.safeParse({ EventBusName: "my-bus", NamePrefix: "order-" }).success).toBe(true);
	});
	test("describeRule accepts required Name", () => {
		expect(describeRuleSchema.safeParse({ Name: "my-rule" }).success).toBe(true);
	});
	test("describeRule rejects missing Name", () => {
		expect(describeRuleSchema.safeParse({}).success).toBe(false);
	});
	test("listStateMachines accepts empty input", () => {
		expect(listStateMachinesSchema.safeParse({}).success).toBe(true);
	});
	test("listStateMachines rejects non-integer maxResults", () => {
		expect(listStateMachinesSchema.safeParse({ maxResults: 1.5 }).success).toBe(false);
	});
});

describe("config tool param schemas", () => {
	test("describeConfigRules accepts empty input", () => {
		expect(describeConfigRulesSchema.safeParse({}).success).toBe(true);
	});
	test("describeConfigRules rejects non-array ConfigRuleNames", () => {
		expect(describeConfigRulesSchema.safeParse({ ConfigRuleNames: "my-rule" }).success).toBe(false);
	});
	test("listDiscoveredResources accepts required resourceType", () => {
		expect(listDiscoveredResourcesSchema.safeParse({ resourceType: "AWS::EC2::Instance" }).success).toBe(true);
	});
	test("listDiscoveredResources rejects missing resourceType", () => {
		expect(listDiscoveredResourcesSchema.safeParse({}).success).toBe(false);
	});
});

describe("tags tool param schemas", () => {
	test("getResources accepts empty input", () => {
		expect(getResourcesSchema.safeParse({}).success).toBe(true);
	});
	test("getResources rejects non-array TagFilters", () => {
		expect(getResourcesSchema.safeParse({ TagFilters: "env=prod" }).success).toBe(false);
	});
});
