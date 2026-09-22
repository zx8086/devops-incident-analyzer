# Handover: tag Karpenter-provisioned resources in eu-mendix-platform-prd

- **Date**: 2026-09-22
- **Owner of the work**: the platform/EKS team that owns the Mendix Karpenter config (NOT this repo)
- **Account**: `654654584630` / `eu-mendix-platform-prd`, region `eu-central-1`
- **Cluster**: `mendix-platform-eks-prd`
- **Related (already done, different repo)**: monitor-side noise suppression in
  `devops-incident-analyzer`, `packages/pi-coms/scripts/monitor/checks/churn-tags.ts`
- **Linear**: to be created for the platform team (this document is the issue body)
- **Monitor-side counterpart (done, this repo)**:
  [SIO-1868](https://linear.app/siobytes/issue/SIO-1868) — suppresses the noise
  in the digest; explicitly NOT a fix for the underlying non-compliance

## TL;DR

AWS Config rule `OrgConfigRule-required-tags-lf3sbwf9` requires six business tags
on every resource. Karpenter provisions EC2 instances with only machine tags, so
every node it launches — plus the ENIs and EBS volumes derived from it — is born
NON_COMPLIANT. Measured live on 2026-09-22: **230 non-compliant resources**, of
which **62 are Karpenter/VPC-CNI-owned** and churn continuously (one flagged ENI
was already deleted 24h later).

The fix is one field: `spec.tags` on the `EC2NodeClass`. Karpenter then applies
those tags to every instance, volume and ENI it creates from that point on.

Success looks like: a newly launched Karpenter node carries all six required
tags, and the non-compliant count for this rule drops by roughly 62.

## Why this landed on your desk

The DevOps incident monitor emails a daily digest per AWS account. For
`eu-mendix-platform-prd` that digest was dominated by required-tags findings on
resources that are working exactly as designed — Karpenter scaling the cluster.

The monitor side is already handled: it now classifies resources by ownership tag
and drops autoscaler-owned ones from the digest. **That is noise suppression, not
a fix.** The resources are still genuinely non-compliant with the org Config rule;
they are simply no longer paged about. This ticket is the actual remediation.

## Evidence (captured live, 2026-09-22)

Rule parameters — `aws configservice describe-config-rules --config-rule-names OrgConfigRule-required-tags-lf3sbwf9`:

```json
{"tag1Key":"BlueprintID","tag2Key":"BusinessUnit","tag3Key":"CostCenter",
 "tag4Key":"BusinessCriticality","tag5Key":"DataClassification","tag6Key":"Owner"}
```

Scope is **empty**, so the rule evaluates every resource type in the account.
Note AWS Config's `required-tags` checks tag KEYS, not values — an empty value
still counts as compliant, but the key must be present.

Tags actually on a live Karpenter node today:

```
Name, aws:ec2:fleet-id, aws:ec2launchtemplate:id, aws:ec2launchtemplate:version,
aws:eks:cluster-name, eks:eks-cluster-name, karpenter.k8s.aws/ec2nodeclass,
karpenter.sh/discovery, karpenter.sh/nodeclaim, karpenter.sh/nodepool,
kubernetes.io/cluster/mendix-platform-eks-prd
```

Not one of the six required keys.

Non-compliant breakdown for this rule (230 total, first page of 100 shown by type
in the original sample): 48 NetworkInterface, 16 Instance, 7 CloudFormation Stack,
7 SecurityGroup, 6 Subnet, 5 RouteTable, 5 Volume, 2 ACM cert, 1 ASG, 1 IGW,
1 NACL, 1 VPC.

Of the 195 ARN-mappable (ENI/instance/volume) pairs, a tag lookup classified:

| Bucket | Count | Fixed by this ticket? |
|---|---|---|
| Karpenter-owned (`karpenter.sh/nodepool`, `karpenter.k8s.aws/ec2nodeclass`) | 62 | **Yes** |
| EBS CSI PersistentVolumes (`ebs.csi.aws.com/cluster`) | 115 | No — see Out of scope |
| AWS-managed ENIs (NAT/TGW/ALB/EKS control plane) | 14 | No — untaggable |

## What to change

One `EC2NodeClass` and one `NodePool` are in use:

```
ec2nodeclass = default        nodepool = general-purpose      (14 instances)
```

Add `spec.tags` to the `EC2NodeClass` named `default`:

```yaml
# apiVersion below is Karpenter v1 (current for EKS 1.35, which this cluster
# runs). Confirm against the installed CRD -- `kubectl get crd
# ec2nodeclasses.karpenter.k8s.aws -o jsonpath='{.spec.versions[*].name}'` --
# since an older install may still serve v1beta1. `spec.tags` exists in both.
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # ... existing amiFamily / subnetSelectorTerms / securityGroupSelectorTerms ...
  tags:
    BlueprintID: "00000000-0000-0000-0000-000000000000"
    BusinessUnit: "infra"
    CostCenter: "PVHQ6565"
    BusinessCriticality: "business_critical"
    DataClassification: "confidential"
    Owner: "Simon Owusu"
```

**Confirm these values with whoever owns tagging standards before applying.**
They were read from an existing compliant instance in this same account, so they
are consistent with local practice — but `Owner` in particular should probably be
a team or distribution list rather than an individual, and `BlueprintID` is an
all-zero placeholder on that instance, which may or may not be intentional.

Karpenter propagates `spec.tags` to the instance, its volumes and its ENIs.

### Two things to watch

1. **Karpenter forbids restricted tag keys** in `spec.tags` — anything under
   `karpenter.sh/`, `kubernetes.io/cluster/...`, `eks:eks-cluster-name`. The six
   above are all fine; the webhook rejects the NodeClass if you add a reserved one.
2. **Existing nodes are not retagged.** `spec.tags` applies at launch. The 62
   current resources clear as nodes roll naturally, or immediately via a drift
   rollout if you prefer — your call on disruption budget.

## Verification

After applying, force or await one new node, then:

```bash
# 1. A newly launched Karpenter node carries all six keys.
aws ec2 describe-instances --profile eu-mendix-platform-prd --region eu-central-1 \
  --filters "Name=tag-key,Values=karpenter.sh/nodepool" \
  --query 'Reservations[].Instances[].Tags[?Key==`BlueprintID`||Key==`BusinessUnit`||Key==`CostCenter`||Key==`BusinessCriticality`||Key==`DataClassification`||Key==`Owner`].[Key,Value]' \
  --output text
# Expect 6 rows per instance.

# 2. Its ENIs and volumes inherited them (this is the half that matters most --
#    ENIs were 48 of the 230 findings).
aws ec2 describe-network-interfaces --profile eu-mendix-platform-prd --region eu-central-1 \
  --filters "Name=tag-key,Values=karpenter.sh/nodepool" \
  --query 'NetworkInterfaces[].TagSet[?Key==`CostCenter`].Value' --output text

# 3. Re-evaluate the rule and count what is left.
aws configservice start-config-rules-evaluation \
  --config-rule-names OrgConfigRule-required-tags-lf3sbwf9 \
  --profile eu-mendix-platform-prd --region eu-central-1
# wait a few minutes, then:
aws configservice get-compliance-details-by-config-rule \
  --config-rule-name OrgConfigRule-required-tags-lf3sbwf9 \
  --compliance-types NON_COMPLIANT --limit 100 \
  --profile eu-mendix-platform-prd --region eu-central-1 \
  --query 'length(EvaluationResults)'
```

Baseline to compare against: **230 non-compliant pairs on 2026-09-22**, 62 of them
Karpenter-owned. A successful rollout should show those 62 clear as nodes recycle.

Note Config re-evaluation is change-triggered and can lag; a stale NON_COMPLIANT
reading shortly after the change is usually the evaluation, not the tags. Check
the instance tags directly (step 1) before concluding the fix failed.

## Out of scope

- **115 EBS CSI PersistentVolumes** (`ebs.csi.aws.com/cluster`,
  `kubernetes.io/created-for/pvc/name`). Created by the EBS CSI driver for PVCs,
  some dating to 2024-11-25. Fixing these means `extraVolumeTags` on the CSI
  driver's StorageClass, which is a separate change with different blast radius.
  Worth its own ticket.
- **14 AWS-managed ENIs** (NAT gateway, transit gateway, ALB, EKS control plane).
  AWS owns these; they cannot be tagged. They will stay non-compliant, and the
  monitor deliberately keeps reporting them rather than hiding a real gap.
- **Non-EC2 resource types** flagged by the same rule (7 CloudFormation stacks,
  6 subnets, 5 route tables, the VPC, an ASG). Many are Control Tower StackSets.
  Belongs with whoever owns the Org Config rule, not with Karpenter.

## Contact

Raised from the DevOps incident monitor for `eu-mendix-platform-prd`.
Monitor-side context: `packages/pi-coms/scripts/monitor/checks/churn-tags.ts` in
`devops-incident-analyzer`, and `deploy/suppressions.yaml` in the same package.
