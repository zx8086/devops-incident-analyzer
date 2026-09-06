# pi-fleet Phase 1b Implementation Plan (SIO-1653)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One manifest (`packages/pi-coms/deploy/fleet.yaml`) and one CLI (`just fleet <cmd> [names]`) that preflights, mints per-spoke hub tokens, renders and applies per-account Terraform roots (including an adopt mode for the production `DevOpsAgentReadOnly` role and a production hub root), publishes the bundle per environment, rolls the hosts and reports status, with no cross-environment access by construction.

**Architecture:** `scripts/fleet/` (Bun) holds pure modules (manifest schema, root renderer, preflight decision table, token JSON, hub polling) behind an injectable AWS client layer so `bun test` covers them with fakes; `scripts/fleet.ts` is the dispatcher that shells out to `terraform`, `aws ssm start-session` and `deploy/publish-fleet.sh`. Rendered roots contain no identifiers: subnets, CIDRs, hub IPs and tokens live in gitignored `terraform.tfvars` written by `render` from the gitignored manifest. State moves to an S3 backend in each environment's hub account, addressed with that hub's local profile.

**Tech Stack:** Bun 1.4, TypeScript strict, Zod, `yaml`, AWS SDK v3 (`sts`, `ssm`, `s3`, `iam`, `ec2`, `organizations`, `bedrock`, `credential-providers`) in the nested `scripts/package.json`, Terraform 1.10 (`use_lockfile`), just.

**Spec:** Linear SIO-1653; `docs/architecture/pi-fleet-gitagent-feasibility.md` section "Phase 1b".

## Context

Two spoke roots exist, hand-written, with subnet ids and the hub private IP committed and local Terraform state on one laptop. Seven production accounts need spokes; they already carry `DevOpsAgentReadOnly` for the analyzer (ExternalId `devops-agent-prod-access`, trusted by the AgentCore role), so the module must adopt that role rather than create it. A production hub is required (no cross-environment access). Local AWS access is by temporary portal credentials, so every step must be resumable and preflight must stop on an expired profile.

Facts verified this session:

