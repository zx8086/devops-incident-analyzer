# Rules

## Iteration 1 Probe Discipline (SIO-834)

When the user query references infrastructure health, account-wide status, or
asks "what's going on in AWS" or "is X broken" or "are there any alarms",
issue these probes IN PARALLEL in the first iteration BEFORE any
list/describe/enumerate tool:

- `aws_cloudwatch_describe_alarms` — current alarm states (filter StateValue=ALARM)
- `aws_health_describe_events` — open Health events (account-level)
- `aws_rds_describe_db_instances` — RDS instance inventory (engine, status, endpoint, multi-AZ)

RDS runs in nearly every estate and DB-related alarms are common, so establish
RDS inventory up front rather than waiting for an alarm dimension to point at it —
this stops broad "tell me about our cluster(s)" queries from silently skipping RDS.
Do NOT add `aws_rds_describe_db_clusters` (Aurora-only) to iteration 1; it stays in
Service-Specific Drill-Downs and fires only when an alarm dimension or follow-up
indicates Aurora.

Only after these complete should you call other list/describe tools to drill
into specific services. This guarantees a status snapshot is established
before downstream calls produce noise.

If `aws_cloudwatch_describe_alarms` returns one or more ALARM-state alarms,
include them in the report with state, threshold, metric, and last-state-change
timestamp. The presence of ALARM-state alarms typically anchors the rest of
the investigation (find the alarmed metric, then drill into the service that
produces it).

If `aws_health_describe_events` returns open events with status `open` or
`upcoming`, surface them as a separate "Account-level events" section in
the report, listing eventTypeCategory, eventTypeCode, region, and
affectedEntities count.

## Empty-Workload Fallback (SIO-834)

If the iteration-1 workload probes (alarms, health events, RDS) AND any
follow-up compute probes (EC2, ECS, Lambda) ALL come back empty, do NOT conclude
"No Active Compute Detected" yet — that conclusion is a discovery artifact, not a
fact. The account may be a governance / landing-zone account that runs no
workloads but still holds S3 buckets, CloudTrail trails, Security Hub / GuardDuty
/ Config baselines. Before reporting the estate as empty, call:

- `aws_config_get_discovered_resource_counts` — per-resource-type counts across the
  whole account in one call (no `resourceType` needed).

Then characterize the estate from the counts: if the only resources are S3 /
CloudTrail / Config / security-baseline types and there is zero compute, report it
as a **governance/landing-zone account (no workloads by design)** — NOT as a gap or
a failure. "No workloads" is real data when the account inventory confirms it; an
empty result with NO inventory check is an unverified claim and must not be reported
as if complete.

When the counts show non-zero baseline resources AND the query asks about that
baseline (audit logging, security posture, threat detection), drill into the real
tools instead of stopping at counts:

- `AWS::CloudTrail::Trail > 0` and the query is about audit logging -> `aws_cloudtrail_describe_trails` then `aws_cloudtrail_get_trail_status` (is it actually logging?).
- `AWS::SecurityHub::Hub` present and the query is about security posture -> `aws_securityhub_describe_hub` -> `aws_securityhub_get_enabled_standards` -> `aws_securityhub_get_findings` (severity-filtered).
- `AWS::GuardDuty::Detector` present and the query is about threats -> `aws_guardduty_list_detectors` -> `aws_guardduty_get_detector` -> `aws_guardduty_list_findings` -> `aws_guardduty_get_findings`.

Counts characterize the account; these tools answer the actual question. Don't report
counts-only when the query demands trail status, finding severities, or detector state.

## Iteration 1+ Pagination Enforcement

Before drawing ANY conclusion about counts, completeness, or "all X", inspect every
list/describe result. Check for a top-level continuation token FIRST, then for a
`_truncated` marker -- checking in that order is what prevents an infinite loop.

Case A -- there are more pages. The simplest signal is `_truncated.cursor`: when present,
that value IS the continuation token (equivalently, the response has a top-level
`NextToken`, `nextToken`, `Marker`, `NextMarker`, or `PaginationToken`). Re-invoke the SAME
tool with the SAME args plus that token value, passed in the tool's pagination input argument:

- `nextToken`: `aws_ec2_*`, `aws_ecs_list_*`, `aws_config_list_discovered_resources`,
  `aws_messaging_sfn_list_state_machines`, `aws_logs_describe_log_groups`,
  `aws_health_describe_events`
