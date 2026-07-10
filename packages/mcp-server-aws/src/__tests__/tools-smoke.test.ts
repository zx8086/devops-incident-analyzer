// src/__tests__/tools-smoke.test.ts
// One smoke test per tool: each tool's Zod paramsSchema parses valid input and
// rejects obviously invalid input. New families are appended below.
import { describe, expect, test } from "bun:test";
import { describeStackEventsSchema } from "../tools/cloudformation/describe-stack-events.ts";
import { describeStacksSchema } from "../tools/cloudformation/describe-stacks.ts";
import { listStacksSchema } from "../tools/cloudformation/list-stacks.ts";
import { describeTrailsSchema } from "../tools/cloudtrail/describe-trails.ts";
import { getTrailStatusSchema } from "../tools/cloudtrail/get-trail-status.ts";
import { listTrailsSchema } from "../tools/cloudtrail/list-trails.ts";
import { describeAlarmsSchema } from "../tools/cloudwatch/describe-alarms.ts";
import { getMetricDataSchema } from "../tools/cloudwatch/get-metric-data.ts";
import { describeConfigRulesSchema } from "../tools/config/describe-config-rules.ts";
import { getDiscoveredResourceCountsSchema } from "../tools/config/get-discovered-resource-counts.ts";
import { listDiscoveredResourcesSchema } from "../tools/config/list-discovered-resources.ts";
import { describeTableSchema } from "../tools/dynamodb/describe-table.ts";
import { listTablesSchema } from "../tools/dynamodb/list-tables.ts";
import { describeInstancesSchema } from "../tools/ec2/describe-instances.ts";
import { describeNetworkInterfacesSchema } from "../tools/ec2/describe-network-interfaces.ts";
import { describeSecurityGroupsSchema } from "../tools/ec2/describe-security-groups.ts";
import { describeVpcEndpointsSchema } from "../tools/ec2/describe-vpc-endpoints.ts";
import { describeVpcsSchema } from "../tools/ec2/describe-vpcs.ts";
import { describeServicesSchema } from "../tools/ecs/describe-services.ts";
import { describeTaskDefinitionSchema } from "../tools/ecs/describe-task-definition.ts";
import { describeTasksSchema } from "../tools/ecs/describe-tasks.ts";
import { listClustersSchema } from "../tools/ecs/list-clusters.ts";
import { listServicesSchema } from "../tools/ecs/list-services.ts";
import { listTasksSchema } from "../tools/ecs/list-tasks.ts";
import { describeCacheClustersSchema } from "../tools/elasticache/describe-cache-clusters.ts";
import { describeReplicationGroupsSchema } from "../tools/elasticache/describe-replication-groups.ts";
import { getDetectorSchema } from "../tools/guardduty/get-detector.ts";
import { getFindingsSchema as guardDutyGetFindingsSchema } from "../tools/guardduty/get-findings.ts";
import { listDetectorsSchema } from "../tools/guardduty/list-detectors.ts";
import { listFindingsSchema as guardDutyListFindingsSchema } from "../tools/guardduty/list-findings.ts";
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
import { describeHubSchema } from "../tools/securityhub/describe-hub.ts";
import { getEnabledStandardsSchema } from "../tools/securityhub/get-enabled-standards.ts";
import { getFindingsSchema as securityHubGetFindingsSchema } from "../tools/securityhub/get-findings.ts";
import { getResourcesSchema } from "../tools/tags/get-resources.ts";
import { getServiceGraphSchema } from "../tools/xray/get-service-graph.ts";
import { getTraceSummariesSchema } from "../tools/xray/get-trace-summaries.ts";

