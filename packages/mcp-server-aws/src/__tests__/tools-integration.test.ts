// src/__tests__/tools-integration.test.ts
// One representative integration test per family, using aws-sdk-client-mock.
// Verifies the tool handler calls the SDK with the right params and the
// response flows through the wrapper correctly.
import { afterEach, describe, expect, test } from "bun:test";
import { CloudFormationClient, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
	ConfigServiceClient,
	DescribeConfigRulesCommand,
	GetDiscoveredResourceCountsCommand,
} from "@aws-sdk/client-config-service";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DescribeCacheClustersCommand, ElastiCacheClient } from "@aws-sdk/client-elasticache";
import {
	GetDetectorCommand,
	GuardDutyClient,
	type Finding as GuardDutyFinding,
	GetFindingsCommand as GuardDutyGetFindingsCommand,
	ListDetectorsCommand,
	ListFindingsCommand,
} from "@aws-sdk/client-guardduty";
import { DescribeEventsCommand, HealthClient } from "@aws-sdk/client-health";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import {
	type AwsSecurityFinding,
	DescribeHubCommand,
	GetEnabledStandardsCommand,
	SecurityHubClient,
	GetFindingsCommand as SecurityHubGetFindingsCommand,
	type StandardsSubscription,
} from "@aws-sdk/client-securityhub";
import { ListTopicsCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetTraceSummariesCommand, XRayClient } from "@aws-sdk/client-xray";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetClientsForTests } from "../services/client-factory.ts";
import { listStacks } from "../tools/cloudformation/list-stacks.ts";
import { describeTrails } from "../tools/cloudtrail/describe-trails.ts";
import { getTrailStatus } from "../tools/cloudtrail/get-trail-status.ts";
import { describeAlarms } from "../tools/cloudwatch/describe-alarms.ts";
import { describeConfigRules } from "../tools/config/describe-config-rules.ts";
import { getDiscoveredResourceCounts } from "../tools/config/get-discovered-resource-counts.ts";
import { listTables } from "../tools/dynamodb/list-tables.ts";
import { describeVpcs } from "../tools/ec2/describe-vpcs.ts";
import { describeTaskDefinition } from "../tools/ecs/describe-task-definition.ts";
import { describeTasks } from "../tools/ecs/describe-tasks.ts";
import { describeCacheClusters } from "../tools/elasticache/describe-cache-clusters.ts";
import { getDetector } from "../tools/guardduty/get-detector.ts";
import { getFindings as guardDutyGetFindings } from "../tools/guardduty/get-findings.ts";
import { listDetectors } from "../tools/guardduty/list-detectors.ts";
import { listFindings as guardDutyListFindings } from "../tools/guardduty/list-findings.ts";
import { describeEvents } from "../tools/health/describe-events.ts";
import { listFunctions } from "../tools/lambda/list-functions.ts";
import { describeLogGroups } from "../tools/logs/describe-log-groups.ts";
import { listTopics } from "../tools/messaging/sns/list-topics.ts";
import { describeDbInstances } from "../tools/rds/describe-db-instances.ts";
import { listBuckets } from "../tools/s3/list-buckets.ts";
import { describeHub } from "../tools/securityhub/describe-hub.ts";
import { getEnabledStandards } from "../tools/securityhub/get-enabled-standards.ts";
import { getFindings as securityHubGetFindings } from "../tools/securityhub/get-findings.ts";
import { getResources } from "../tools/tags/get-resources.ts";
import { getTraceSummaries } from "../tools/xray/get-trace-summaries.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

const E = "prod"; // canonical estate id for handler() calls below

afterEach(() => _resetClientsForTests());

describe("ec2 integration", () => {
	test("describeVpcs returns SDK response unchanged when under cap", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] });

		const handler = describeVpcs(config);
		const result = (await handler({ estate: E })) as { Vpcs: unknown[] };
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
		const result = (await handler({ estate: E, cluster: "my-cluster", tasks: ["abc123"] })) as { tasks: unknown[] };
		expect(result.tasks).toHaveLength(1);
	});

	test("describeTaskDefinition passes taskDefinition to the SDK and returns containerDefinitions", async () => {
		const ecsMock = mockClient(ECSClient);
		ecsMock.on(DescribeTaskDefinitionCommand).resolves({
			taskDefinition: {
				family: "connectors-service",
				revision: 42,
				containerDefinitions: [
					{
						name: "app",
						environment: [{ name: "DB_HOST", value: "eu-oit-prd-psql-db-0.xxxx.eu-central-1.rds.amazonaws.com" }],
					},
				],
			},
		});

		const handler = describeTaskDefinition(config);
		const result = (await handler({ estate: E, taskDefinition: "connectors-service:42" })) as {
			taskDefinition: { family: string };
		};
		expect(result.taskDefinition.family).toBe("connectors-service");
		expect(ecsMock.commandCalls(DescribeTaskDefinitionCommand)[0]?.args[0].input).toEqual({
			taskDefinition: "connectors-service:42",
			include: undefined,
		});
	});
});