- `deploy/modules/agent`: `readonly_role` is a bool; the role, both managed policies, the `pi-coms-dev-extensions` inline policy and the instance role's assume grant are all `count = var.readonly_role ? 1 : 0`. The instance's `user_data_replace_on_change = true` replaces the host on any template byte change, so nothing in this phase edits `userdata.sh.tftpl`.
- `deploy/token-admin.sh` writes `{"token","kind","names"}` JSON as a SecureString at `<auth_path>/<principal>`; the hub polls the path (60 s). Spokes read their token from `/pi-agent/auth-token` in their own account (`aws_ssm_parameter.coms_token`, value from the root's `coms_auth_token` variable), so Terraform must stay the single writer of that parameter: `tokens ensure` writes the minted token into the spoke's tfvars and `apply` propagates it.
- The hub root also owns the distribution bucket (`pi-coms-dist-<account>`, org-scoped read via `aws:PrincipalOrgID`) and the State Manager association; spoke roots repeat the association.
- The monitor's `MonitorComs` client is SSE-oriented; rollout polling needs only `GET /v1/agents` through the SSM port-forward the justfile's `hub-tunnel` recipe already performs (instance found by tag `Name=pi-coms-hub-hub`, local port 8787).
- Both repos are public: the committed example manifest and rendered roots carry placeholders only; `deploy/fleet.yaml` and `terraform.tfvars` are gitignored.

## Global Constraints

- No emojis, no em dashes, no `any`, Zod for the manifest, named exports.
- Never print a token; tokens go to SSM and gitignored tfvars only.
- Production accounts: `plan` by default; `apply` requires `--yes`; adopt mode never replaces the analyzer's trust statement (merge by Sid).
- `env` is mandatory on every spoke and must name a hub; a prd CIDR never enters the dev hub allow-list and vice versa (validated in the manifest loader).
- Nothing here runs against AWS in this session; verification is `bun test`, `terraform fmt`, `terraform validate` on rendered roots, and `bash -n`.

---

### Task 1: Manifest schema and example

**Files:** create `scripts/fleet/manifest.ts`, `deploy/fleet.example.yaml`, `tests/fleet-manifest.test.ts`; modify `.gitignore` (`deploy/fleet.yaml`).

- [ ] Schema: `hubs: Record<"dev"|"stg"|"prd", { profile, region, account_id?, url, port (8787), auth_path ("/pi-coms/auth"), dist_bucket?, private_ip, subnet_id, allowed_cidrs: string[], token_env? }>`, `persona: { min_version? }`, `defaults: { region, instance_type, pi_model, external_id: { dev, prd } }`, `spokes: Record<name, { env, profile, subnet_id, vpc_cidr, readonly_role: "create"|"adopt"|"none", external_id?, hosts_hub?, agent_name?, instance_type?, pi_model? }>`. Loader validates: every spoke env has a hub; `hosts_hub` spokes share the hub's profile; the union of spoke CIDRs per env equals the hub's `allowed_cidrs` unless `allowed_cidrs` lists extra operator ranges; a CIDR appearing under two environments is an error.
- [ ] Tests: valid example parses; env mismatch, cross-environment CIDR, hosts_hub profile mismatch each throw with the spoke name in the message.

### Task 2: Root renderer and template roots

**Files:** create `scripts/fleet/render.ts`, `tests/fleet-render.test.ts`; regenerate `deploy/accounts/eu-oit-dev/main.tf` and `deploy/accounts/eu-shared-services-dev/main.tf`; create `deploy/accounts/eu-shared-services-prd/main.tf` and the seven prd spoke roots as generated files; each root gets `backend.tf`.

- [ ] `renderSpokeRoot(manifest, name)` returns `{ "main.tf", "backend.tf", "terraform.tfvars" }`. `main.tf` (generated header, no identifiers): provider with `var.aws_profile`, variables `region`, `aws_profile`, `coms_auth_token` (sensitive), `hub_url`, `agent_subnet_id`, `dist_bucket`, `pi_model`, `agent_name`, `readonly_external_id`; `module "agent"` with `readonly_role = true` when mode is not `none` plus `readonly_role_mode = var.readonly_role_mode`; in adopt mode an `import { to = module.agent.aws_iam_role.devops_readonly[0], id = "DevOpsAgentReadOnly" }` block; the State Manager association; outputs. `hosts_hub` roots additionally render the bucket, org policy, hub module (`private_ip = var.hub_private_ip`, `allowed_cidrs = var.allowed_cidrs`, `auth_ssm_path`) and hub outputs. `backend.tf`: `backend "s3" { bucket = "pi-coms-tfstate-<hub account id>", key = "accounts/<name>.tfstate", region, profile = <hub profile>, use_lockfile = true, encrypt = true }`; when the hub `account_id` is unknown the bucket name uses the placeholder and `render` warns. `terraform.tfvars`: the identifiers, `coms_auth_token = "<set by fleet tokens ensure>"` until `tokens ensure` fills it (the renderer preserves an existing token line).
- [ ] Test: the two dev roots render with the expected module arguments; a prd adopt root contains the import block and `readonly_role_mode = "adopt"`; no rendered `main.tf` contains a subnet id, an IP or a token; `terraform fmt -check` on the rendered output (skipped when `terraform` is absent).

### Task 3: Agent module adopt mode

**Files:** modify `deploy/modules/agent/variables.tf`, `main.tf`, `outputs.tf`.

- [ ] `variable "readonly_role_mode"` (string, default `""`, validation in `create|adopt|none|""`); `locals.readonly_mode = var.readonly_role_mode != "" ? var.readonly_role_mode : (var.readonly_role ? "create" : "none")`; `locals.readonly_enabled = local.readonly_mode != "none"`.
- [ ] Adopt mode: `data "aws_iam_role" "devops_readonly_existing"` (count adopt); `aws_iam_role.devops_readonly` count `readonly_enabled`, `assume_role_policy` = create-mode document in create mode, or in adopt mode the existing statements plus one `TrustLocalPiAgent` statement (merged by Sid with `jsondecode`), with `lifecycle { ignore_changes = [description, max_session_duration, tags, path, permissions_boundary] }`; the two managed-policy resources and attachments count `readonly_mode == "create"` only; the inline dev extensions become `aws_iam_policy.pi_coms_extensions` (managed, name `pi-coms-extensions`) plus attachment in both modes (create keeps parity); instance assume grant and outputs use `local.readonly_enabled`.
- [ ] `terraform validate` on a rendered adopt root (`terraform init -backend=false`).

### Task 4: AWS layer, preflight, tokens, hub client

**Files:** create `scripts/fleet/aws.ts`, `preflight.ts`, `tokens.ts`, `hub.ts`, `tests/fleet-preflight.test.ts`, `tests/fleet-tokens.test.ts`; modify `scripts/package.json` (deps: `@aws-sdk/client-ssm`, `client-s3`, `client-iam`, `client-organizations`, `client-bedrock`, `@aws-sdk/credential-providers`, `yaml`; regenerate `scripts/bun.lock`).

- [ ] `FleetAws` interface (`callerIdentity(profile)`, `getParameter`, `putParameter`, `listParametersByPath`, `routeTablesForSubnet`, `describeOrganization`, `listInferenceProfiles`, `getRole`, `bucketExists`, `createStateBucket`, `sendCommand`, `describeInstanceByTag`), real implementation with `fromIni({ profile })` per call, fake in tests.
- [ ] `preflight(manifest, names, aws)` returns rows `{ spoke, check, ok, detail }` for: credentials valid and account matches `account_id` when given; hub principal `<name>` present at `auth_path`; subnet's VPC routes to a transit gateway; VPC CIDR in the hub allow-list; org id equals the hub's; Bedrock inference profile visible; adopt mode role readable and trust already contains the analyzer statement. An expired profile short-circuits the rest for that spoke with `ExpiredToken`.
- [ ] `tokens.ensure(manifest, name, aws, { rotate })`: principal `<name>` with names `[name, monitor-<name>]`, kind `agent`, minted with `crypto.randomBytes(32).hex`, put at `<hub auth_path>/<name>` in the hub account, written into the spoke's `terraform.tfvars` `coms_auth_token` line; returns `{ minted: boolean }` and never returns the token.
- [ ] `hub.listAgents(baseUrl, token)` parses `GET /v1/agents?include_explicit=true`; `hub.expectOnline(agents, names, { bundle, persona })` returns missing or stale names.

### Task 5: CLI, terraform wrapper, publish, rollout, status

**Files:** create `scripts/fleet.ts`, `scripts/fleet/terraform.ts`, `scripts/fleet/rollout.ts`; modify `justfile` (`fleet *args`), root `justfile` (delegation).

- [ ] `terraform.ts`: `run(root, args)` via `Bun.spawn(["terraform", ...])` with inherited stdio; `init` adds `-migrate-state -force-copy` when a local `terraform.tfstate` exists; `apply` on prd refuses without `--yes`.
- [ ] Commands: `preflight [names]`, `tokens ensure|rotate [names]`, `render [names]`, `backend-init <env>`, `plan [names]`, `apply [names] [--yes]`, `publish [--env dev|prd]` (calls `deploy/publish-fleet.sh <bucket> <profile>` per hub), `rollout [names]` (Run Command `bash /var/lib/cloud/instance/user-data.txt` when a token changed, else `/usr/local/bin/pi-coms-update`; then a port-forward to the hub and polling until `<name>` and `monitor-<name>` are online with the bundle sha and persona), `status [names]`, `deploy [names]` = preflight, tokens ensure, apply, publish once per env, rollout, status.
- [ ] `bash -n`-free (TypeScript), `bunx tsc --noEmit` in the package.

### Task 6: Docs and tracking

**Files:** `packages/pi-coms/docs/deployment/deployment.md` (fleet section, S3 backend, adopt mode, legacy state migration), `README.md`, `CLAUDE.md`, root `CLAUDE.md`, feasibility tracking row, handover status, `docs/README.md` changelog.

## Verification

```bash
cd packages/pi-coms && bun test
cd packages/pi-coms && bunx tsc --noEmit && bunx biome check .
cd packages/pi-coms && bun scripts/fleet.ts render --manifest deploy/fleet.example.yaml --out /tmp/roots && for d in /tmp/roots/*; do (cd $d && terraform fmt -check && terraform init -backend=false >/dev/null && terraform validate); done
bun run typecheck && bun run lint
```

User-run afterwards: copy the two laptops' `terraform.tfstate` files into the new roots (or pass `--legacy-state-dir`), `just fleet backend-init dev`, `just fleet preflight`, `just fleet deploy eu-oit-dev`, then the prd hub and spokes with per-account `--yes`.

## Out of scope

Automatic refresh of portal credentials; hub protocol changes; the TGW attachments themselves; enabling Bedrock model access.
