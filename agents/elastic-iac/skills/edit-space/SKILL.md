---
name: edit-space
description: Edit an EXISTING Kibana space's name/description/color in IaC (read-modify-write the per-space JSON + open an MR). Does NOT create spaces or change feature access.
inputs:
  cluster: { type: string, required: true }
  space_name: { type: string, required: true }           # space file basename, e.g. "developer-experience"
  space_display_name: { type: string, required: false }  # human name
  space_description: { type: string, required: false }
  space_color: { type: string, required: false }         # hex, e.g. "#88B9A8"
---

# Edit a Kibana space's name / description / color

Source of truth: `environments/<cluster>/spaces/<space>.json` -- ONE file per space (in eu-b2b / eu-cld). Some deployments (gl-cld-reporting, eu-onboarding) ALSO keep an aggregate `spaces.json` -- that form is out of scope here.

```json
{ "name": "Developer eXperience", "description": "...", "color": "#9170B8", "initials": "DX",
  "disabled_features": ["siemV5", "enterpriseSearch", ...], "solution": "classic" }
```

## The change (read-modify-write)

1. Read `environments/<cluster>/spaces/<space>.json` via `gitlab_get_file_content`. A 404 means either the space doesn't exist or the deployment uses the aggregate `spaces.json` form -- STOP and tell the user (creating a space and the aggregate form are out of scope).
2. Set only `name` / `description` / `color`. Preserve `initials`, `disabled_features`, `solution`, and everything else + 2-space indent + trailing newline.
3. Commit to a branch + open the MR.

## Risk

- **MEDIUM**. Space metadata only -- no data, dashboards, or feature access is touched. `disabled_features` (which controls what's visible in the space) and `solution` are deliberately NOT editable here.

## Anti-patterns -- refuse to write

- Creating a NEW space (out of scope -- needs disabled_features defaults + the per-file-vs-aggregate placement decision).
- Editing `disabled_features` or `solution` (changes feature access -- out of scope, separate skill).
- The aggregate `spaces.json` form (out of scope this cut).

## MR body

Use `knowledge/reference/mr-template.md` headings. Category: `spaces`. Risk: MEDIUM. State the resolved change (`developer-experience: description updated`), the single file touched, and the rollback (revert the MR).
