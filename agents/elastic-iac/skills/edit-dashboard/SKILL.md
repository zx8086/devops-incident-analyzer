---
name: edit-dashboard
description: Add or replace a WHOLE Kibana dashboard NDJSON saved-object export in IaC -- commit a user-pasted/Kibana-exported NDJSON verbatim to environments/<deployment>/dashboards/<space>__<name>.ndjson + open an MR. MEDIUM risk -- dashboards are display-only; a malformed NDJSON fails CI's saved-objects import job, not production. WHOLE-FILE only: never edits panels/visualizations inside an existing saved object, never JSON.parses the file as one object (it is line-delimited). delete is not supported yet.
inputs:
  cluster: { type: string, required: true }
  dashboard_space: { type: string, required: true }   # the Kibana space; becomes the <space>__ filename prefix; MUST be an existing space
  dashboard_name: { type: string, required: true }     # the file slug (after <space>__, before .ndjson)
  dashboard_ndjson: { type: string, required: true }   # the raw Kibana export (newline-delimited; committed verbatim)
  dashboard_action: { type: string, required: true }   # add | replace  (delete is not supported yet)
---

# Add or replace a Kibana dashboard (whole-file NDJSON)

Source of truth: `environments/<deployment>/dashboards/<space>__<name>.ndjson` -- ONE newline-delimited JSON (NDJSON) file per dashboard. The filename is `<space>__<name>.ndjson` (the Kibana space, then a DOUBLE underscore, then the dashboard slug). CI's dashboards module imports every `*.ndjson` under the deployment's `dashboards/` dir into Kibana via the saved-objects import API.

## NDJSON shape -- DO NOT parse the whole file as one JSON object

It is line-delimited: **N saved-object lines + a trailing export-summary line**. Each line is a standalone JSON object.

```
{"type":"dashboard","id":"...","attributes":{"title":"...","panelsJSON":"...",...},"references":[...],"coreMigrationVersion":"...","created_at":"...",...}
{"type":"lens","id":"...","attributes":{...},...}                 (0+ more saved-object lines: lens / visualization / index-pattern / tag / canvas-workpad / ...)
{"excludedObjects":[],"excludedObjectsCount":0,"exportedCount":1,"missingRefCount":0,"missingReferences":[]}   <- export summary (has no "type")
```

A whole-file add/replace commits the user's exported NDJSON VERBATIM and never has to understand any of this -- which is exactly why this skill is scoped to whole-file only. Validation is per-line (split on `\n`, JSON.parse each non-blank line) so an obviously-malformed payload is caught, but the ORIGINAL string is committed -- never a re-serialized one.

## The change (whole-file add / replace)

1. Require `cluster`, `dashboard_space`, `dashboard_name`, `dashboard_action`, and (for add/replace) a non-empty `dashboard_ndjson`. Missing/empty -> STOP with a clarifying message (do not open an empty/broken MR).
2. **Cross-check the space exists**: the `<space>__` prefix must match a real space on this deployment. Read `environments/<deployment>/spaces/<space>.json` via `gitlab_get_file_content`; a 404 means the space doesn't exist -> STOP and tell the user.
3. Resolve the file path `environments/<deployment>/dashboards/<space>__<name>.ndjson`.
   - **add**: the file must NOT already exist (404 expected). If it exists -> STOP (use replace; never silently clobber). Commit with `action: create`.
   - **replace**: the file MUST already exist. If 404 -> STOP (use add). Commit with `action: update`.
4. Validate the NDJSON per-line (never whole-file JSON.parse). A malformed line -> STOP with the line number.
5. Commit the raw NDJSON string verbatim to a branch + open the MR.

## Risk -- MEDIUM

- Dashboards are **display-only**. A malformed NDJSON fails CI's saved-objects IMPORT job, not production -- it never touches indices, data, or cluster config.
- This is a **WHOLE-FILE** add/replace. Individual panels/visualizations are NOT reviewed here -- verify the export is the intended dashboard before merge.
- The MR diff is a SUMMARY (filename + action + saved-object count + byte size) -- it NEVER dumps the NDJSON body (a dashboard export can be 1.9 MB).

## Anti-patterns -- refuse to write

- **Surgical panel / visualization edits** inside an existing NDJSON saved object (mutating a single panel, query, or layout). Categorically out of scope this cut -- it is a planned follow-up. Refuse and explain; only whole-file add/replace is supported.
- **Whole-file `JSON.parse`** of the NDJSON. It is line-delimited -- parsing it as one object will throw on any multi-object file. Never do it; treat the payload as an opaque multi-line string.
- A `<space>__` prefix that is not an existing space. The space must exist (cross-checked against the spaces stack) -- never invent one or create the space here.
- **Deleting a dashboard.** Not supported yet (the GitLab MCP exposes no delete-file tool). Surface it as a follow-up; for now delete in Kibana / the repo directly.
- Editing the dashboards `terraform.tfvars` (endpoints / API-key path) -- that is deployment plumbing, not a dashboard content change.
- Dumping the NDJSON body into the MR/diff -- always a summary, never the content.

## MR body

Use `knowledge/mr-template.md` headings. Category: `dashboard`. Risk: MEDIUM. State the resolved change (`eu-b2b: add dashboard developer-experience__amazon_bedrock_token_usage`), the single file touched (`<space>__<name>.ndjson`), that this is a whole-file Kibana export imported by CI's saved-objects import job (not a production change), and the rollback (revert the MR). NEVER paste the NDJSON body.
