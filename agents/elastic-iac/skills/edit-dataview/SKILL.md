---
name: edit-dataview
description: Edit an EXISTING data view in IaC -- add/replace a runtime field (config-form script_source) or change title/name. Read-modify-write the per-dataview JSON + open an MR. Does NOT create data views.
inputs:
  cluster: { type: string, required: true }
  dataview_name: { type: string, required: true }        # data-view file basename, e.g. "logs"
  runtime_field_name: { type: string, required: false }  # add/replace this runtime field
  runtime_field_type: { type: string, required: false }  # default "keyword"
  runtime_field_script: { type: string, required: false }# painless source (ONLY if scripted)
  dataview_title: { type: string, required: false }      # index pattern, e.g. "logs-*"
  dataview_display_name: { type: string, required: false }
---

# Edit a data view's runtime field / title / name

Source of truth: `environments/<cluster>/dataviews/<dataview>.json` -- ONE file per data view.

```json
{
  "id": "<uuid>", "title": "logs-*", "name": "Logs | All", "time_field_name": "@timestamp",
  "namespaces": ["default", "developer-experience"],
  "runtime_field_map": { "service": { "type": "keyword", "script_source": "<painless>" } },
  "override": true
}
```

## CRITICAL: config-form vs state-form (the §6 footgun)

A data-view runtime field serialises DIFFERENTLY in config vs state:
- **config form (what you WRITE)**: flat `{ "type": "keyword", "script_source": "<painless>" }`.
- **state form (what `terraform state pull` shows)**: nested `{ "type": "keyword", "script": { "source": "<painless>" } }`.

ALWAYS write the **config form** (`script_source`). NEVER copy state-form (`script: { source }`) into the file -- it will not match and the provider will perpetually diff. A script-less keyword runtime field (Optional+Computed) is valid: omit `script_source` entirely rather than writing an empty one.

## The change (read-modify-write)

1. Read `environments/<cluster>/dataviews/<dataview>.json` via `gitlab_get_file_content`. A 404 means the data view doesn't exist -- STOP (creating a new data view is out of scope).
2. Add/replace `runtime_field_map.<name>` in config form, and/or set `title` / `name`. Preserve `id`, `namespaces`, `override`, and everything else + 2-space indent + trailing newline.
3. Commit to a branch + open the MR.

## Risk

- **LOW**. Runtime fields are computed at query time; title/name are metadata. No index or data is touched. Verify a scripted runtime field's painless against the live mappings (a bad script errors at query time, not apply).
- `override: true` means the data view replaces the live saved object -- note it in the MR.

## Anti-patterns -- refuse to write

- Creating a NEW data view (out of scope).
- Writing state-form (`script: { source }`) -- always config-form `script_source`.
- Deleting a runtime field other code may depend on, without confirmation.

## MR body

Use `knowledge/mr-template.md` headings. Category: `dataview`. Risk: LOW. State the resolved change (`logs: add runtime field service`), the single file touched, and the rollback (revert the MR).
