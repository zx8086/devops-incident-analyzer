// tests/aws-samples.ts
//
// Real AWS API output, captured from production accounts on 2026-09-16 and used
// verbatim by the workload-state check tests. Account ids and cluster-specific
// names are redacted; nothing else is edited, because the point of this file is
// that the strings are NOT invented.
//
// SIO-1748 exists because the first version of these checks was tested against
// a hand-written fake client. The fake agreed with the code by construction, so
// all five ECS event patterns matched nothing in reality and the tests passed
// anyway. Capture real output; do not describe it from memory.
//
// Provenance: ECS from a production account's 7 clusters / 22 services (2190
// events, 20 distinct shapes after normalizing ids); ELBv2 from 47 target
// groups across two accounts; SQS from 17 queues; Auto Scaling from 8
// activities.

// Every distinct ECS service-event shape observed, with its occurrence count.
// The counts are the argument for what is routine: "reached a steady state"
// outnumbers every failure-shaped event by two orders of magnitude.
export const ECS_EVENTS_OBSERVED: { count: number; message: string }[] = [
	{ count: 1602, message: "(service api-service) has reached a steady state." },
	{
		count: 136,
		message:
			"(service api-service) deregistered 2 targets in (target-group arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/api-service-alb-http/4d2246e3635cc45b)",
	},
	{
		count: 111,
		message:
			"(service api-service) registered 2 targets in (target-group arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/api-service-alb-http/4d2246e3635cc45b)",
	},
	{ count: 103, message: "(service api-service) has begun draining connections on 2 tasks." },
	{ count: 97, message: "(service api-service) has stopped 2 running tasks: (task 9d85800c30b349039d104d52b506b930)." },
	{ count: 63, message: "(service api-service) has started 2 tasks: (task 8378fd0fc0d744109128c8d6a0b71524)." },
	// Failure-SHAPED but routine: ECS replaced the tasks itself and the service
	// was back at steady state. The targets check owns persistent unhealthy
	// targets, behind a two-cycle gate; duplicating it here would report a
	// self-healing event 27 times over.
	{
		count: 22,
		message:
			"(service api-service) (task 9d85800c30b349039d104d52b506b930) (port 8080) is unhealthy in (target-group arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/api-service-alb-http/4d2246e3635cc45b) due to (reason Health checks failed with these codes: [503]).",
	},
	{
		count: 22,
		message:
			"(service api-service) has started 2 tasks: (task 8378fd0fc0d744109128c8d6a0b71524). Amazon ECS replaced 2 tasks due to an unhealthy status.",
	},
	{ count: 10, message: "(service api-service) (deployment ecs-svc/1111111111111111111) deployment completed." },
	{
		count: 5,
		message:
			"(service api-service) (task a25c6c790e254b4791ba6806c0541c63) (port 8080) is unhealthy in (target-group arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/api-service-alb-http/4d2246e3635cc45b) due to (reason Request timed out).",
	},
	// The three genuine failure signals observed in production.
	{
		count: 5,
		message:
			"(service api-service) was unable to reach steady state because (taskSet ecs-svc/1111111111111111111) was unable to scale in due to (reason 2 tasks under protection)",
	},
	{
		count: 2,
		message: "(service api-service) (deployment ecs-svc/1111111111111111111) deployment failed: tasks failed to start.",
	},
	{ count: 1, message: "(service api-service) rolling back to deployment ecs-svc/1111111111111111111." },
	{ count: 1, message: "(service api-service) stopped 2 pending tasks." },
	{
		count: 1,
		message:
			"(service api-service) is AZ balanced with 2 tasks in eu-central-1a, 2 tasks in eu-central-1c, 1 tasks in eu-central-1b.",
	},
	{
		count: 1,
		message:
			"(service api-service) is not AZ balanced with 3 tasks in eu-central-1a, 1 tasks in eu-central-1c, 1 tasks in eu-central-1b. AZ Rebalancing in progress.",
	},
	{
		count: 1,
		message:
			"(service api-service) has started 1 tasks in eu-central-1a to AZ Rebalance: (task 8378fd0fc0d744109128c8d6a0b71524).",
	},
];

