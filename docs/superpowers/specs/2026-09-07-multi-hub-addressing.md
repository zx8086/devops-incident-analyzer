# Multi-hub addressing: the AWS account is the hub identity

Status: PARKED. No code written and none planned for now. Written 2026-09-07
after `just coms prd simon` was rejected as unscalable; the user's decision was
to keep the current shape (KISS) and address hubs by AWS profile, replacing the
selector when another hub appears. This note exists so the rekey does not have to
be re-derived when that day comes -- read it BEFORE adding a second hub to any
environment.

## The problem in one line

`hubs` is keyed by environment (`dev` | `stg` | `prd`), so a second hub in another
AWS account's production has nowhere to live and no way to be addressed.

Today's manifest:

```yaml
hubs:
  dev:   { profile: eu-shared-services-dev, account_id: "352896877281", project: pi-coms-dev }
  prd:   { profile: eu-shared-services-prd, account_id: "399987695868", project: pi-coms-prd }
```

`prd` names an *environment*. The intended model is:

```
eu-shared-services-prd -> selector -> AWS account -> hub
```

One hub per ACCOUNT, addressed by the account (or its profile), with the
environment demoted to an attribute of the hub rather than its identity.

## Why this is not a one-line change

The env-keyed assumption is threaded through two packages.

### Fleet CLI (`packages/pi-coms/scripts/`)

- `manifest.ts:9` `FleetEnvironmentSchema = z.enum(["dev","stg","prd"])` is the
  hub key type.
- `manifest.ts:75` `hubs: z.partialRecord(FleetEnvironmentSchema, HubSchema)` —
  at most three hubs, one per environment, enforced by the type.
- `manifest.ts:46` every spoke declares `env`, and `manifest.ts:133`
  `manifest.hubs[spoke.env]` is how a spoke finds its hub. **Spokes inherit their
  hub by environment; they never name one.** This is the load-bearing assumption.
- `manifest.ts:120-131` CIDR isolation is grouped by environment: the same CIDR
  on two environments' hubs is an error ("no cross-environment access"). With
  several hubs per environment this rule has to regroup per hub, and the error
  message stops being about environments.
- `manifest.ts:99` `external_id` is a per-environment record.
- `fleet.ts` (365 lines) threads `FleetEnvironment` through `publish`, `rollout`,
  `status` and `hubToken` — `fleet.ts:168` enumerates `Object.keys(manifest.hubs)`
  as environments, `fleet.ts:255` and `:288` group work `byEnv`.
- `hub.token_env` defaults to `PI_COMS_NET_AUTH_TOKEN_${ENV.toUpperCase()}`
  (`fleet.ts:235`), which collides once two hubs share an environment.

### Analyzer (`packages/agent`, `packages/shared`)

- `shared/src/config.ts:79` `PI_COMS_HUBS` is `partialRecord(PiComsEnvironmentSchema, …)`
  — the same three-key shape, in the app's own config.
- `agent/src/action-tools/pi-verifier.ts:104-113` `environmentForEstate` maps an
  estate to an environment **by name suffix**, and `selectHubForEstate` then looks
  up `config.hubs[environment]`.