// SIO-838: canonical limit/cursor aliases are additive and accepted on every list tool
// (cursor on token-bearing tools, limit on page-size-bearing tools). limit inherits the
// SDK page-size param's constraints. DynamoDB has limit but intentionally no cursor.
describe("pagination alias schemas (SIO-838)", () => {
	test("both-alias tools accept limit and cursor", () => {
		expect(describeInstancesSchema.safeParse({ limit: 50, cursor: "tok" }).success).toBe(true);
		expect(describeAlarmsSchema.safeParse({ limit: 25, cursor: "tok" }).success).toBe(true);
		expect(listFunctionsSchema.safeParse({ limit: 25, cursor: "mark" }).success).toBe(true);
		expect(describeDbInstancesSchema.safeParse({ limit: 25, cursor: "mark" }).success).toBe(true);
	});

	test("limit alias inherits the SDK page-size constraints", () => {
		// EC2 maxResults is 5-1000, so limit below 5 must be rejected.
		expect(describeInstancesSchema.safeParse({ limit: 1 }).success).toBe(false);
		// GuardDuty MaxResults is 1-50, so limit above 50 must be rejected.
		expect(guardDutyListFindingsSchema.safeParse({ DetectorId: "d", limit: 100 }).success).toBe(false);
	});

	test("token-only tools accept cursor", () => {
		expect(listTopicsSchema.safeParse({ cursor: "tok" }).success).toBe(true);
		expect(listStacksSchema.safeParse({ cursor: "tok" }).success).toBe(true);
		expect(listDetectorsSchema.safeParse({ cursor: "tok" }).success).toBe(true);
	});

	test("dynamodb list-tables accepts limit but has no cursor alias", () => {
		expect(listTablesSchema.safeParse({ limit: 40 }).success).toBe(true);
		// cursor is not a declared field; Zod strips unknown keys by default, so parsing
		// still succeeds but cursor must NOT appear in the parsed output.
		const parsed = listTablesSchema.parse({ cursor: "should-be-stripped" }) as Record<string, unknown>;
		expect(parsed.cursor).toBeUndefined();
	});
});