// Observed rolloutState values across both accounts: the FAILED detector is
// real, it does occur, and it is the one signal AWS states outright.
export const ECS_ROLLOUT_STATES_OBSERVED = ["COMPLETED", "FAILED"];

// Exactly the keys a real TargetHealth carries for a HEALTHY target: State and
// nothing else. Reason and Description appear only when a target is not
// healthy, so any code reading them must tolerate their absence.
export const ELBV2_TARGET_HEALTH_HEALTHY = {
	Target: { Id: "10.0.1.23", Port: 8080, AvailabilityZone: "eu-central-1a" },
	HealthCheckPort: "8080",
	TargetHealth: { State: "healthy" },
};

// Real target-group fields. Note HealthCheckPort is the literal string
// "traffic-port", not a number, and Matcher carries HttpCode as a string.
export const ELBV2_TARGET_GROUP = {
	TargetGroupArn: "arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/api-service/b2ea699b9ec36d86",
	TargetGroupName: "api-service",
	Protocol: "HTTP",
	Port: 8000,
	VpcId: "vpc-0fd19bbcde568fcf0",
	HealthCheckProtocol: "HTTP",
	HealthCheckPort: "traffic-port",
	HealthCheckEnabled: true,
	HealthCheckIntervalSeconds: 30,
	HealthCheckTimeoutSeconds: 5,
	HealthyThresholdCount: 2,
	UnhealthyThresholdCount: 2,
	HealthCheckPath: "/health",
	Matcher: { HttpCode: "200" },
	TargetType: "ip",
	ProtocolVersion: "HTTP1",
	IpAddressType: "ipv4",
};

// Every attribute name a real GetQueueAttributes(All) returned. The list is the
// evidence for the bug this file exists to prevent: the first version of the
// queues check read ApproximateAgeOfOldestMessage as a queue attribute. It is
// not one -- the real API answers "InvalidAttributeName: Unknown Attribute
// ApproximateAgeOfOldestMessage" -- it is a CloudWatch metric.
export const SQS_ATTRIBUTE_NAMES_OBSERVED = [
	"ApproximateNumberOfMessages",
	"ApproximateNumberOfMessagesDelayed",
	"ApproximateNumberOfMessagesNotVisible",
	"CreatedTimestamp",
	"DelaySeconds",
	"LastModifiedTimestamp",
	"MaximumMessageSize",
	"MessageRetentionPeriod",
	"Policy",
	"QueueArn",
	"ReceiveMessageWaitTimeSeconds",
	"RedrivePolicy",
	"SqsManagedSseEnabled",
	"VisibilityTimeout",
];

// Real RedrivePolicy values, verbatim. maxReceiveCount arrives as a NUMBER in
// the JSON, not a string.
export const SQS_REDRIVE_POLICIES_OBSERVED = [
	'{"deadLetterTargetArn":"arn:aws:sqs:eu-central-1:000000000000:connectors-customer-notifications-dlq","maxReceiveCount":3}',
	'{"deadLetterTargetArn":"arn:aws:sqs:eu-central-1:000000000000:connectors-image-notifications-dlq","maxReceiveCount":3}',
	'{"deadLetterTargetArn":"arn:aws:sqs:eu-central-1:000000000000:connectors-notifications-dlq","maxReceiveCount":3}',
];

// Real Auto Scaling activity fields. StatusMessage is ABSENT on a successful
// activity, so anything reading it must fall back rather than assume it.
export const ASG_ACTIVITY_FIELDS_OBSERVED = [
	"ActivityId",
	"AutoScalingGroupARN",
	"AutoScalingGroupName",
	"Cause",
	"Description",
	"Details",
	"EndTime",
	"Progress",
	"StartTime",
	"StatusCode",
];

