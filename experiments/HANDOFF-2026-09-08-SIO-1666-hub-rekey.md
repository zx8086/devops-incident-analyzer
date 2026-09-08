# HANDOFF 2026-09-08 — SIO-1666 hub rekey: backend done, UI half remaining

**Date**: 2026-09-08
**Repo state**: branch `claude/sio-1666-hub-rekey` @ `26167e7c`, pushed, clean
tree. Branched from `main` @ `7f8d9435`.
**Linear**: https://linear.app/siobytes/issue/SIO-1666
**Design**: `docs/superpowers/specs/2026-09-07-multi-hub-addressing.md`

## TL;DR

The rekey is **done and green on the backend**; the **web UI half is not
started**. Two commits are pushed and independently verified:

- `5c1e923c` — fleet CLI + analyzer config rekeyed. **259 pi-coms tests pass.**
- `26167e7c` — agent fixtures + routing tests. **109 agent hub tests pass.**

Remaining: the `/api/pi` wire type, the three routes, the store, the pane, their
tests, and live verification. That is ~67 `environment`-as-hub-identity
references across 6 files. **Nothing is half-edited** — a partial wire-type edit
was reverted so the branch is coherent.

Do NOT merge this branch until the UI half lands: the analyzer now expects the
new `PI_COMS_HUBS` shape and the pane still sends the old one.

## What a hub is now

A hub's identity is the **AWS account** it lives in, not its environment. The
fleet is one hub per account serving several spoke accounts in a domain;
`dev`/`prd` only worked while eu-shared-services owned both.

```yaml
hubs:
  eu-shared-services-prd:        # key = selector (AWS profile)
    profile: eu-shared-services-prd
    account_id: "399987695868"   # canonical identity; hubFor() accepts it too
    environment: prd             # ATTRIBUTE, not identity
    local_port: 8788             # explicit, per hub
    token_env: PI_COMS_NET_AUTH_TOKEN_PRD   # explicit, per hub
spokes:
  eu-oit-prd:
    env: prd
    hub: eu-shared-services-prd  # EXPLICIT; no longer inherited from env
```

`PI_COMS_HUBS` mirrors this, and each hub additionally lists the `estates` it
serves.

## Done (commit 5c1e923c)

**Fleet CLI** (`packages/pi-coms`):
- `manifest.ts` — hubs keyed by `HubKeySchema`; `environment` + `local_port`
  required on `HubSchema`; `token_env` now **required** (the
  `PI_COMS_NET_AUTH_TOKEN_<ENV>` default collides once two hubs share an env);
  `hub` required on `SpokeSchema`; `hubFor(manifest, selector)` accepts a key or
  an `account_id`; new `hubForSpoke` / `hubKeyForSpoke`.
- `validateManifest` — CIDR isolation regroups **per hub**, duplicate
  `local_port` is rejected, and the no-cross-environment rule is now checked
  DIRECTLY (`spoke.env !== hub.environment`) rather than implied by the key.
- `fleet.ts` — `--env` → `--hub`; `runPublish`, `withHubTunnel` (local port from
  the hub, not a CLI default), `hubToken`, `backend-init`, and both rollout /
  status groupings now key by hub.
- `render.ts` — `stateBucketName(manifest, hubKey)`; spoke lookups use
  `spoke.hub`.
- `deploy/fleet.example.yaml` rewritten to the new shape.

**Analyzer** (`packages/shared`, `packages/agent`):
- `PiComsHubConfigSchema` gains `environment` + `estates`; `hubs` is
  `z.record(string, …)`.
- `selectHubForEstate` **no longer routes by estate name suffix**. That
  convention identified an ENVIRONMENT, not a hub, so with two prd hubs it
  silently picked whichever was configured. Estates are listed on their hub;
  unclaimed → refused, claimed by two → refused rather than chosen between.
- `environmentForEstate(estate, config)` now takes the config (signature change).
- Legacy single-hub env vars gain `PI_COMS_NET_ESTATES` (comma-separated).

**Your real `deploy/fleet.yaml` was migrated in place** and validates: 2 hubs,
5 spokes, ports 8787/8788 matching the live tunnels. Backup:
`<scratchpad>/fleet.yaml.pre-sio1666.bak`. It is gitignored, so it is NOT in the
commits — a fresh clone needs it re-migrated.