describe("lambda integration", () => {
	test("listFunctions returns Functions array from SDK response", async () => {
		const lambdaMock = mockClient(LambdaClient);
		lambdaMock.on(ListFunctionsCommand).resolves({
			Functions: [{ FunctionName: "my-function", Runtime: "nodejs20.x" }],
		});

		const handler = listFunctions(config);
		const result = (await handler({ estate: E })) as { Functions: unknown[] };
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
		const result = (await handler({ estate: E })) as { MetricAlarms: unknown[] };
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
		const result = (await handler({ estate: E })) as { logGroups: unknown[] };
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
		const result = (await handler({
			estate: E,
			StartTime: "2026-01-01T00:00:00Z",
			EndTime: "2026-01-01T01:00:00Z",
		})) as {
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
		const result = (await handler({ estate: E })) as { events: unknown[] };
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
		const result = (await handler({ estate: E })) as { StackSummaries: unknown[] };
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
		const result = (await handler({ estate: E })) as { DBInstances: unknown[] };
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
		const result = (await handler({ estate: E })) as { TableNames: unknown[] };
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
		const result = (await handler({ estate: E })) as { Buckets: unknown[] };
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
		const result = (await handler({ estate: E })) as { CacheClusters: unknown[] };
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
		const result = (await handler({ estate: E })) as { Topics: unknown[] };
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
		const result = (await handler({ estate: E })) as { ConfigRules: unknown[] };
		expect(result.ConfigRules).toHaveLength(1);
	});

	test("getDiscoveredResourceCounts returns resourceCounts array from SDK response", async () => {
		const configMock = mockClient(ConfigServiceClient);
		configMock.on(GetDiscoveredResourceCountsCommand).resolves({
			totalDiscoveredResources: 2,
			resourceCounts: [
				{ resourceType: "AWS::S3::Bucket", count: 2 },
				{ resourceType: "AWS::CloudTrail::Trail", count: 3 },
			],
		});

		const handler = getDiscoveredResourceCounts(config);
		const result = (await handler({ estate: E })) as { resourceCounts: unknown[] };
		expect(result.resourceCounts).toHaveLength(2);
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
		const result = (await handler({ estate: E })) as { ResourceTagMappingList: unknown[] };
		expect(result.ResourceTagMappingList).toHaveLength(1);
	});
});

describe("cloudtrail integration", () => {
	test("describeTrails returns trailList array from SDK response", async () => {
		const ctMock = mockClient(CloudTrailClient);
		ctMock.on(DescribeTrailsCommand).resolves({
			trailList: [{ Name: "org-trail", IsMultiRegionTrail: true, S3BucketName: "audit-logs" }],
		});

		const handler = describeTrails(config);
		const result = (await handler({ estate: E })) as { trailList: unknown[] };
		expect(result.trailList).toHaveLength(1);
	});

	test("getTrailStatus returns the single status object from SDK response", async () => {
		const ctMock = mockClient(CloudTrailClient);
		ctMock.on(GetTrailStatusCommand).resolves({ IsLogging: true, LatestDeliveryTime: new Date(0) });

		const handler = getTrailStatus(config);
		const result = (await handler({ estate: E, Name: "org-trail" })) as { IsLogging: boolean };
		expect(result.IsLogging).toBe(true);
	});
});

describe("securityhub integration", () => {
	test("getFindings returns Findings array and filters by severity", async () => {
		const shMock = mockClient(SecurityHubClient);
		// Mocked SDK rows are partial; cast satisfies the strict AwsSecurityFinding[] type.
		shMock.on(SecurityHubGetFindingsCommand).resolves({
			Findings: [
				{ Id: "f-1", Severity: { Label: "CRITICAL" }, Title: "Public bucket" },
			] as unknown as AwsSecurityFinding[],
		});

		const handler = securityHubGetFindings(config);
		const result = (await handler({ estate: E, severityLabels: ["CRITICAL"] })) as { Findings: unknown[] };
		expect(result.Findings).toHaveLength(1);
		// Severity filter is translated into a SeverityLabel EQUALS filter on the command.
		const call = shMock.commandCalls(SecurityHubGetFindingsCommand)[0];
		expect(call?.args[0].input.Filters?.SeverityLabel?.[0]).toEqual({ Value: "CRITICAL", Comparison: "EQUALS" });
	});

	test("describeHub returns the single hub config object", async () => {
		const shMock = mockClient(SecurityHubClient);
		shMock.on(DescribeHubCommand).resolves({ HubArn: "arn:aws:securityhub:eu-west-1:1:hub/default" });

		const handler = describeHub(config);
		const result = (await handler({ estate: E })) as { HubArn: string };
		expect(result.HubArn).toContain("hub/default");
	});

	test("getEnabledStandards returns StandardsSubscriptions array", async () => {
		const shMock = mockClient(SecurityHubClient);
		shMock.on(GetEnabledStandardsCommand).resolves({
			StandardsSubscriptions: [
				{ StandardsSubscriptionArn: "arn:...:subscription/cis", StandardsStatus: "READY" },
			] as unknown as StandardsSubscription[],
		});

		const handler = getEnabledStandards(config);
		const result = (await handler({ estate: E })) as { StandardsSubscriptions: unknown[] };
		expect(result.StandardsSubscriptions).toHaveLength(1);
	});
});

describe("guardduty integration", () => {
	test("listDetectors returns DetectorIds array", async () => {
		const gdMock = mockClient(GuardDutyClient);
		gdMock.on(ListDetectorsCommand).resolves({ DetectorIds: ["det-1"] });

		const handler = listDetectors(config);
		const result = (await handler({ estate: E })) as { DetectorIds: unknown[] };
		expect(result.DetectorIds).toHaveLength(1);
	});

	test("getDetector returns the single detector object", async () => {
		const gdMock = mockClient(GuardDutyClient);
		gdMock.on(GetDetectorCommand).resolves({ Status: "ENABLED", FindingPublishingFrequency: "SIX_HOURS" });

		const handler = getDetector(config);
		const result = (await handler({ estate: E, DetectorId: "det-1" })) as { Status: string };
		expect(result.Status).toBe("ENABLED");
	});

	test("list -> get findings chain threads FindingIds through", async () => {
		const gdMock = mockClient(GuardDutyClient);
		gdMock.on(ListFindingsCommand).resolves({ FindingIds: ["find-a", "find-b"] });
		gdMock.on(GuardDutyGetFindingsCommand).resolves({
			Findings: [
				{ Id: "find-a", Severity: 8, Type: "Recon:EC2/Portscan", Title: "Port scan" },
				{ Id: "find-b", Severity: 5, Type: "UnauthorizedAccess:EC2/SSHBruteForce", Title: "SSH brute force" },
			] as unknown as GuardDutyFinding[],
		});

		const listHandler = guardDutyListFindings(config);
		const ids = (await listHandler({ estate: E, DetectorId: "det-1", minSeverity: 4 })) as { FindingIds: string[] };
		expect(ids.FindingIds).toHaveLength(2);
		// minSeverity is translated into a severity GreaterThanOrEqual criterion.
		const listCall = gdMock.commandCalls(ListFindingsCommand)[0];
		expect(listCall?.args[0].input.FindingCriteria?.Criterion?.severity?.GreaterThanOrEqual).toBe(4);

		const getHandler = guardDutyGetFindings(config);
		const hydrated = (await getHandler({ estate: E, DetectorId: "det-1", FindingIds: ids.FindingIds })) as {
			Findings: unknown[];
		};
		expect(hydrated.Findings).toHaveLength(2);
		const getCall = gdMock.commandCalls(GuardDutyGetFindingsCommand)[0];
		expect(getCall?.args[0].input.FindingIds).toEqual(["find-a", "find-b"]);
	});
});

// SIO-838: the canonical limit/cursor aliases must reach each tool's SDK param, and the
// SDK-named param must win when both are supplied (so existing call patterns never break).
// Representative coverage across the token-name families: NextToken (cloudwatch), Marker (rds),
// and the DynamoDB limit-only special case.
describe("pagination alias wiring (SIO-838)", () => {
	test("cloudwatch describe-alarms: cursor->NextToken, limit->MaxRecords", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
		const handler = describeAlarms(config);
		await handler({ estate: E, cursor: "tok-1", limit: 25 });
		const call = cwMock.commandCalls(DescribeAlarmsCommand)[0];
		expect(call?.args[0].input.NextToken).toBe("tok-1");
		expect(call?.args[0].input.MaxRecords).toBe(25);
	});

	test("cloudwatch describe-alarms: SDK-named NextToken/MaxRecords win over aliases", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
		const handler = describeAlarms(config);
		await handler({ estate: E, NextToken: "sdk-tok", cursor: "alias-tok", MaxRecords: 10, limit: 99 });
		const call = cwMock.commandCalls(DescribeAlarmsCommand)[0];
		expect(call?.args[0].input.NextToken).toBe("sdk-tok");
		expect(call?.args[0].input.MaxRecords).toBe(10);
	});

	test("rds describe-db-instances: cursor maps to Marker (not NextToken)", async () => {
		const rdsMock = mockClient(RDSClient);
		rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] });
		const handler = describeDbInstances(config);
		await handler({ estate: E, cursor: "marker-1", limit: 30 });
		const call = rdsMock.commandCalls(DescribeDBInstancesCommand)[0];
		expect(call?.args[0].input.Marker).toBe("marker-1");
		expect(call?.args[0].input.MaxRecords).toBe(30);
	});

	test("dynamodb list-tables: limit->Limit, with no cursor alias", async () => {
		const ddbMock = mockClient(DynamoDBClient);
		ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });
		const handler = listTables(config);
		await handler({ estate: E, limit: 40 });
		const call = ddbMock.commandCalls(ListTablesCommand)[0];
		expect(call?.args[0].input.Limit).toBe(40);
	});
});
