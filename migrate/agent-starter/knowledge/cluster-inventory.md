# Cluster inventory — quick reference

Re-query Elastic Cloud on bootstrap; do not trust this file as ground truth. Use it for naming + intent.

| Cluster | Purpose | Notes |
|---|---|---|
| `gl-testing` | IaC pre-check sandbox | Single-node. Mandatory first target. No HA / tier / replica / CCS validation. ~$37/mo. |
| `eu-b2b` | Primary EU B2B observability | Tiered hot/warm/cold/frozen. Active ILM optimisation in progress (Wave 2 merged, Wave 3 gated). |
| `eu-b2b-dev` | eu-b2b development | |
| `eu-b2b-stg` | eu-b2b staging | |
| `eu-cld` | EU consumer/D2C | WebSphere logs leaked spi.password/JWKS — redaction deployed via logs@custom; historical logs still expose. Rotate creds. |
| `us-cld` | US consumer/D2C | Mulesoft v6→v8 cutover in progress (v7 scrapped). Entire mulesoft-aggregations pipeline dormant 67+ days. Cold + coord tiers recently resized. |

## In-flight items (re-read from memory on bootstrap)

- eu-b2b: MR `!29` merged (Wave 2). `!2a` (synthetics import) and `!2b` (tier after observation) queued. Wave 3 (hot 15→8GB downsize) gated on `.alerts` unmanaged fix.
- us-cld: v6→v8 mulesoft reindex with hardened transform. 9-step handover plan exists.
- us-cld: 14 mulesoft-aggregations transforms dormant since 2026-03-22, no alert.
- eu-b2b cold tier: node 0156 at 83% heap, 0141 at 74% + 1 old GC. Cluster GREEN but tightest tier.
