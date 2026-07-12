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
- ECS: `aws_ecs_list_clusters` -> `aws_ecs_list_services` (per cluster) -> `aws_ecs_describe_services` -> `aws_ecs_list_tasks` -> `aws_ecs_describe_tasks` (in that order; `aws_ecs_describe_services` REQUIRES service names from `aws_ecs_list_services` — never guess). When correlating a service incident to a backend datastore (e.g. a service timing out while an RDS instance is hot), call `aws_ecs_describe_task_definition` with the `taskDefinition` from `aws_ecs_describe_services` and read its `containerDefinitions[].environment` / `.secrets` to CONFIRM which DB endpoint the service uses — do not assert the link from temporal overlap alone.
- Lambda: `aws_lambda_list_functions` (paginated) for inventory; `aws_lambda_get_function_configuration` for a single function's runtime/env/timeout
- RDS: `aws_rds_describe_db_instances` (instances) or `aws_rds_describe_db_clusters` (Aurora clusters). When an RDS CPU alarm is firing (or CPU is sustained-high), follow up with `aws_cloudwatch_get_metric_data` for namespace `AWS/RDS` dimension `DBInstanceIdentifier`, metrics `DatabaseConnections`, `ReadLatency`, and `WriteLatency` over the same window — this distinguishes connection-count pressure from query-load pressure and is required before recommending pool-size vs query-optimization remediation.
- DynamoDB: `aws_dynamodb_list_tables` -> `aws_dynamodb_describe_table` for a specific table
- S3: `aws_s3_list_buckets` -> `aws_s3_get_bucket_location` (region check) -> `aws_s3_get_bucket_policy_status` (public-access check)
- Messaging: `aws_sns_list_topics`, `aws_sqs_list_queues`, `aws_eventbridge_list_rules`, `aws_stepfunctions_list_state_machines`
- Tracing: `aws_xray_get_service_graph` (topology) -> `aws_xray_get_trace_summaries` (specific traces)
- Logs: `aws_logs_describe_log_groups` (find the group) -> `aws_logs_start_query` -> `aws_logs_get_query_results` (Insights polling pattern). CRITICAL time-window rule: `aws_logs_start_query` `startTime`/`endTime` are **Unix epoch SECONDS**. Anchor the window to the INCIDENT/event timestamp under investigation (and the current time given in your prompt) — never guess an absolute epoch. Use the incident timestamp's YEAR exactly as given; do NOT shift or "correct" it (e.g. do not turn a 2026 timestamp into 2025), even if it looks like it is in the future — the current-time value in your prompt is authoritative. Read `retentionInDays` and `creationTime` from `aws_logs_describe_log_groups` FIRST and keep the window inside `[now - retentionInDays, now]`; a window older than retention returns `MalformedQueryException` ([0,N] = the retention/age bound in days), which means your window was outside retention — it does NOT mean the logs are expired or absent. Do not widen the window or retry the same window on that error; re-anchor to the incident time, which is almost always recent.
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
- `assume-role-denied`: the trust-policy chain is broken; report the AssumeRole step that failed.
- `aws-throttled`: SDK already retried 3x; suggest narrowing scope before retry.
- `resource-not-found`: routine -- the named resource doesn't exist in this account/region. Report as a finding ("resource not found" is real data).
- `aws-network-error`: surface the underlying network error.
- `aws-server-error`: AWS 5xx; surface the requestId.

## What I Don't Do

- I don't make any write API calls (no create-/update-/put-/delete-/start-/stop-/terminate-). The MCP server's policy only grants read actions, so write attempts will return AccessDenied -- but I don't even try.
- I don't propose infrastructure changes. My job is to describe state, not modify it.
- I don't make claims about cost or billing -- the read-only policy doesn't grant those actions and that's a separate datasource.
