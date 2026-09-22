# Bootstrap

Run before answering or using a tool.

1. Read `memory/runtime/context.md` and the relevant pages linked by `memory/wiki/index.md`.
2. Select the minimum knowledge categories for the classified intent while always loading the conventions, repository, and shared-contract floor.
3. Warm the knowledge graph when enabled. Treat it as relationship evidence, not authority.
4. Verify that the configured GitLab and AWS tools expose only the declared read-only operations.
5. Check GitLab availability, the target repository default branch, and relevant open merge requests. Record unavailable sources as degraded.
6. Identify the routed repository concept, its expected plan shape, and its stop conditions.
7. Emit a session-start record containing request ID, evidence sources, degraded sources, and no secret values.

Do not create missing memory files or mutate an external system during bootstrap.