describe("ec2 tool param schemas", () => {
	test("describeVpcs accepts empty input", () => {
		expect(describeVpcsSchema.safeParse({}).success).toBe(true);
	});
	test("describeVpcs rejects non-array vpcIds", () => {
		expect(describeVpcsSchema.safeParse({ vpcIds: "vpc-1" }).success).toBe(false);
	});
	// SIO-1057
	test("describeVpcEndpoints accepts endpoint ids and vpc-id filter", () => {
		expect(
			describeVpcEndpointsSchema.safeParse({
				vpcEndpointIds: ["vpce-045853bfc0d45e1e0"],
				filters: [{ Name: "vpc-id", Values: ["vpc-1"] }],
			}).success,
		).toBe(true);
	});
	test("describeVpcEndpoints rejects non-array vpcEndpointIds", () => {
		expect(describeVpcEndpointsSchema.safeParse({ vpcEndpointIds: "vpce-1" }).success).toBe(false);
	});
	test("describeNetworkInterfaces accepts a private-ip-address filter", () => {
		expect(
			describeNetworkInterfacesSchema.safeParse({
				filters: [{ Name: "private-ip-address", Values: ["10.34.50.147"] }],
			}).success,
		).toBe(true);
	});
	test("describeNetworkInterfaces rejects a malformed filter (missing Values)", () => {
		expect(describeNetworkInterfacesSchema.safeParse({ filters: [{ Name: "vpc-id" }] }).success).toBe(false);
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
	test("listServices accepts required cluster", () => {
		expect(listServicesSchema.safeParse({ cluster: "my-cluster" }).success).toBe(true);
	});
	test("listServices rejects missing cluster", () => {
		expect(listServicesSchema.safeParse({}).success).toBe(false);
	});
	test("listServices accepts launchType filter", () => {
		expect(listServicesSchema.safeParse({ cluster: "my-cluster", launchType: "FARGATE" }).success).toBe(true);
	});
	test("listServices rejects invalid launchType", () => {
		expect(listServicesSchema.safeParse({ cluster: "my-cluster", launchType: "INVALID" }).success).toBe(false);
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
	test("describeTaskDefinition accepts taskDefinition", () => {
		expect(describeTaskDefinitionSchema.safeParse({ taskDefinition: "connectors-service:42" }).success).toBe(true);
	});
	test("describeTaskDefinition rejects missing taskDefinition", () => {
		expect(describeTaskDefinitionSchema.safeParse({}).success).toBe(false);
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
	// SIO-834: unlike listDiscoveredResources, resourceType is OPTIONAL here so the tool can
	// inventory the whole account in one call.
	test("getDiscoveredResourceCounts accepts empty input", () => {
		expect(getDiscoveredResourceCountsSchema.safeParse({}).success).toBe(true);
	});
	test("getDiscoveredResourceCounts accepts an optional resourceType filter", () => {
		expect(getDiscoveredResourceCountsSchema.safeParse({ resourceType: "AWS::S3::Bucket" }).success).toBe(true);
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

describe("cloudtrail tool param schemas", () => {
	test("describeTrails accepts empty input", () => {
		expect(describeTrailsSchema.safeParse({}).success).toBe(true);
	});
	test("describeTrails rejects non-array trailNameList", () => {
		expect(describeTrailsSchema.safeParse({ trailNameList: "org-trail" }).success).toBe(false);
	});
	test("getTrailStatus requires Name", () => {
		expect(getTrailStatusSchema.safeParse({}).success).toBe(false);
		expect(getTrailStatusSchema.safeParse({ Name: "org-trail" }).success).toBe(true);
	});
	test("listTrails accepts empty input", () => {
		expect(listTrailsSchema.safeParse({}).success).toBe(true);
	});
});

describe("securityhub tool param schemas", () => {
	test("getFindings accepts empty input (all severities)", () => {
		expect(securityHubGetFindingsSchema.safeParse({}).success).toBe(true);
	});
	test("getFindings accepts known severity labels", () => {
		expect(securityHubGetFindingsSchema.safeParse({ severityLabels: ["CRITICAL", "HIGH"] }).success).toBe(true);
	});
	test("getFindings rejects unknown severity labels", () => {
		expect(securityHubGetFindingsSchema.safeParse({ severityLabels: ["SEVERE"] }).success).toBe(false);
	});
	test("describeHub accepts empty input", () => {
		expect(describeHubSchema.safeParse({}).success).toBe(true);
	});
	test("getEnabledStandards accepts empty input", () => {
		expect(getEnabledStandardsSchema.safeParse({}).success).toBe(true);
	});
});

describe("guardduty tool param schemas", () => {
	test("listDetectors accepts empty input", () => {
		expect(listDetectorsSchema.safeParse({}).success).toBe(true);
	});
	test("getDetector requires DetectorId", () => {
		expect(getDetectorSchema.safeParse({}).success).toBe(false);
		expect(getDetectorSchema.safeParse({ DetectorId: "det-1" }).success).toBe(true);
	});
	test("listFindings requires DetectorId and bounds minSeverity to 0-10", () => {
		expect(guardDutyListFindingsSchema.safeParse({}).success).toBe(false);
		expect(guardDutyListFindingsSchema.safeParse({ DetectorId: "det-1", minSeverity: 7 }).success).toBe(true);
		expect(guardDutyListFindingsSchema.safeParse({ DetectorId: "det-1", minSeverity: 11 }).success).toBe(false);
	});
	test("getFindings requires DetectorId and a non-empty FindingIds array", () => {
		expect(guardDutyGetFindingsSchema.safeParse({ DetectorId: "det-1" }).success).toBe(false);
		expect(guardDutyGetFindingsSchema.safeParse({ DetectorId: "det-1", FindingIds: [] }).success).toBe(false);
		expect(guardDutyGetFindingsSchema.safeParse({ DetectorId: "det-1", FindingIds: ["f-1"] }).success).toBe(true);
	});
});
