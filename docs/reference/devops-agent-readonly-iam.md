# DevOpsAgentReadOnly IAM Reference

Single-document reference for the AWS read-only IAM used by the DevOps Incident Analyzer's aws-agent datasource. Combines the trust policy and both permissions policies deployed to every monitored estate.

## Overview

- **Role name:** `DevOpsAgentReadOnly` (identical in each monitored account)
- **Assumed by:** `arn:aws:iam::399987695868:role/DevOpsAgentCoreRole` (AgentCore execution role, host account eu-shared-services-prd)
- **ExternalId:** `devops-agent-prod-access`
- **Deployment model:** true cross-account, 7 targets (6 external estates + host self-loop; the host assumes its own `DevOpsAgentReadOnly` to keep the runtime code path uniform)
- **Attached policies (2):**
  1. `DevOpsAgentReadOnlyPermissions` (managed) -- base read, source `scripts/agentcore/policies/devops-agent-readonly-policy.json`
  2. Troubleshooting deep-dive (SIO-1120) -- source `scripts/agentcore/policies/devops-agent-readonly-troubleshooting-policy.json`
- **Provisioning script:** `scripts/agentcore/setup-aws-readonly-role.sh` (default `POLICY_NAME=DevOpsAgentReadOnlyPermissions` since SIO-858)

Notes:

- The name `DevOpsAgentReadOnlyPolicy` (seen in older docs/plans) was never a deployed policy; the deployed managed policy is `DevOpsAgentReadOnlyPermissions`.
- The MVP ExternalId `aws-mcp-readonly-2026` is stale -- do not use.
- Everything is strictly read-only: no write actions, no secret-value access (Secrets Manager is metadata-only), and log content is name-scoped rather than blanket.

## 1. Trust Policy

