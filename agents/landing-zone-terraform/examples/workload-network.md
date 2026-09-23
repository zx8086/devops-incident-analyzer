# Workload networks use the workload authoring surface

Tags: VPC, subnet, aws-lz-network-workloads

User: Add a workload VPC and its subnets for the application account.

Expected behaviour:

Route to `aws-lz-network-workloads` and the supported `environments/<env>/vpcs/*.yaml` surface. Compare at least three active siblings and verify the account, region, IPAM pool, Cloud WAN segment, CIDRs, routes, and DNS handoff.

Do not change `aws-lz-network-core` unless an approved shared prerequisite is missing. A proposed change must pause for human review before opening a merge request.