// Real Cause and Description text, used to check that the collapse signature
// strips what varies between two instances of one cause.
export const ASG_ACTIVITIES_OBSERVED = [
	{
		ActivityId: "8f1c0f5e-0000-4000-8000-000000000001",
		AutoScalingGroupName: "platform-nodes",
		StatusCode: "Successful",
		Description: "Terminating EC2 instance: i-036c981459069eab4",
		Cause:
			"At 2026-08-12T10:14:19Z a user request update of AutoScalingGroup constraints to min: 2, max: 5, desired: 2 changing the desired capacity from 3 to 2.",
	},
	{
		ActivityId: "8f1c0f5e-0000-4000-8000-000000000002",
		AutoScalingGroupName: "platform-nodes",
		StatusCode: "Successful",
		Description: "Terminating EC2 instance: i-086c07fd0d237bf69",
		Cause:
			"At 2026-08-12T10:10:16Z a user request update of AutoScalingGroup constraints to min: 2, max: 6, desired: 3 changing the desired capacity from 4 to 3.",
	},
	{
		ActivityId: "8f1c0f5e-0000-4000-8000-000000000003",
		AutoScalingGroupName: "platform-nodes",
		StatusCode: "Successful",
		Description: "Terminating EC2 instance: i-0f1fae2e5b8bbaf56",
		Cause:
			"At 2026-08-12T10:07:14Z instance i-0f1fae2e5b8bbaf56 was taken out of service in response to a user request, shrinking the capacity from 5 to 4.",
	},
];

// Failure events taken verbatim from AWS's own service event message list
// (docs.aws.amazon.com/AmazonECS/latest/developerguide/service-event-messages-list.html),
// with the documented placeholders filled in. The corpus cannot supply these:
// a sample of healthy services contains no failures, which is exactly the
// inference an earlier revision got wrong when it deleted the crash-loop
// pattern for being absent.
export const ECS_DOCUMENTED_FAILURE_EVENTS: { message: string; label: string }[] = [
	{ message: "service (api-service) is unable to consistently start tasks successfully.", label: "crash loop" },
	{
		message: "service (api-service) deployment failed: tasks failed to start.",
		label: "deployment failed to start tasks",
	},
	{
		message:
			"service (api-service) was unable to place a task because no container instance met all of its requirements.",
		label: "cannot place task",
	},
	{
		message:
			"service (api-service) was unable to place a task. Reason: You've reached the limit on the number of tasks you can run concurrently",
		label: "cannot place task",
	},
	{
		message:
			"service (api-service) was unable to place a task. Reason: Capacity is unavailable at this time. Please try again later or in a different availability zone.",
		label: "cannot place task",
	},
	{
		message:
			"service (api-service) was unable to reach steady state. Reason: No Container Instances were found in your capacity provider.",
		label: "cannot reach steady state",
	},
	{
		message: "service (api-service) operations are being throttled. Will try again later.",
		label: "scheduler throttled",
	},
	{
		message:
			"service (api-service) was unable to stop or start tasks during a deployment because of the service deployment configuration. Update the minimumHealthyPercent or maximumPercent value and try again.",
		label: "deployment configuration blocks replacement",
	},
	{
		message: "IAM permissions policies have been misconfigured or changed, and ECS can no longer maintain your service",
		label: "IAM misconfigured",
	},
	{
		message: "IAM trust relationship has been misconfigured or changed, and ECS can no longer maintain your service",
		label: "IAM misconfigured",
	},
	{
		message: "service (api-service) could not launch 3 tasks for deployment ecs-svc/1111111111111111111.",
		label: "could not launch tasks",
	},
	{
		message:
			"service (api-service) was unable to place tasks in your cluster because the tasks provisioning capacity limit was exceeded.",
		label: "provisioning capacity limit",
	},
	{
		message:
			'service (api-service) Timed out waiting for Amazon ECS Agent to start. Please check logs at /var/log/ecs/ecs-agent.log".',
		label: "ECS agent did not start",
	},
	{
		message:
			"service (api-service) task set (ecs-svc/823) (task 9d85800c) is not healthy in target-group (arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/api/abc) due to TARGET GROUP IS NOT FOUND.",
		label: "target group missing",
	},
];

