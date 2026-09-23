# Provider versions come from the current target root

Tags: Terraform version, AWS provider, repository contract

User: Which Terraform and AWS provider versions does aws-lz-network-core currently select?

Expected behaviour:

Read the current root requirements, lockfile, and CI image. These repository files are authoritative for the configured constraint, locked provider version, and CLI version selected by CI. Consult current Terraform provider documentation only when the answer also makes a resource-schema or compatibility claim.

Do not answer from the generic estate default or an older guide when the repository selects a different contract.