Only the AgentCore execution role may assume `DevOpsAgentReadOnly`, gated on the ExternalId.

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Sid": "TrustAgentCoreInSharedServices",
			"Effect": "Allow",
			"Principal": {
				"AWS": "arn:aws:iam::399987695868:role/DevOpsAgentCoreRole"
			},
			"Action": "sts:AssumeRole",
			"Condition": {
				"StringEquals": {
					"sts:ExternalId": "devops-agent-prod-access"
				}
			}
		}
	]
}
```

## 2. Base Read Policy (`DevOpsAgentReadOnlyPermissions`)

Core discovery and observability read: network topology, compute/containers/serverless, datastores, messaging, CloudWatch, name-scoped log content, X-Ray, Health/Config, CloudFormation and tags, security/audit surfaces.

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Sid": "IdentityAndAccountDiscovery",
			"Effect": "Allow",
			"Action": ["sts:GetCallerIdentity"],
			"Resource": "*"
		},
		{
			"Sid": "RegionalAndNetworkTopology",
			"Effect": "Allow",
			"Action": [
				"ec2:DescribeRegions",
				"ec2:DescribeAvailabilityZones",
				"ec2:DescribeVpcs",
				"ec2:DescribeSubnets",
				"ec2:DescribeRouteTables",
				"ec2:DescribeSecurityGroups",
				"ec2:DescribeNetworkInterfaces",
				"ec2:DescribeVpcEndpoints",
				"ec2:DescribeAddresses",
				"elasticloadbalancing:DescribeLoadBalancers",
				"elasticloadbalancing:DescribeListeners",
				"elasticloadbalancing:DescribeTargetGroups",
				"elasticloadbalancing:DescribeTargetHealth"
			],
			"Resource": "*"
		},
		{
			"Sid": "ComputeContainersAndServerlessRead",
			"Effect": "Allow",
			"Action": [
				"ec2:DescribeInstances",
				"ec2:DescribeInstanceStatus",
				"ec2:DescribeLaunchTemplates",
				"ec2:DescribeImages",
				"autoscaling:DescribeAutoScalingGroups",
				"autoscaling:DescribeAutoScalingInstances",
				"ecs:ListClusters",
				"ecs:DescribeClusters",
				"ecs:ListServices",
				"ecs:DescribeServices",
				"ecs:ListTasks",
				"ecs:DescribeTasks",
				"ecs:DescribeTaskDefinition",
				"ecs:ListContainerInstances",
				"ecs:DescribeContainerInstances",
				"eks:ListClusters",
				"eks:DescribeCluster",
				"lambda:ListFunctions",
				"lambda:GetFunctionConfiguration",
				"lambda:ListEventSourceMappings"
			],
			"Resource": "*"
		},
		{
			"Sid": "DatastoresAndStorageRead",
			"Effect": "Allow",
			"Action": [
				"rds:DescribeDBInstances",
				"rds:DescribeDBClusters",
				"dynamodb:ListTables",
				"dynamodb:DescribeTable",
				"elasticache:DescribeCacheClusters",
				"elasticache:DescribeReplicationGroups",
				"s3:ListAllMyBuckets",
				"s3:GetBucketLocation",
				"s3:GetBucketVersioning",
				"s3:GetBucketEncryption",
				"s3:GetBucketPublicAccessBlock",
				"s3:GetBucketTagging",
				"s3:GetBucketPolicyStatus"
			],
			"Resource": "*"
		},
		{
			"Sid": "MessagingAndIntegrationRead",
			"Effect": "Allow",
			"Action": [
				"sns:ListTopics",
				"sns:GetTopicAttributes",
				"sqs:ListQueues",
				"sqs:GetQueueAttributes",
				"events:ListEventBuses",
				"events:ListRules",
				"events:DescribeRule",
				"events:ListTargetsByRule",
				"states:ListStateMachines",
				"states:DescribeStateMachine"
			],
			"Resource": "*"
		},
		{
			"Sid": "MetricsAlarmsAndDashboardsRead",
			"Effect": "Allow",
			"Action": [
				"cloudwatch:ListMetrics",
				"cloudwatch:GetMetricData",
				"cloudwatch:GetMetricStatistics",
				"cloudwatch:DescribeAlarms",
				"cloudwatch:DescribeAlarmsForMetric",
				"cloudwatch:GetDashboard",
				"cloudwatch:ListDashboards"
			],
			"Resource": "*"
		},
		{
			"Sid": "LogsListUnscoped",
			"Effect": "Allow",
			"Action": ["logs:DescribeLogGroups", "logs:DescribeLogStreams"],
			"Resource": "*"
		},
		{
			"Sid": "LogsReadLimitedByName",
			"Effect": "Allow",
			"Action": [
				"logs:GetLogEvents",
				"logs:FilterLogEvents",
				"logs:StartQuery",
				"logs:GetQueryResults",
				"logs:StopQuery"
			],
			"Resource": [
				"arn:aws:logs:*:*:log-group:/aws/*",
				"arn:aws:logs:*:*:log-group:/ecs/*",
				"arn:aws:logs:*:*:log-group:/app/*",
				"arn:aws:logs:*:*:log-group:/platform/*",
				"arn:aws:logs:*:*:log-group:/prod/*",
				"arn:aws:logs:*:*:log-group:/bedrock/*"
			]
		},
		{
			"Sid": "TracingAndServiceMapRead",
			"Effect": "Allow",
			"Action": ["xray:GetServiceGraph", "xray:GetTraceSummaries", "xray:BatchGetTraces", "xray:GetGroups"],
			"Resource": "*"
		},
		{
			"Sid": "AwsHealthAndConfigRead",
			"Effect": "Allow",
			"Action": [
				"health:DescribeEvents",
				"health:DescribeEventDetails",
				"config:DescribeConfigRules",
				"config:DescribeComplianceByConfigRule",
				"config:ListDiscoveredResources",
				"config:GetDiscoveredResourceCounts"
			],
			"Resource": "*"
		},
		{
			"Sid": "CloudFormationAndDeploymentContext",
			"Effect": "Allow",
			"Action": [
				"cloudformation:ListStacks",
				"cloudformation:DescribeStacks",
				"cloudformation:DescribeStackEvents",
				"cloudformation:GetTemplate",
				"cloudformation:ListStackResources",
				"tag:GetResources",
				"tag:GetTagKeys",
				"tag:GetTagValues"
			],
			"Resource": "*"
		},
		{
			"Sid": "SecurityAndAuditRead",
			"Effect": "Allow",
			"Action": [
				"cloudtrail:DescribeTrails",
				"cloudtrail:GetTrailStatus",
				"cloudtrail:ListTrails",
				"securityhub:GetFindings",
				"securityhub:DescribeHub",
				"securityhub:GetEnabledStandards",
				"guardduty:ListDetectors",
				"guardduty:GetDetector",
				"guardduty:ListFindings",
				"guardduty:GetFindings"
			],
			"Resource": "*"
		}
	]
}
```