That last one is the sharpest edge. `eu-oit-prd` and `eu-shared-services-prd`
both resolve to environment `prd`, so the analyzer sends verification for **any**
prd estate to the single prd hub. That is correct today only because one prd hub
exists. Add `eu-oit-prd`'s own hub and the router silently keeps using the
shared-services one — a wrong-hub bug that looks like a working system, which is
exactly the failure class that produced the `HTTP 401 register` confusion earlier
(a prd tunnel bound on dev's port).

## Proposed shape

Key hubs by their selector (the AWS profile, which already encodes account +
environment uniquely and is what an operator types for AWS anyway). Keep
`account_id` as the canonical identity and accept either as a selector.

```yaml
hubs:
  eu-shared-services-dev:
    profile: eu-shared-services-dev
    account_id: "352896877281"
    environment: dev            # demoted: an attribute, not the key
    project: pi-coms-dev
    local_port: 8787            # explicit, per hub
    allowed_cidrs: [...]
  eu-shared-services-prd:
    profile: eu-shared-services-prd
    account_id: "399987695868"
    environment: prd
    project: pi-coms-prd
    local_port: 8788
    allowed_cidrs: [...]

spokes:
  eu-oit-prd:
    env: prd
    hub: eu-shared-services-prd  # EXPLICIT, no longer inherited from env
    profile: eu-oit-prd
```

Key points:

1. **Spokes name their hub.** `hub:` becomes a required field. This is the change
   that actually unlocks multiple hubs per environment; everything else follows.
   `env` stays, because `external_id` and the persona still care about it.
2. **`local_port` is per hub, explicit.** The current `+1 prd / +2 stg`
   derivation is the env assumption in another costume: with two prd hubs it
   assigns both the same local port, and the second tunnel silently binds
   nothing (the failure #701 already fixed once for dev-vs-prd).
3. **CIDR isolation regroups per hub**, and the error says which hubs, not which
   environments. The underlying rule (a spoke subnet belongs to exactly one hub)
   is unchanged and still worth enforcing.
4. **`token_env` must be explicit** per hub, since the env-derived default
   collides.
5. **`PI_COMS_HUBS` mirrors the same rekey**, and `selectHubForEstate` stops
   routing by suffix: an estate maps to a hub via the same explicit binding the
   manifest uses. The "no cross-environment access" guarantee is preserved by
   refusing an estate with no hub binding, rather than by inferring one.

## Migration

The manifest is gitignored, so there is no fleet-wide coordination problem — but
the rendered Terraform roots and the deployed hubs are real.

1. Accept both shapes for one release: if a hub key is `dev|stg|prd`, treat it as
   today (env-keyed) and derive `environment` from the key. Warn.
2. Rewrite the local `fleet.yaml` to the new shape; add `hub:` to all five spokes.
3. Drop the compatibility branch once no manifest uses the old shape.

`terraform.tfvars` and the rendered roots carry no hub keys, so **no re-apply is
needed** — this is a manifest and CLI change, not an infrastructure one. Verify
with `just fleet plan` showing no diff on all five spokes.

## Blast radius / risk

| Area | Risk | Mitigation |
|---|---|---|
| `just fleet deploy/apply` | High — this path just deployed prd | Compat shim; `plan` must be empty before and after |
| `rollout` / `status` | Medium — grouped `byEnv` | Regroup by hub; verify against the live dev + prd hubs |
| `tokens ensure` | Medium — `token_env` collision | Require explicit `token_env` in the new shape |
| Analyzer routing | **High, silent** | New tests: two hubs in one environment must route to different hubs |
| CIDR isolation | Low | Rule is unchanged, only its grouping |

## Explicitly out of scope

- Deploying a second hub. This is the addressing change that makes one possible.
- Changing the `wrapUntrusted` boundary or anything about how replies reach a model.
- The `-dev`/`-prd` estate suffix convention itself; only its use as a *hub
  router* goes away.

## What is actually in use

Addressing a hub by AWS profile, resolved against the existing env-keyed
manifest. No rekey, no change to the deploy path:

```bash
just hub-tunnel eu-shared-services-prd 8787
just coms eu-shared-services-prd simon
```

The limit is precise: the manifest still has nowhere to put a SECOND hub in one
environment, because `hubs` is keyed by `dev|stg|prd`. Until such a hub exists
the profile selector is a complete answer; when one is added, the selector is
replaced and this note describes what else has to move with it.

## Related

- `docs/architecture/pi-coms-verification.md` — estate to hub routing
- `packages/pi-coms/scripts/fleet/manifest.ts` — schema and validation
- `packages/agent/src/action-tools/pi-verifier.ts:104` — `environmentForEstate`
- PR #701 (hub naming, tunnel port collision), PR #702 (env selector)
