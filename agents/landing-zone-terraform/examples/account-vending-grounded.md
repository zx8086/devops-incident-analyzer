# Account vending answers start from the supported YAML surface

Tags: account vending, aws-lz-account-creator, grounded example

User: Show me Terraform for creating an AWS account.

Expected behaviour:

Treat the unqualified request as a PVH Landing Zone request. Route it to
`aws-lz-account-creator`, inspect its current schema, generator, tests, and at
least three active sibling account documents when available. Lead with the
supported `accounts/<application>.yml` authoring surface and use conspicuous
placeholders for every governance-bearing value that has not been verified.

Do not make a standalone `aws_organizations_account` resource the answer of
record. Generated module calls or the underlying resource may be explained only
after the YAML contract, and only by quoting the current implementation. Label
repository facts as observed, policy interpretation as inferred, and any new
configuration as proposed.