## 3. Troubleshooting Deep-Dive Policy (SIO-1120)

Network-path drill-down and change/access diagnosis: VPC endpoints and gateways, NACLs, transit gateways, Reachability Analyzer, DNS, MSK, KMS metadata, CloudTrail event lookup, scaling/image/quota context, and flow-log content.

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Sid": "NetworkPathConnectivityRead",
			"Effect": "Allow",
			"Action": [
				"ec2:DescribeVpcEndpoints",
				"ec2:DescribeVpcEndpointServices",
				"ec2:DescribeVpcEndpointConnections",
				"ec2:DescribeVpcEndpointServiceConfigurations",
				"ec2:DescribeNatGateways",
				"ec2:DescribeInternetGateways",
				"ec2:DescribeEgressOnlyInternetGateways",
				"ec2:DescribeNetworkAcls",
				"ec2:DescribeVpcPeeringConnections",
				"ec2:DescribeVpcAttribute",
				"ec2:DescribeSecurityGroupRules",
				"ec2:DescribeDhcpOptions",
				"ec2:DescribePrefixLists",
				"ec2:DescribeManagedPrefixLists",
				"ec2:GetManagedPrefixListEntries",
				"ec2:DescribeFlowLogs",
				"ec2:DescribeTransitGateways",
				"ec2:DescribeTransitGatewayAttachments",
				"ec2:DescribeTransitGatewayVpcAttachments",
				"ec2:DescribeTransitGatewayRouteTables",
				"ec2:SearchTransitGatewayRoutes",
				"ec2:DescribeNetworkInsightsPaths",
				"ec2:DescribeNetworkInsightsAnalyses",
				"ec2:DescribeVpnConnections",
				"ec2:DescribeVpnGateways",
				"ec2:DescribeCustomerGateways",
				"ec2:DescribeClientVpnEndpoints",
				"elasticloadbalancing:DescribeLoadBalancerAttributes",
				"elasticloadbalancing:DescribeTargetGroupAttributes",
				"elasticloadbalancing:DescribeRules",
				"elasticloadbalancing:DescribeTags",
				"elasticloadbalancing:DescribeSSLPolicies",
				"network-firewall:DescribeFirewall",
				"network-firewall:DescribeFirewallPolicy",
				"network-firewall:DescribeLoggingConfiguration",
				"network-firewall:ListFirewalls",
				"directconnect:DescribeConnections",
				"directconnect:DescribeVirtualInterfaces"
			],
			"Resource": "*"
		},
		{
			"Sid": "DnsResolutionRead",
			"Effect": "Allow",
			"Action": [
				"route53:ListHostedZones",
				"route53:GetHostedZone",
				"route53:ListResourceRecordSets",
				"route53:ListHealthChecks",
				"route53:GetHealthCheckStatus",
				"route53resolver:ListResolverEndpoints",
				"route53resolver:ListResolverRules",
				"route53resolver:ListResolverRuleAssociations",
				"route53resolver:ListResolverQueryLogConfigs"
			],
			"Resource": "*"
		},
		{
			"Sid": "MskStreamingRead",
			"Effect": "Allow",
			"Action": [
				"kafka:ListClustersV2",
				"kafka:DescribeClusterV2",
				"kafka:GetBootstrapBrokers",
				"kafka:ListNodes",
				"kafka:DescribeConfiguration",
				"kafka:ListClientVpcConnections",
				"kafka:ListClusterOperationsV2"
			],
			"Resource": "*"
		},
		{
			"Sid": "ChangeAndAccessDiagnosisRead",
			"Effect": "Allow",
			"Action": [
				"sts:DecodeAuthorizationMessage",
				"kms:DescribeKey",
				"kms:ListAliases",
				"kms:GetKeyPolicy",
				"kms:GetKeyRotationStatus",
				"config:GetResourceConfigHistory",
				"config:BatchGetResourceConfig",
				"config:SelectResourceConfig",
				"config:DescribeConfigurationRecorderStatus",
				"cloudtrail:LookupEvents",
				"cloudtrail:GetEventSelectors"
			],
			"Resource": "*"
		},
		{
			"Sid": "DeploymentScalingImageAndQuotaRead",
			"Effect": "Allow",
			"Action": [
				"autoscaling:DescribeScalingActivities",
				"autoscaling:DescribePolicies",
				"application-autoscaling:DescribeScalableTargets",
				"application-autoscaling:DescribeScalingPolicies",
				"application-autoscaling:DescribeScalingActivities",
				"ecs:ListTaskDefinitions",
				"ecs:ListTaskDefinitionFamilies",
				"ecs:DescribeCapacityProviders",
				"ecr:DescribeRepositories",
				"ecr:DescribeImages",
				"ecr:ListImages",
				"ecr:GetRepositoryPolicy",
				"ecr:GetLifecyclePolicy",
				"cloudformation:DescribeStackResourceDrifts",
				"cloudformation:DescribeStackResource",
				"cloudformation:ListExports",
				"cloudformation:ListImports",
				"cloudformation:DescribeChangeSet",
				"cloudformation:ListChangeSets",
				"servicequotas:ListServiceQuotas",
				"servicequotas:GetServiceQuota"
			],
			"Resource": "*"
		},
		{
			"Sid": "ServiceContextAndConfigMetadataRead",
			"Effect": "Allow",
			"Action": [
				"lambda:GetFunction",
				"lambda:GetPolicy",
				"lambda:GetAccountSettings",
				"states:DescribeExecution",
				"states:ListExecutions",
				"states:GetExecutionHistory",
				"rds:DescribeEvents",
				"elasticache:DescribeEvents",
				"health:DescribeAffectedEntities",
				"health:DescribeEventAggregates",
				"logs:DescribeMetricFilters",
				"logs:DescribeSubscriptionFilters",
				"logs:GetLogGroupFields",
				"ssm:DescribeParameters",
				"secretsmanager:ListSecrets",
				"secretsmanager:DescribeSecret"
			],
			"Resource": "*"
		},
		{
			"Sid": "FlowLogsContentRead",
			"Effect": "Allow",
			"Action": [
				"logs:DescribeLogStreams",
				"logs:GetLogEvents",
				"logs:FilterLogEvents",
				"logs:StartQuery",
				"logs:GetQueryResults",
				"logs:StopQuery"
			],
			"Resource": "arn:aws:logs:*:*:log-group:/vpc/flow-logs/*"
		}
	]
}
```

## Verification

```bash
# Confirm the attached managed policy name in a target account
aws iam list-attached-role-policies --role-name DevOpsAgentReadOnly \
  --query 'AttachedPolicies[].PolicyName'
```

IAM read is account-local and the assume-chain (`DevOpsAgentCoreRole -> DevOpsAgentReadOnly`) is blocked for human SSO, so a target estate's policy can only be verified from a session authenticated as that account, or empirically by calling a tool through the deployed runtime (an `AccessDenied` envelope means the policy is not applied there).
