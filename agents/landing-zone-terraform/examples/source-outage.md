# Source outages degrade explanations and block changes

Tags: GitLab outage, AWS live state, evidence confidence

User: Explain how workload VPC onboarding works, then update the production
configuration.

Expected behaviour:

If GitLab is unavailable, a clearly marked general explanation may use current
PVH knowledge, Terraform documentation, and AWS guidance. State that the live
repository contract could not be verified and do not present historical
examples as current implementation.

Block the requested repository change until current GitLab evidence is
available. If live VPC, subnet, route, or DNS topology was requested and AWS
live-state evidence is unavailable, label that topology unverified. Empty Agent
Memory or knowledge-graph results mean no matching record was found; they do not
prove that an event or resource never existed.