## Remaining — the UI half

~67 references to `environment` as a hub identity across:

| File | What |
|---|---|
| `apps/web/src/lib/pi-fleet-types.ts` | add `hubKey` to `PiFleetHubSchema`; message + mailbox responses address a hub |
| `apps/web/src/lib/server/pi-fleet.ts` | `listFleetAgents` emits `hubKey`; `requireHub` / send / await / mailbox key by it |
| `apps/web/src/routes/api/pi/{messages,mailbox}/+server.ts` | request bodies carry `hubKey`, not `environment` |
| `apps/web/src/lib/stores/pi-fleet.svelte.ts`, `pi-fleet-reducer.ts` | selection + mailbox state keyed by hub |
| `apps/web/src/lib/components/PiFleetPane.svelte` | **the row must show the ACCOUNT**, not a bare `DEV`/`PRD` badge; `envBadge` is a `Record<PiFleetEnvironment, string>` assuming exactly 3 values |
| `apps/web/src/lib/server/pi-fleet.test.ts` | 11 failing fixtures (old `PI_COMS_HUBS` shape) |

**Why this is not cosmetic:** in the pane the environment is the ROUTING key
(`onLoadMailbox(hub.environment)`, `sendFleetMessage({ environment, … })`), so
two prd hubs would not merely look identical — a collision would address the
**wrong hub**.

Suggested shape (partially explored, then reverted):

```ts
export const PiFleetHubSchema = z.object({
  hubKey: z.string().min(1),          // identity: the selector
  environment: PiFleetEnvironmentSchema, // display + the no-cross-env check
  project: z.string(), fallbackTarget: z.string(),
  peers: z.array(PiFleetPeerSchema), error: z.string().nullable(),
});
```

Keep `environment` — the pane should render **account + env badge**, and the
badge colour still keys off it.

## Verification

```bash
cd ~/WebstormProjects/devops-incident-analyzer
cd packages/pi-coms && bun test        # 259 pass  (was 239 pre-rekey)
cd ../agent && bun test src/action-tools/ src/pi-fleet/   # 109 pass
cd ../../apps/web && bun run test      # 386 pass, 11 fail -> fix with the UI half
bun run typecheck && bun run lint
```

**Baseline discipline for the agent package**: `bun test` there fails **61** on
unmodified `main` and **32** on this branch (agent-memory/KG, plus 5 hub-adjacent
`runPiHandoff`/`aggregateMitigation` that fail identically on main). Compare
against a stashed baseline before blaming this work — verified 2026-09-08.

**Live, once the UI lands** (needs valid creds; refreshing prd does not refresh
dev):

```bash
just hub-tunnel eu-shared-services-prd   # -> localhost:8788
just hub-tunnel eu-shared-services-dev   # -> localhost:8787
just fleet plan                          # MUST show no diff on all five spokes
```

`terraform.tfvars` and the rendered roots carry no hub keys, so **no re-apply is
needed** — this is a manifest and CLI change, not an infrastructure one. Kill
every tunnel afterwards and prove the ports free.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Merging before the UI half lands | **High** | The analyzer expects the new `PI_COMS_HUBS`; the pane still sends the old shape. Land both, or the pane breaks. |
| A fresh clone's `fleet.yaml` is the old shape | Medium | It is gitignored; re-migrate from `fleet.example.yaml`, or restore the backup |
| `just fleet plan` shows a diff | Low | Would mean a render input changed; the rekey was designed to leave tfvars untouched |
| `PI_COMS_NET_ESTATES` unset on a legacy single-hub deployment | Medium | That hub then claims nothing and every estate is refused — set it |

## Out of scope

- `environmentForEstate`'s old suffix constants are gone; nothing else consumed them.
- No Terraform re-apply. No hub redeployment.
- The 4 spokes' persona/bundle contents are untouched.

## Memory references

`feedback_hub_identity_is_the_aws_account` (the decision),
`reference_pi_coms_send_403_name_not_allowed` (hub/principal gotchas, port map),
`reference_sio1653_fleet_deploy_cli` (manifest gitignored, adopt mode),
`reference_fleet_deploy_live_gotchas` (empty list for an unknown project),
`feedback_no_cross_environment_access`
