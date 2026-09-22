# Landing Zone workflows

The recurring GitLab reconciliation schedule remains disabled until an owner has run the controlled initial backfill for each approved repository.

Run the backfill from the repository root with the read-only Landing Zone MCP URL and knowledge graph configured:

```bash
bun scripts/lz-gitlab-backfill.ts \
  --repository aws-lz-account-creator \
  --start-at 2026-01-01T00:00:00.000Z
```

If the process stops after writing a bounded checkpoint, resume from that durable state instead of restarting the window:

```bash
bun scripts/lz-gitlab-backfill.ts \
  --repository aws-lz-account-creator \
  --resume
```

Omitting both `--start-at` and `--resume` also selects resume mode.

The command accepts only repositories in the Landing Zone catalog. It prints outcome counts and bounded checkpoint status; it does not print or persist plan bodies, state, job traces, tokens, or arbitrary GitLab payloads. Running it does not enable `schedules/lz-gitlab-import-sweep.yaml`; schedule enablement remains a separate reviewed operator action after checkpoint verification.

When Agent Memory is enabled, the importer mirrors one non-sensitive recovery anchor per GitLab project: repository name, project ID and path, and the original controlled backfill timestamp. A knowledge-graph rebuild restores that original timestamp, not the latest checkpoint, so subsequent reconciliation replays the missing GitLab history into the fresh graph.

GitLab HTTP 401 or 403 responses stop the current catalog sweep and arm a 15-minute in-process backoff keyed to `GITLAB_PERSONAL_ACCESS_TOKEN`. The same rejected token is not retried repository by repository; a changed token can retry immediately. Restart the Landing Zone MCP and web process after rotating an environment-file token so both processes receive the new value.