// The ELB-shaped variant of the unhealthy-target event, from the same doc page.
// It must stay unclassified for the same reason the target-group variant does.
export const ECS_DOCUMENTED_SELF_HEALING =
	"service (api-service) (task 9d85800c) (instance i-0abc) is unhealthy in (elb api-service-elb) due to (reason Instance has failed at least the UnhealthyThreshold number of health checks consecutively.)";

// SIO-1749 captures, from the same accounts on the same day.

// RDS event categories actually seen over 14 days in a busy production
// account: 90 events, every one automated snapshot activity. This is the
// argument for filtering server-side -- the noise is the whole stream.
export const RDS_EVENT_CATEGORIES_OBSERVED = ["backup", "deletion"];
export const RDS_EVENT_SAMPLES_OBSERVED = [
	{
		source: "rds:catalog-service-psql-db-2026-09-02-05-04",
		type: "db-cluster-snapshot",
		categories: ["backup"],
		message: "Creating automated cluster snapshot",
	},
	{
		source: "rds:catalog-service-psql-db-2026-09-02-05-04",
		type: "db-cluster-snapshot",
		categories: ["backup"],
		message: "Automated cluster snapshot created",
	},
];
// Asking the API for the failure categories returned 0 of those 90 events.
export const RDS_FILTERED_COUNT_OBSERVED = 0;
export const RDS_UNFILTERED_COUNT_OBSERVED = 90;

// ElastiCache events carry no EventCategories at all, which is why that half
// of the family was not built.
export const ELASTICACHE_EVENT_FIELDS_OBSERVED = ["Date", "Message", "SourceIdentifier", "SourceType"];

// Every CloudFormation stack status seen across three accounts, 34 stacks.
export const CFN_STACK_STATUSES_OBSERVED = ["CREATE_COMPLETE", "UPDATE_COMPLETE"];
export const CFN_STACK_FIELDS_OBSERVED = [
	"Capabilities",
	"ChangeSetId",
	"CreationTime",
	"DeploymentConfig",
	"Description",
	"DisableRollback",
	"DriftInformation",
	"EnableTerminationProtection",
	"LastOperations",
	"LastUpdatedTime",
	"NotificationARNs",
	"Outputs",
	"Parameters",
	"ParentId",
	"RollbackConfiguration",
	"RootId",
	"StackId",
	"StackName",
	"StackStatus",
	"Tags",
];

// Security Hub, measured rather than assumed: 58 ACTIVE+NEW findings at
// CRITICAL or HIGH standing in one account, and UpdatedAt is re-stamped as the
// controls re-evaluate. A watermark on UpdatedAt would re-report all of them
// every cycle, and the content duplicates the existing compliance family.
export const SECURITYHUB_STANDING_CRITICAL_HIGH = 58;
export const SECURITYHUB_SAMPLE_TITLES = [
	"SSM.7 SSM documents should have the block public sharing setting enabled",
	"GuardDuty.1 GuardDuty should be enabled",
	"VPC default security groups should not allow inbound or outbound traffic",
	"RDS automatic minor version upgrades should be enabled",
];

// SIO-1750 captures. Every read below was verified to return something usable
// in a real account BEFORE the IAM for it was requested.

// The fleet's one real EKS nodegroup, healthy. health.issues is an empty array
// rather than absent, which is what makes it a usable discriminator.
export const EKS_NODEGROUP_HEALTHY = {
	status: "ACTIVE",
	health: { issues: [] },
	scalingConfig: { minSize: 2, maxSize: 3, desiredSize: 2 },
};
export const EKS_NODEGROUP_FIELDS_OBSERVED = [
	"amiType",
	"capacityType",
	"clusterName",
	"createdAt",
	"health",
	"instanceTypes",
	"labels",
	"launchTemplate",
	"modifiedAt",
	"nodeRole",
	"nodegroupArn",
	"nodegroupName",
	"releaseVersion",
	"resources",
	"scalingConfig",
	"status",
	"subnets",
	"tags",
	"taints",
	"updateConfig",
	"version",
];
// DescribeCluster carries no health field at all, which is why this check
// reads the nodegroup rather than the cluster.
export const EKS_CLUSTER_HAS_HEALTH_FIELD = false;

