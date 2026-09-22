---
type: Module
title: vending-orchestrator/state-store
description: Three DynamoDB tables holding vending state — accounts, network and an events dedup table — with streams consumed downstream.
resource: aws-lz-vending-orchestrator/modules/state-store
change_class: gitops-hcl
tags: [aws-lz, dynamodb, state, vending, streams]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-vending-orchestrator/modules/state-store
    title: Module source as checked out
  - id: parent
    resource: aws-lz-vending-orchestrator
    title: Consuming root — see /repos/aws-lz-vending-orchestrator.md
---

# When this applies

A vending state table's schema, capacity, stream configuration or naming changes.

# Surface

**Edit:** `aws-lz-vending-orchestrator/modules/state-store/` — `_data.tf`, `_locals.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `dynamodb.tf`.

Called from `main.tf` in the vending-orchestrator root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-vending-orchestrator.md](/repos/aws-lz-vending-orchestrator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **Three tables, not one.** Accounts, network and events dedup. Each exposes a name and ARN; two also expose a stream ARN.
- **Changing a table's hash or range key replaces the table** and loses the vending state it holds. There is no in-place key-schema change in DynamoDB.
- The stream ARNs are consumed by the orchestrator's event source mapping. Disabling or re-creating a stream produces a new ARN and silently breaks the consumer until it is re-wired.
- Table names are derived from the naming module's prefix. Bumping the naming module can rename the tables, which is a replace.
- The events table is a dedup store: losing it makes previously processed events replayable.

# Fields

Inputs: `custom_tags` · `enable_deletion_protection` · `mandatory_tags` · `region`

Outputs: `accounts_stream_arn` · `accounts_table_arn` · `accounts_table_name` · `events_table_arn` · `events_table_name` · `network_stream_arn` · `network_table_arn` · `network_table_name`

# Plan

Capacity or TTL edit: `1 in place`. Key-schema or name change: replace — destructive. New table: `1 to add`.

# Stop

- Any plan proposing to replace a table or change a stream configuration.
- A naming-module bump would change a table name.
- State migration is required — that is human-only.
