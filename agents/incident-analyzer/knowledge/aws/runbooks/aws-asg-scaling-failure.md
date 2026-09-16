---
type: Runbook
title: "AWS Auto Scaling Activity Failure Investigation"
description: "Diagnose failed or cancelled Auto Scaling activities: capacity, launch template, or permissions."
status: stable
tags: [aws, autoscaling, ec2, capacity]
generated:
  by: human:simon
  at: 2026-09-16
triggers:
  metrics:
    - scaling activity
    - InsufficientInstanceCapacity
    - auto scaling
    - ASG
    - launch template
    - capacity
  services:
    - autoscaling
    - ec2
  match: any
tools:
  - aws_ec2_describe_instances
  - aws_cloudwatch_get_metric_data
  - aws_logs_start_query
  - aws_logs_get_query_results
---

# Auto Scaling activity failures

Raised by the monitor's `scaling` check when Auto Scaling reports an activity
with `StatusCode` `Failed` or `Cancelled`. Auto Scaling has already classified
it; the discriminator is the API's own vocabulary, so there is no threshold to
argue about.

## Read this first: a tooling asymmetry

**There is no `aws_autoscaling_*` MCP tool.** The analyzer's AWS tool facade
does not expose Auto Scaling, so the describe calls below are available to a
fleet spoke through the AWS CLI under its instance role, and are *not*
available to the incident analyzer's sub-agent. If you are the analyzer,
diagnose from the finding's evidence and the EC2 and CloudWatch reads you do
have, and say plainly that the scaling-activity detail was not inspected
rather than implying it was checked and found clean.

On a spoke:

```
aws autoscaling describe-scaling-activities --auto-scaling-group-name <name> --max-records 20
```

## Why this matters more than it looks

A failed scaling activity usually has no alarm attached, so it is invisible
until capacity actually runs out. The failure and the outage are separated by
however long the existing instances cope. Treating it as urgent while nothing
is yet broken is the correct posture, and the diagnosis should say how much
headroom remains.

## Cause classes

The finding carries `evidence.statusMessage` and `evidence.cause`. Classify
from the message:

| Message contains | Cause | What it means |
|---|---|---|
| `InsufficientInstanceCapacity` | AWS has no capacity for that instance type in that AZ right now | Transient but can persist for hours. Mitigation is diversification, not retry |
| `InstanceLimitExceeded`, `VcpuLimitExceeded` | An account quota, not an AWS shortage | A quota increase, and it is a standing problem that will recur |
| `does not exist`, `InvalidGroup`, `InvalidAMIID` | The launch template references something deleted: AMI, security group, subnet, key pair | Broken configuration; every launch will fail until fixed |
| `not authorized to perform: iam:PassRole` | The ASG's service role cannot pass the instance profile | Permissions; frequently a side effect of a role change elsewhere |
| `no Spot capacity`, `spot-instance-request` | Spot market, not on-demand capacity | Expected with spot; the question is whether the mix has an on-demand fallback |
| `Client.VolumeLimitExceeded` | EBS quota | Quota, not compute capacity |

`Cancelled` is not the same as `Failed`: it usually means a later scaling
decision superseded this one, which can be entirely normal during a scale
in/out oscillation. Check whether a successful activity followed shortly
after before reporting a cancelled activity as a fault.

## Order of investigation

1. **Classify the message** against the table. That is usually the whole
   diagnosis.
2. **Establish the impact.** Compare the group's desired capacity against how
   many instances are actually running: `aws_ec2_describe_instances` filtered
   on the `aws:autoscaling:groupName` tag counts what is really there, which is
   available to the analyzer even though the scaling activities are not. A
   failed scale-out that still leaves the group at capacity is a warning; one
   that leaves it below minimum is an incident. `aws_cloudwatch_get_metric_data`
   on `GroupInServiceInstances` and `GroupDesiredCapacity` shows how long the
   gap has been open.
3. **Check whether it is recurring.** A single capacity failure that the next
   activity resolved is noise. The finding's `count` field, and the collapse
   across groups, already tell you whether one cause is hitting many groups
   at once, which is what an AZ-wide capacity shortage looks like.
4. **For capacity causes, check AZ spread.** A group pinned to one subnet
   cannot recover from that AZ running dry, and that is a configuration
   finding worth reporting even after the capacity returns. The availability
   zones of the instances already running (`aws_ec2_describe_instances`) show
   the effective spread regardless of what the group is configured for.
5. **If the instances launched but never became useful**, the scaling activity
   is not the fault: read the boot-time logs with `aws_logs_start_query` and
   `aws_logs_get_query_results` before blaming capacity.

## Reporting

Name the cause class, the group or groups, and the remaining headroom. For a
capacity cause, state whether it is still failing or has since succeeded.
Capacity changes, launch template edits and quota requests are all writes:
propose, never execute.

## All Tools Used Are Read-Only
aws_ec2_describe_instances, aws_cloudwatch_get_metric_data, aws_logs_start_query, aws_logs_get_query_results

---

Source: capacity and launch-failure taxonomy adapted from the AWS Agent Toolkit
`aws-compute` skill (github.com/aws/agent-toolkit-for-aws, Apache-2.0,
Copyright Amazon.com, Inc. or its affiliates).