// Trusted Advisor, the replacement for the unreachable Service Quotas design:
// 52 service-limit checks answered in ONE call, each with AWS's own verdict.
export const TRUSTED_ADVISOR_SERVICE_LIMIT_CHECKS = 52;
export const TRUSTED_ADVISOR_STATUSES_OBSERVED = ["ok"];
export const TRUSTED_ADVISOR_SUMMARY_FIELDS_OBSERVED = [
	"categorySpecificSummary",
	"checkId",
	"hasFlaggedResources",
	"resourcesSummary",
	"status",
	"timestamp",
];

// EBS volume status across two accounts: 133 volumes, every one ok, and no
// pending actions. The healthy shape is what the check must stay silent on.
export const EBS_VOLUME_STATUS_FIELDS_OBSERVED = [
	"Actions",
	"AvailabilityZone",
	"AvailabilityZoneId",
	"Events",
	"InitializationStatusDetails",
	"Operator",
	"VolumeId",
	"VolumeStatus",
];
export const EBS_VOLUME_STATUSES_OBSERVED = ["ok"];

// Not taken from the estate-watch wishlist, and why.
export const BACKUP_JOBS_OBSERVED = 0;
export const SYNTHETICS_CANARIES_OBSERVED = 0;

// SIO-1752: the target groups that exposed the fail-open bug. Captured from
// eu-b2b-ecom-prd; private addresses redacted, reasons and descriptions verbatim.
// Every target answers the health check, just not with a 200, so the load
// balancer fails open and traffic is served. All five had been in this state
// for the entire 14-day history window.
export const ELBV2_FAIL_OPEN_MISCONFIGURED = [
	{
		group: "k8s-monitori-promethe-f053e498da",
		service: "monitoring/prometheus-ingress-prometheus-grafana:80",
		healthCheck: "HTTP / port=traffic-port",
		targets: [{ reason: "Target.ResponseCodeMismatch", description: "Health checks failed with these codes: [302]" }],
	},
	{
		group: "k8s-commerce-prdenvli-412a380e5a",
		service: "commerce/prdenvauth-ingress-prdenvlivets-app:5443",
		healthCheck: "HTTPS / port=traffic-port",
		targets: Array.from({ length: 8 }, () => ({
			reason: "Target.ResponseCodeMismatch",
			description: "Health checks failed with these codes: [404]",
		})),
	},
	{
		group: "k8s-commerce-prdenvto-fb1169b50f",
		service: "commerce/prdenvauth-ingress-prdenvtooling-web:7443",
		healthCheck: "HTTPS / port=traffic-port",
		targets: [{ reason: "Target.ResponseCodeMismatch", description: "Health checks failed with these codes: [403]" }],
	},
];

// SIO-1754: AlarmActions ARNs from DescribeAlarms in production accounts on
// 2026-09-16 (account ids, cluster and service names redacted; structure
// verbatim). In all six prd accounts no alarm mixed a scaling-policy action
// with a notification action.
export const ALARM_ACTIONS_OBSERVED = {
	ecsServiceScaleUp:
		"arn:aws:autoscaling:eu-central-1:000000000000:scalingPolicy:d2535f51-75d2-4337-b43e-af96d8e14af4:resource/ecs/service/example-cluster/example-service:policyName/example-service-cpu-scale-up",
	mskBrokerScaling:
		"arn:aws:autoscaling:eu-central-1:000000000000:scalingPolicy:c8820426-f0b6-46be-bf5b-1d6ce086aa9c:resource/kafka/arn:aws:kafka:eu-central-1:000000000000:cluster/example-msk/c78d2fa1-b4c9-4fc2-a063-421baf82b2b9-4:policyName/msk-broker-scaling:createdBy/307bdbe6-7531-49b5-8bf9-bb9257dff12a",
	snsTopic: "arn:aws:sns:eu-central-1:000000000000:example-alerts-topic",
};
