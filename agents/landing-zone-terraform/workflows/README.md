# Landing Zone workflows

The recurring GitLab reconciliation schedule remains disabled until an owner has run the controlled initial backfill for each approved repository.

Run the backfill from the repository root with the read-only Landing Zone MCP URL and knowledge graph configured:

```bash
bun scripts/lz-gitlab-backfill.ts \
  --repository aws-lz-account-creator \
  --start-at 2026-01-01T00:00:00.000Z
```

The command accepts only repositories in the Landing Zone catalog. It prints outcome counts and bounded checkpoint status; it does not print or persist plan bodies, state, job traces, tokens, or arbitrary GitLab payloads. Running it does not enable `schedules/lz-gitlab-import-sweep.yaml`; schedule enablement remains a separate reviewed operator action after checkpoint verification.
