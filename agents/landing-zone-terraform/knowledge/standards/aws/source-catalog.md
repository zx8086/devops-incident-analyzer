---
type: Reference
title: AWS standards source catalog
description: Primary AWS sources used to validate Landing Zone recommendations without overriding PVH repository contracts.
resource: aws-documentation
tags: [aws, standards, evidence]
status: stable
sources:
  - id: aws-well-architected
    resource: https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
    title: AWS Well-Architected Framework
    author: aws
  - id: aws-terraform-best-practices
    resource: https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/introduction.html
    title: Best practices for using the Terraform AWS Provider
    author: aws
---

# AWS standards source catalog

Use AWS documentation to validate service behavior, security controls, and
well-architected guidance. It is an external standards source, not authority for
PVH-specific account IDs, OU placement, tags, module interfaces, backend
topology, CI behavior, or approval policy.

Primary sources:

- AWS Well-Architected Framework:
  `https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html`
- AWS Prescriptive Guidance, Terraform AWS Provider best practices:
  `https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/introduction.html`
- Code structure and organization:
  `https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/structure.html`
- Backend practices:
  `https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/backend.html`
- Security practices:
  `https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/security.html`

Reconcile every recommendation against the checked-out PVH repository and
accepted ADRs. Report conflicts instead of normalizing production behavior
opportunistically.
