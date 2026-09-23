# Core network prerequisites are separate high-risk changes

Tags: Cloud WAN, IPAM, aws-lz-network-core, change gate

User: Add an approved Cloud WAN segment and IPAM pool to the Landing Zone core network.

Expected behaviour:

Route to `aws-lz-network-core`. Verify the accepted network design, current WAN YAML contract, live segment and pool inventory, and representative siblings. Treat the shared prerequisite as a separate high-risk merge request that must land before a workload VPC consumes it.

Never infer a segment, CIDR, IPAM pool, account, or environment. Do not apply Terraform or combine the core change with application onboarding.
