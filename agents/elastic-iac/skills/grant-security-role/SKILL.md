---
name: grant-security-role
description: ADD privileges to an EXISTING security role in IaC (read-modify-write security.json + open an MR). HIGH risk. Additive only -- never removes, never touches role_mappings or api_keys (secrets). Cluster/superuser grants demand human security review.
inputs:
  cluster: { type: string, required: true }
  role_name: { type: string, required: true }
  grant_cluster: { type: array, required: false }          # e.g. ["monitor"]
  grant_index_names: { type: array, required: false }      # e.g. ["logs-*"]
  grant_index_privileges: { type: array, required: false } # e.g. ["read","view_index_metadata"]
  grant_kibana_application: { type: string, required: false }   # e.g. "kibana-.kibana"
  grant_kibana_privileges: { type: array, required: false }     # e.g. ["feature_discover.read"]
---

# Grant privileges to a security role

Source of truth: `environments/<cluster>/security/security.json` -- ONE aggregate file holding `roles`, `role_mappings`, AND `api_keys`.

```json
{
  "roles": { "developer": { "name": "developer", "cluster": [], "indices": [],
    "applications": [ { "application": "kibana-.kibana", "privileges": ["feature_discover.read"], "resources": ["*"] } ] } },
  "role_mappings": { ... },   // OIDC group -> role; OUT OF SCOPE
  "api_keys": { ... }         // SECRETS; NEVER touch, NEVER echo
}
```

## NON-NEGOTIABLE constraints

- **api_keys is secrets.** Never read it into a diff, never echo it, never modify it. The proposer leaves it byte-for-byte untouched.
- **role_mappings is out of scope.** Do not edit which OIDC groups map to which roles here.
- **ADDITIVE ONLY.** This skill grants privileges (union onto the role's cluster/indices/applications). It NEVER removes a privilege and NEVER creates a role.

## The change (read-modify-write)

1. Read `security.json` via `gitlab_get_file_content`. A 404 means no security file -- STOP.
2. Confirm `<role_name>` is an existing role (an unknown role is a clarify, never invent one).
3. Union the requested privileges onto that ONE role: `cluster[]`, an `indices[]` entry matching the `names` set (or a new entry), and/or an `applications[]` entry matching the application (or a new entry). Leave every other role, role_mappings, and api_keys identical. Preserve 2-space indent + trailing newline.
4. Commit to a branch + open the MR.

## Risk -- always HIGH

- A privilege grant widens what the role (and everyone mapped to it) can do. Default risk **HIGH**; confirm least-privilege and that the role's members should have it.
- **Cluster-level privileges, `all`, `*`, or `superuser`-class grants = PRIVILEGE ESCALATION.** Surface a leading "RECOMMEND HUMAN SECURITY REVIEW" line; do not treat as routine.
- The diff lists ONLY the newly-added privileges (never the whole file, never secrets).

## Anti-patterns -- refuse to write

- Removing a privilege, creating a role, or editing role_mappings (out of scope).
- Reading or writing api_keys / users / any secret.
- Granting `superuser` / `all` / cluster-admin without an explicit, reviewed justification.

## MR body

Use `knowledge/reference/mr-template.md` headings. Category: `security`. Risk: HIGH (note escalation if cluster/superuser). State the resolved grant (`developer: +cluster[monitor], +indices(logs-*)[read]`), the single file touched, that role_mappings + api_keys are untouched, and the rollback (revert the MR).
