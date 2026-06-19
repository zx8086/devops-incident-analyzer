---
sources:
  - knowledge/reference/iac-repo-map.md
  - knowledge/reference/conventions.md
updated: 2026-06-19T00:00:00.000Z
---

# IaC Repo Layout

Primary repo: `gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac`
(project id `82850717`, default branch `main`). Verify the tree with
`gitlab_get_repository_tree` on bootstrap; the repo is ground truth.

## Two trees that work together

- **`environments/` -- the edit surface.** Per-cluster JSON config. Every
  `edit-*` / `add-*` / `resize-*` skill does a read-modify-write on a file under
  here. `environments/_deployments/<cluster>.json` holds topology + version
  (`.version`, `elasticsearch.<tier>.size/max_size`); `environments/_shared/`
  holds defaults each cluster inherits; `environments/<cluster>/` holds the
  per-cluster config families (`lifecycle-policies/`, `alerting/`, `slos/`,
  `dashboards/`, `dataviews/`, `cluster-defaults/`, `fleet-integrations/`, ...).
- **`stacks/` -- the Terraform CI plans.** Organised by resource family, NOT by
  cluster. The agent never edits `stacks/` directly: it edits the JSON in
  `environments/` and CI re-plans the consuming stack.

So an edit reaches a plan as: edit JSON under `environments/` -> open MR on an
`agent/*` branch -> per-family `plan:*` jobs run -> apply is manual after merge.

## Pipeline + MR conventions

- Branch naming: `agent/<short>-<yyyymmdd>`; CODEOWNERS gates approvers; squash
  on merge; one MR per wave (never bundle unrelated clusters).
- On-demand jobs the agent triggers via `gitlab_trigger_*`: `drift-check`,
  `drift-check-synthetics`, `synthetics-push`, `fleet-upgrade-preview/apply`.
- **`deployments` stack lock contention:** that stack holds ONE Terraform state
  for all clusters, so two MRs touching it race the single state lock. A plan
  log showing `Error acquiring the state lock` / `already locked` is contention,
  not a problem with the change. Recovery is an operator force-unlock (or wait
  for the holder); the agent reports the hint and never force-unlocks state.

See [[maker-checker-workflow]] for the duties around opening that MR.
