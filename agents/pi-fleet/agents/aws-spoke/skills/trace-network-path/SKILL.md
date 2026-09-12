---
name: trace-network-path
description: Walk an AWS connectivity failure hop by hop instead of stopping at the security group -- egress from ENI through subnet, route table and route-target health to SG egress AND the subnet NACL, with the ingress mirror from DNS through load balancer, listener and target group to target health.
---

# Skill: Trace Network Path

## Purpose
"Probably a NAT timeout" and "the security group must be blocking it" are
guesses that survive because the walk stopped early. Connectivity has a fixed
sequence of hops; naming the hop that actually fails, with the resource that
proves it, turns a hunch into a finding.

## Procedure
Establish the direction first. A workload failing to reach something is egress;
something failing to reach a workload is ingress. Then walk that direction in
order, recording each hop even when it passes.

Egress:
1. Start at the ENI of the failing resource -- its subnet and VPC are the
   coordinates every later hop depends on.
2. Resolve the subnet's route table. If a subnet-id filter returns nothing, the
   subnet is implicitly on the VPC MAIN route table; re-query by vpc-id before
   concluding "no route table". This is the most common false negative in the
   walk.
3. Read the route that matches the destination, then confirm the route TARGET
   is healthy -- NAT gateway, VPC endpoint, transit gateway, or peering
   connection. A route pointing at a deleted or pending target looks like a
   valid route.
4. Check security group egress.
5. Check the subnet NACL, always, even when the SG allows the traffic. A NACL
   deny on ephemeral RETURN ports is invisible in security group rules and
   presents as a timeout rather than a refusal.

Ingress (the mirror):
1. The DNS record, normalizing trailing dots and case before comparing names.
2. The load balancer it resolves to, and its scheme.
3. The listener on the expected port and protocol.
4. The target group behind that listener.
5. Target health, which is where a healthy-looking path usually ends.

## Rules
- Do not stop at the security group. It is one hop of five, and the hop that
  most often looks conclusive while being irrelevant.
- Report every hop checked, including the ones that passed. "The subnet routes
  0.0.0.0/0 to a NAT which is available" is a grounded finding;
  "probably a NAT timeout" without the route table is not.
- A hop that could not be read is a scoping fact, not a failed hop. Quote the
  auth error and say which hop remains unknown.
- Never infer a NACL from an SG, or target health from a target group's
  existence. Each hop needs its own read.
- Read-only throughout. A remediation belongs in the recommendation, never in
  a command.
- Evidence names the resource at the hop -- the route table id, the NACL id,
  the target group ARN -- not just the command family.