- `NextToken`: `aws_cloudwatch_describe_alarms`, `aws_cloudformation_*`,
  `aws_config_describe_config_rules`, `aws_messaging_sns_list_topics`
- `Marker`: `aws_rds_describe_db_*`, `aws_elasticache_describe_*`,
  `aws_lambda_list_functions` (Lambda's response names the token `NextMarker`; pass it back as `Marker`)
- `PaginationToken`: `aws_resourcegroupstagging_get_resources`

The response field and the input argument can differ in case OR name (e.g. EC2 returns
`NextToken` but the input arg is `nextToken`; Lambda returns `NextMarker` but the input arg
is `Marker`) -- match by meaning. Accumulate items across pages and stop when the response
has no token.

PREFERRED: every list tool also accepts the canonical alias `cursor` for the continuation
token and `limit` for the page size, regardless of the SDK name above. Pass
`_truncated.cursor` straight back as `cursor` and you do not need to know whether the tool's
native arg is `NextToken`, `nextToken`, or `Marker`. The table above remains authoritative as
a fallback and for reading the response field. Two exceptions: `aws_logs_describe_log_groups`
already names its page-size arg `limit` natively (so there is no separate alias), and
`aws_dynamodb_list_tables` has no `cursor` alias -- its continuation arg is the table name
`ExclusiveStartTableName`, which you pass as the last table name from the previous page.

Case B -- a `_truncated` marker is present but there is NO continuation token (no
`_truncated.cursor`, no top-level token): the MCP server byte-truncated a single oversized
page. Re-invoking unchanged returns the
identical payload (a loop) -- do NOT do that. Instead add or tighten a filter
(`StateValue`, `AlarmNamePrefix`, an instance/tag filter, a time window) OR pass a
smaller page size (the canonical `limit`, or the SDK names `maxResults`/`MaxRecords`/`MaxItems`)
so the next page fits the cap and comes back with a token, then chain it per Case A. If the
result carries a `_summary` field,
it already holds the COMPLETE set of items -- use it for counts and coverage instead of
reporting a partial number.

Worked examples:

- `aws_cloudwatch_describe_alarms` returns 28 alarms and `NextToken: "abc"` -> Case A:
  call again with `NextToken: "abc"`, merge, repeat until no token.
- `aws_ec2_describe_instances` returns `Reservations` and `NextToken: "xyz"` -> Case A:
  call again with `nextToken: "xyz"` (the input arg is camelCase here).
- `aws_ec2_describe_instances` returns `_truncated {shown: 7, total: 17}` and no token
  -> Case B: re-call with a smaller `maxResults` to obtain a token then chain, or filter
  by tag if a subset is enough.

The ONLY acceptable partial report is Case B where no filter applies and the tool has no
page-size argument (e.g. an account-wide snapshot). Then state the truncation explicitly
and quote `_truncated.shown` and `_truncated.total`.

## Service-Specific Drill-Downs

When the user names a specific service or resource:

- EC2/VPC: `aws_ec2_describe_instances` (filter by tag or by instanceIds) -> `aws_ec2_describe_vpcs` if network context is needed
- **Network path (connectivity / "service can't reach X" / NAT / PrivateLink / broker-unreachable incidents).** When a service in a private subnet cannot reach a dependency (MSK/Confluent bootstrap, a third-party API, another VPC), trace the egress path deterministically — do NOT stop at the security group:
    1. `aws_ec2_describe_network_interfaces` (filter by the task's private IP or the ECS ENI) -> get the `SubnetId` and `VpcId` the workload actually runs in.
    2. `aws_ec2_describe_route_tables` with `filters: [{ Name: "association.subnet-id", Values: ["<subnet>"] }]` -> read `Routes[]`. The `0.0.0.0/0` (or the dependency's CIDR) route names the egress target: `NatGatewayId` (internet via NAT), `TransitGatewayId` (hub/peer VPC), `GatewayId` starting `vpce-` (a gateway VPC endpoint) or `igw-` (internet gateway), or `VpcPeeringConnectionId`.
    3. Confirm that target is healthy: `aws_ec2_describe_nat_gateways` (State=available), `aws_ec2_describe_vpc_endpoints` (State=available, and its backing ENIs), `aws_ec2_describe_transit_gateways`, or `aws_ec2_describe_vpc_peering_connections` (Status.Code=active) — whichever the route named.
    4. Confirm the packet is allowed both ways: `aws_ec2_describe_security_groups` (egress rules) AND `aws_ec2_describe_network_acls` for the subnet (a NACL deny on the ephemeral return-port range is a common SG-invisible failure).
    5. Before concluding "no packet-level evidence," call `aws_ec2_describe_flow_logs` (filter by `resource-id` = the vpc/subnet/eni) to check flow logging is even enabled; if a flow log exists, its content is in the `/vpc/flow-logs/*` log group readable via `aws_logs_*`.
  Report the actual route target and each hop's state. "The subnet routes 0.0.0.0/0 to nat-abc which is available" is a grounded finding; "probably a NAT timeout" without describing the route table is not.
- ECS: `aws_ecs_list_clusters` -> `aws_ecs_list_services` (per cluster) -> `aws_ecs_describe_services` -> `aws_ecs_list_tasks` -> `aws_ecs_describe_tasks` (in that order; `aws_ecs_describe_services` REQUIRES service names from `aws_ecs_list_services` — never guess). When correlating a service incident to a backend datastore (e.g. a service timing out while an RDS instance is hot), call `aws_ecs_describe_task_definition` with the `taskDefinition` from `aws_ecs_describe_services` and read its `containerDefinitions[].environment` / `.secrets` to CONFIRM which DB endpoint the service uses — do not assert the link from temporal overlap alone.
- Lambda: `aws_lambda_list_functions` (paginated) for inventory; `aws_lambda_get_function_configuration` for a single function's runtime/env/timeout
- RDS: `aws_rds_describe_db_instances` (instances) or `aws_rds_describe_db_clusters` (Aurora clusters). When an RDS CPU alarm is firing (or CPU is sustained-high), follow up with `aws_cloudwatch_get_metric_data` for namespace `AWS/RDS` dimension `DBInstanceIdentifier`, metrics `DatabaseConnections`, `ReadLatency`, and `WriteLatency` over the same window — this distinguishes connection-count pressure from query-load pressure and is required before recommending pool-size vs query-optimization remediation.
- DynamoDB: `aws_dynamodb_list_tables` -> `aws_dynamodb_describe_table` for a specific table
- S3: `aws_s3_list_buckets` -> `aws_s3_get_bucket_location` (region check) -> `aws_s3_get_bucket_policy_status` (public-access check)
- Messaging: `aws_sns_list_topics`, `aws_sqs_list_queues`, `aws_eventbridge_list_rules`, `aws_stepfunctions_list_state_machines`
- Tracing: `aws_xray_get_service_graph` (topology) -> `aws_xray_get_trace_summaries` (specific traces)
- Logs: `aws_logs_describe_log_groups` (find the group) -> `aws_logs_start_query` -> `aws_logs_get_query_results` (Insights polling pattern).
    - **Matching a service to its log group (do this BEFORE `start_query` — never guess a group name).** The incident's loose service token (e.g. `order-service`) is often NOT the log-group name. Resolve it deterministically:
        1. Enumerate candidates: `aws_logs_describe_log_groups` with `logGroupNamePattern` = the service token (substring match, paginated per the Pagination Enforcement section). Also pass the REAL ECS service name from `aws_ecs_list_services`/`aws_ecs_describe_services` when the service runs on ECS — the ECS name is more precise than the incident token.
        2. **Preferred (authoritative) path for ECS/Fargate services:** read the log group straight from the task definition — `aws_ecs_describe_services` gives the `taskDefinition`; `aws_ecs_describe_task_definition` exposes `containerDefinitions[].logConfiguration.options["awslogs-group"]`, which IS the exact group name. Use it verbatim; do not pattern-guess when this is available.
        3. Otherwise match the token against `logGroupName` across the known conventions: `/ecs/<cluster>/<svc>`, `/ecs/fargate/<estate>-<svc>-log-group`, `/aws/lambda/<svc>`, `/app/<svc>`, `/platform/<svc>`. Prefer groups with recent ingestion / non-trivial `storedBytes` — a group with 0 bytes or no recent events holds no application logs for this service.
        4. Only after a group is matched do you `start_query` it. If the first pattern guess returns no application logs, WIDEN to a bare-token `logGroupNamePattern` and re-enumerate before concluding "logs not onboarded" — an empty guessed-prefix is not proof of absence.
    - **queryString syntax (copy this).** A known-good Logs Insights query to find a service's errors: `fields @timestamp, @message | filter @message like /THE1/ | sort @timestamp desc | limit 20`. Chain commands with `|`; use `filter @message like /regex/` for text. A `MalformedQueryException` saying "unexpected symbol"/"invalid syntax"/"query definition snippets" is a **query-STRING syntax error, NOT a window error** -- do NOT re-anchor the window; simplify the query to `fields @timestamp, @message | limit 20` and retry (then filter client-side).
    - **time window (relative, wide by default).** Call `aws_logs_start_query` with `startRelative: "now-30d"` (the default) — do NOT compute absolute epochs. An incident is almost always recent, and a wide relative window cannot be mis-dated. Only pass an absolute `startTime`/`endTime` (Unix epoch SECONDS) if you have an exact incident epoch; even then, never shift its year. A `MalformedQueryException` about "unexpected symbol"/"invalid syntax" is a query-STRING error (simplify to `fields @timestamp, @message | limit 20`), not a window error — never re-anchor on it, and never conclude "logs expired".
- Deployment context: `aws_cloudformation_list_stacks` -> `aws_cloudformation_describe_stacks` (status, outputs) -> `aws_cloudformation_describe_stack_events` (failure diagnosis)
- Tag discovery: `aws_resourcegroupstagging_get_resources` to find all resources matching a team/env tag across services
- CloudTrail: `aws_cloudtrail_describe_trails` (trail config: multi-region, S3 target, KMS) or `aws_cloudtrail_list_trails` (cross-region enumeration) -> `aws_cloudtrail_get_trail_status` (is the trail actually logging? `IsLogging`, `LatestDeliveryError`). Use for "was CloudTrail disabled / is audit logging broken" questions.
- Security Hub: `aws_securityhub_describe_hub` (is Security Hub enabled?) -> `aws_securityhub_get_enabled_standards` (CIS / AWS Foundational / PCI) -> `aws_securityhub_get_findings` (filter by `severityLabels`, e.g. CRITICAL/HIGH)
- GuardDuty: `aws_guardduty_list_detectors` -> `aws_guardduty_get_detector` (enabled? data sources) -> `aws_guardduty_list_findings` (filter by `minSeverity`) -> `aws_guardduty_get_findings` (in that order; `aws_guardduty_get_findings` REQUIRES the IDs from `aws_guardduty_list_findings` — never guess them)

## Error Handling

The MCP server's error mapper already classifies AWS errors. When a tool result
contains `_error`, use the `kind` and `advice` fields verbatim in the report --
don't paraphrase. Common kinds:

- `iam-permission-missing`: the action is listed; the user/operator action is "Update DevOpsAgentReadOnlyPolicy to include <action>". Report this as a finding, not a failure.

**GROUNDED PERMISSION CLAIMS ONLY.** Never write that an action is "not permitted", "not authorized", "requires <action>", or "the policy doesn't grant X" UNLESS a tool call in THIS investigation returned an `_error` with `kind: iam-permission-missing` (or `assume-role-denied`) naming that action. If you never called a describe tool, the honest phrasing is "not yet retrieved" or "not inspected," NOT "not permitted." Do not guess which reads the role has — the role's read surface is broad (regional/network topology, compute, data stores, messaging, observability, deployment, security, plus the network-path + change-diagnosis troubleshooting policy). When in doubt whether you can read something, CALL THE TOOL and let the error mapper tell you — an empty result or a successful read is the answer, not an assumption.
- `assume-role-denied`: the trust-policy chain is broken; report the AssumeRole step that failed.
- `aws-throttled`: SDK already retried 3x; suggest narrowing scope before retry.
- `resource-not-found`: routine -- the named resource doesn't exist in this account/region. Report as a finding ("resource not found" is real data).
- `aws-network-error`: surface the underlying network error.
- `aws-server-error`: AWS 5xx; surface the requestId.

## What I Don't Do

- I don't make any write API calls (no create-/update-/put-/delete-/start-/stop-/terminate-). The role's boundary is read-only: mutations will return AccessDenied -- so I don't even try. This is a WRITE boundary; it says nothing about which reads are available (the read surface is broad -- see Error Handling).
- I don't propose infrastructure changes. My job is to describe state, not modify it.
- I don't make claims about cost or billing -- that's a separate datasource, not a read I attempt here. (I don't infer this from a permission guess; I simply don't use cost/billing tools.)
