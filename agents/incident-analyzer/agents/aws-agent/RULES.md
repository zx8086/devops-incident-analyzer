# Rules

## Iteration 1 Probe Discipline

When the user query references infrastructure health, account-wide status, or
asks "what's going on in AWS" or "is X broken" or "are there any alarms",
issue these probes IN PARALLEL in the first iteration BEFORE any
list/describe/enumerate tool:

- `aws_cloudwatch_describe_alarms` — current alarm states (filter StateValue=ALARM)
- `aws_health_describe_events` — open Health events (account-level)

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

Case B -- a `_truncated` marker is present but there is NO continuation token (no
`_truncated.cursor`, no top-level token): the MCP server byte-truncated a single oversized
page. Re-invoking unchanged returns the
identical payload (a loop) -- do NOT do that. Instead add or tighten a filter
(`StateValue`, `AlarmNamePrefix`, an instance/tag filter, a time window) OR pass a
smaller `maxResults`/`MaxRecords`/`MaxItems` so the next page fits the cap and comes
back with a token, then chain it per Case A. If the result carries a `_summary` field,
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
- ECS: `aws_ecs_list_clusters` -> `aws_ecs_list_services` (per cluster) -> `aws_ecs_describe_services` -> `aws_ecs_list_tasks` -> `aws_ecs_describe_tasks` (in that order; `aws_ecs_describe_services` REQUIRES service names from `aws_ecs_list_services` — never guess)
- Lambda: `aws_lambda_list_functions` (paginated) for inventory; `aws_lambda_get_function_configuration` for a single function's runtime/env/timeout
- RDS: `aws_rds_describe_db_instances` (instances) or `aws_rds_describe_db_clusters` (Aurora clusters)
- DynamoDB: `aws_dynamodb_list_tables` -> `aws_dynamodb_describe_table` for a specific table
- S3: `aws_s3_list_buckets` -> `aws_s3_get_bucket_location` (region check) -> `aws_s3_get_bucket_policy_status` (public-access check)
- Messaging: `aws_sns_list_topics`, `aws_sqs_list_queues`, `aws_eventbridge_list_rules`, `aws_stepfunctions_list_state_machines`
- Tracing: `aws_xray_get_service_graph` (topology) -> `aws_xray_get_trace_summaries` (specific traces)
- Logs: `aws_logs_describe_log_groups` (find the group) -> `aws_logs_start_query` -> `aws_logs_get_query_results` (Insights polling pattern)
- Deployment context: `aws_cloudformation_list_stacks` -> `aws_cloudformation_describe_stacks` (status, outputs) -> `aws_cloudformation_describe_stack_events` (failure diagnosis)
- Tag discovery: `aws_resourcegroupstagging_get_resources` to find all resources matching a team/env tag across services

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
