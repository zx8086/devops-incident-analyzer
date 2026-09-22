---
type: Reference
title: Terraform standards source catalog
description: Primary HashiCorp language, module, provider, and Registry sources used for live contract validation.
resource: terraform-documentation
tags: [terraform, aws-provider, standards, evidence]
status: stable
sources:
  - id: terraform-style
    resource: https://developer.hashicorp.com/terraform/language/style
    title: Terraform configuration language style guide
    author: hashicorp
  - id: terraform-providers-modules
    resource: https://developer.hashicorp.com/terraform/language/modules/develop/providers
    title: Providers within modules
    author: hashicorp
  - id: terraform-aws-provider
    resource: https://registry.terraform.io/providers/hashicorp/aws/latest/docs
    title: Terraform AWS provider documentation
    author: hashicorp
---

# Terraform standards source catalog

Validate new or changed HCL against the exact Terraform and AWS provider
versions selected by the target repository. Primary sources:

- Terraform language style guide:
  `https://developer.hashicorp.com/terraform/language/style`
- Standard module structure:
  `https://developer.hashicorp.com/terraform/language/modules/develop/structure`
- Providers within modules:
  `https://developer.hashicorp.com/terraform/language/modules/develop/providers`
- Provider requirements:
  `https://developer.hashicorp.com/terraform/language/providers/requirements`
- Terraform test:
  `https://developer.hashicorp.com/terraform/language/tests`
- AWS provider Registry documentation:
  `https://registry.terraform.io/providers/hashicorp/aws/latest/docs`

The PVH repository contract takes precedence over generic style where they
differ. Do not use `latest` documentation to infer that a feature exists in an
older provider selected by the repository; open the versioned contract first.
