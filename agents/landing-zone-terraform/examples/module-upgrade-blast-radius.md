# Shared-module upgrades require consumer blast-radius evidence

Tags: shared module, dependency graph, review

User: Review the blast radius of upgrading the shared networking module used by aws-lz-network-core.

Expected behaviour:

Route to `aws-lz-network-core`, identify the exact pinned module ref and current released contract, then enumerate consumers using repository and knowledge-graph evidence. Compare inputs, outputs, addresses, and expected plans across representative consumers.

Do not recommend an unpinned ref or claim safety from one consumer. Label incomplete consumer discovery as unverified.
