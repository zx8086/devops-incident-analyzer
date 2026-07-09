# Elastic-iac user prompts (from LangSmith)

Source: LangSmith project `devops-incident-analyzer`, 30 most-recent traces (window Jul 1-9, 2026).
Filtered to elastic-iac via `compliance_hitl: "always"` metadata (incident-analyzer = `"conditional"`).
Total elastic-iac turns: 19  |  Distinct requests: 8

> Note: this is a WINDOW export (recent traces only). Older elastic-iac prompts exist in LangSmith but were not fetched.

---

## Distinct requests (verbatim, deduplicated)

### 1. 1 turn(s) — first seen 2026-07-08T14:42:17

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01DScope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### 2. 7 turn(s) — first seen 2026-07-08T14:46:35

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### 3. 2 turn(s) — first seen 2026-07-08T15:19:41

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### 4. 2 turn(s) — first seen 2026-07-08T15:54:27

```
In the ap-cld deployment, upgrade these Fleet agents to 9.4.2:
AP1XOFFTHQ01, AP2EXSE01, AP1EXSE01, PVHSYDMGT01, AP1VEEAM01, AP1SQP01, AP1CMSSQP01, AP1EQHRSQP01
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 8 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### 5. 2 turn(s) — first seen 2026-07-08T16:05:03

```
In the us-cld deployment, upgrade these Fleet agents to 9.4.2:
na2exse01, na1exse01, na1rdsjump01, NA1VEEAMRESTORE, bwogscwbapp2, NA1SSRSQP01, palwcsdbp02, PALMHEAPP01, na1hplrinjp3, na1lrcontp1, bwovarapp1, bwosqclup02a, palhwinp01, gsccmsqp1, MONWCSDBP01, atlwcsdbp02, BRASQP1, bwosqclup02b, palwcsdbp01, NA1APQPSQP1, atlwcsdbp01, BRAAPP1, na1hplrinjp2, bwocorpapp01, bwoauditdbp1, BRARDSP1, bwoepapadminp1, BWOEPTOXDP2, BWOEPCKXDP1, atlmheapp01, na1isgsqp1, BWOEPTOXDP1, NA1EX2K16MG01, BWOEPAPXDP1, BWOEPAPXDP2, BWOEPHTXDP1, bwoepadminp1, BRALINXP2, BWOEPCKXDP2, BWOEPHTXDP2, NA1VISRETSQP1, BRARDSP2, braas10, BRARDSP3, bwoalmsqp1, BWOSFTPDUMP1, na1edisqp1, na1edisqp2
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 48 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### 6. 2 turn(s) — first seen 2026-07-09T09:41:19

```
Deployment: eu-b2b.

Problem: two files declare the same ES ILM policy name ".alerts-ilm-policy":
- environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json
- environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json
The module keys resources by filename but writes each.value.name, so both target the one policy -> collision -> the 90d delete phase never applies (live is hot-only).

Do:
1. Delete environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json.
2. In environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json add "delete_searchable_snapshot": true to the delete block. Final:
   {
     "name": ".alerts-ilm-policy",
     "hot": { "min_age": "0ms", "max_age": "30d", "max_primary_shard_size": "50gb", "rollover": true },
     "delete": { "min_age": "90d", "delete_searchable_snapshot": true }
   }
```

### 7. 1 turn(s) — first seen 2026-07-09T10:02:17

```
[eu-b2b] lifecycle-policies: remove duplicate .alerts-ilm-policy.json

Delete exactly one file:
  environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json

Do not create, edit, or touch any other file. No other change.

Reason: two files declare the same ILM policy name ".alerts-ilm-policy", which
collides on the Terraform resource address and failed the pipeline in !267. The
other file, environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json, is the
canonical one (matches ap-cld !243 / us-cld !240) and already defines the policy
correctly — leave it exactly as-is:

{
  "name": ".alerts-ilm-policy",
  "hot": {
    "max_age": "30d",
    "max_primary_shard_size": "50gb",
    "rollover": true
  },
  "delete": {
    "min_age": "90d",
    "delete_searchable_snapshot": true
  }
}

(hot.min_age is applied as "0ms" by the lifecycle module, so it is not stored in
the file.) Removing the dot-prefixed duplicate leaves exactly one resource for
.alerts-ilm-policy.

Category: ilm
Cluster(s) affected: eu-b2b
Risk: LOW — removes a redundant duplicate config file; the surviving file is unchanged.
```

### 8. 2 turn(s) — first seen 2026-07-09T10:32:11

```
Deployment: eu-b2b

Delete the ILM policy file environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json on eu-b2b.

This is the dot-prefixed duplicate of the canonical alerts-ilm-policy.json (both
declare the ES policy name ".alerts-ilm-policy", which collides at apply). Remove
ONLY the dot-prefixed file; leave alerts-ilm-policy.json exactly as-is. Open a
delete MR.
```

---

## All turns (chronological, with request/thread ids)

### Turn 1 — 2026-07-08T14:42:17  (req `6325ee8a-cd6c-42a8-a284-3bb366603747`, thread `ebf56ae3-c9e1-486e-9404-69cbf2812e22`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01DScope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### Turn 2 — 2026-07-08T14:46:35  (req `e3c86f1c-5716-4789-bec1-649d709cd817`, thread `1928532b-3738-4f10-920b-bc7dd1aebdc9`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 3 — 2026-07-08T14:47:25  (req `f5e6fe49-7276-4354-8a0b-4f9b95abe43d`, thread `84cccd37-93f5-4cbd-bf00-7a31bc1b9145`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 4 — 2026-07-08T14:50:30  (req `2a2975ca-1e1b-4448-b94e-9cb23afb550d`, thread `862c929f-78ae-43b7-a1eb-afdedce74241`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 5 — 2026-07-08T14:51:50  (req `99e20d11-ccc5-42a2-94e8-65b09ce588f2`, thread `ea32102a-c1db-49f2-a6bf-e21529fcb9b1`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 6 — 2026-07-08T14:55:46  (req `ea586e4f-768c-4193-a8fe-98ce095973a5`, thread `37721021-98b8-4e00-9d40-1edde07b088b`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 7 — 2026-07-08T15:13:39  (req `5ce8a290-adac-4789-a7b1-254f4399a3d9`, thread `4b5f7884-8799-42b2-a78b-ed25a5fc4478`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 8 — 2026-07-08T15:15:18  (req `b23042ba-2c69-4f57-901f-f424ce48dda7`, thread `71210dd4-6540-41f3-b903-e4fb4fc45ce6`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 9 — 2026-07-08T15:19:41  (req `3b13bb2e-2da0-4738-9523-26312af1e5e6`, thread `35877729-0aaf-410c-858f-53d4115ca629`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### Turn 10 — 2026-07-08T15:20:53  (req `dfbb4f4a-eb20-4dbb-9f7b-40e0c322200b`, thread `35877729-0aaf-410c-858f-53d4115ca629`)

```
In the eu-cld deployment, upgrade these Fleet agents to 9.4.2:
eu1w2022amp40, hwv00061, hwvjg001, hwv00219, hwv00003, hwv00198, hwv00008, hwv00237, hwv00033, hwv00083, hwv00192, hwv00001, amsctx514, IT-A440TILL101, DE-A265TILL208, HWV00073, Hwv00153, AMSDB058, EU1APP13P, AMSDB063-CLONE, EU1DB012P, AMSDB063, AMSPRN023, AMSAPP352, EU2DB01D
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 25 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### Turn 11 — 2026-07-08T15:54:27  (req `d7136585-cb3f-423e-8185-bf876ee329cd`, thread `94941909-1911-47e0-90be-174ff5fcc481`)

```
In the ap-cld deployment, upgrade these Fleet agents to 9.4.2:
AP1XOFFTHQ01, AP2EXSE01, AP1EXSE01, PVHSYDMGT01, AP1VEEAM01, AP1SQP01, AP1CMSSQP01, AP1EQHRSQP01
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 8 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 12 — 2026-07-08T15:55:13  (req `1bf3708c-4bb5-421f-a57a-658b5961320a`, thread `94941909-1911-47e0-90be-174ff5fcc481`)

```
In the ap-cld deployment, upgrade these Fleet agents to 9.4.2:
AP1XOFFTHQ01, AP2EXSE01, AP1EXSE01, PVHSYDMGT01, AP1VEEAM01, AP1SQP01, AP1CMSSQP01, AP1EQHRSQP01
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 8 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent
```

### Turn 13 — 2026-07-08T16:05:03  (req `ba0b8f8b-8b30-438a-9e81-c238c5f3ad70`, thread `993a06d5-8ee7-421d-91fc-1028cc70a2e6`)

```
In the us-cld deployment, upgrade these Fleet agents to 9.4.2:
na2exse01, na1exse01, na1rdsjump01, NA1VEEAMRESTORE, bwogscwbapp2, NA1SSRSQP01, palwcsdbp02, PALMHEAPP01, na1hplrinjp3, na1lrcontp1, bwovarapp1, bwosqclup02a, palhwinp01, gsccmsqp1, MONWCSDBP01, atlwcsdbp02, BRASQP1, bwosqclup02b, palwcsdbp01, NA1APQPSQP1, atlwcsdbp01, BRAAPP1, na1hplrinjp2, bwocorpapp01, bwoauditdbp1, BRARDSP1, bwoepapadminp1, BWOEPTOXDP2, BWOEPCKXDP1, atlmheapp01, na1isgsqp1, BWOEPTOXDP1, NA1EX2K16MG01, BWOEPAPXDP1, BWOEPAPXDP2, BWOEPHTXDP1, bwoepadminp1, BRALINXP2, BWOEPCKXDP2, BWOEPHTXDP2, NA1VISRETSQP1, BRARDSP2, braas10, BRARDSP3, bwoalmsqp1, BWOSFTPDUMP1, na1edisqp1, na1edisqp2
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 48 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### Turn 14 — 2026-07-08T16:16:35  (req `0f6fa249-58f7-4230-86a6-812436e27a55`, thread `993a06d5-8ee7-421d-91fc-1028cc70a2e6`)

```
In the us-cld deployment, upgrade these Fleet agents to 9.4.2:
na2exse01, na1exse01, na1rdsjump01, NA1VEEAMRESTORE, bwogscwbapp2, NA1SSRSQP01, palwcsdbp02, PALMHEAPP01, na1hplrinjp3, na1lrcontp1, bwovarapp1, bwosqclup02a, palhwinp01, gsccmsqp1, MONWCSDBP01, atlwcsdbp02, BRASQP1, bwosqclup02b, palwcsdbp01, NA1APQPSQP1, atlwcsdbp01, BRAAPP1, na1hplrinjp2, bwocorpapp01, bwoauditdbp1, BRARDSP1, bwoepapadminp1, BWOEPTOXDP2, BWOEPCKXDP1, atlmheapp01, na1isgsqp1, BWOEPTOXDP1, NA1EX2K16MG01, BWOEPAPXDP1, BWOEPAPXDP2, BWOEPHTXDP1, bwoepadminp1, BRALINXP2, BWOEPCKXDP2, BWOEPHTXDP2, NA1VISRETSQP1, BRARDSP2, braas10, BRARDSP3, bwoalmsqp1, BWOSFTPDUMP1, na1edisqp1, na1edisqp2
Scope the selector to exactly these hosts and to upgradeable:true. Preview first: it must resolve to 48 agents — if it resolves to any other count, stop and report before applying. Apply, let the verify sweep run, and report outcome.status, outcome.counts, and apply.failed_agents[]. Do not retry failures — list them. Touch no other agent.
```

### Turn 15 — 2026-07-09T09:41:19  (req `a5d8f9ff-3559-4ed3-b919-c308da5e9509`, thread `441541e5-0f0f-4738-8a43-2def1192455b`)

```
Deployment: eu-b2b.

Problem: two files declare the same ES ILM policy name ".alerts-ilm-policy":
- environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json
- environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json
The module keys resources by filename but writes each.value.name, so both target the one policy -> collision -> the 90d delete phase never applies (live is hot-only).

Do:
1. Delete environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json.
2. In environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json add "delete_searchable_snapshot": true to the delete block. Final:
   {
     "name": ".alerts-ilm-policy",
     "hot": { "min_age": "0ms", "max_age": "30d", "max_primary_shard_size": "50gb", "rollover": true },
     "delete": { "min_age": "90d", "delete_searchable_snapshot": true }
   }
```

### Turn 16 — 2026-07-09T09:42:45  (req `8768996f-1e8d-4f90-9a71-2b460ec21f37`, thread `441541e5-0f0f-4738-8a43-2def1192455b`)

```
Deployment: eu-b2b.

Problem: two files declare the same ES ILM policy name ".alerts-ilm-policy":
- environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json
- environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json
The module keys resources by filename but writes each.value.name, so both target the one policy -> collision -> the 90d delete phase never applies (live is hot-only).

Do:
1. Delete environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json.
2. In environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json add "delete_searchable_snapshot": true to the delete block. Final:
   {
     "name": ".alerts-ilm-policy",
     "hot": { "min_age": "0ms", "max_age": "30d", "max_primary_shard_size": "50gb", "rollover": true },
     "delete": { "min_age": "90d", "delete_searchable_snapshot": true }
   }
```

### Turn 17 — 2026-07-09T10:02:17  (req `5a4a4434-75ee-4181-a5bb-afd13e7980e7`, thread `5a32d1b7-9e27-425b-87d1-beda208ae505`)

```
[eu-b2b] lifecycle-policies: remove duplicate .alerts-ilm-policy.json

Delete exactly one file:
  environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json

Do not create, edit, or touch any other file. No other change.

Reason: two files declare the same ILM policy name ".alerts-ilm-policy", which
collides on the Terraform resource address and failed the pipeline in !267. The
other file, environments/eu-b2b/lifecycle-policies/alerts-ilm-policy.json, is the
canonical one (matches ap-cld !243 / us-cld !240) and already defines the policy
correctly — leave it exactly as-is:

{
  "name": ".alerts-ilm-policy",
  "hot": {
    "max_age": "30d",
    "max_primary_shard_size": "50gb",
    "rollover": true
  },
  "delete": {
    "min_age": "90d",
    "delete_searchable_snapshot": true
  }
}

(hot.min_age is applied as "0ms" by the lifecycle module, so it is not stored in
the file.) Removing the dot-prefixed duplicate leaves exactly one resource for
.alerts-ilm-policy.

Category: ilm
Cluster(s) affected: eu-b2b
Risk: LOW — removes a redundant duplicate config file; the surviving file is unchanged.
```

### Turn 18 — 2026-07-09T10:32:11  (req `12369b5d-89fa-4e0c-b8d4-79961117bb98`, thread `822d0a2b-0804-4de1-98c9-3efd739ae3b3`)

```
Deployment: eu-b2b

Delete the ILM policy file environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json on eu-b2b.

This is the dot-prefixed duplicate of the canonical alerts-ilm-policy.json (both
declare the ES policy name ".alerts-ilm-policy", which collides at apply). Remove
ONLY the dot-prefixed file; leave alerts-ilm-policy.json exactly as-is. Open a
delete MR.
```

### Turn 19 — 2026-07-09T10:32:44  (req `1d436b59-6975-43ed-9a0f-5b29d54e81d1`, thread `822d0a2b-0804-4de1-98c9-3efd739ae3b3`)

```
Deployment: eu-b2b

Delete the ILM policy file environments/eu-b2b/lifecycle-policies/.alerts-ilm-policy.json on eu-b2b.

This is the dot-prefixed duplicate of the canonical alerts-ilm-policy.json (both
declare the ES policy name ".alerts-ilm-policy", which collides at apply). Remove
ONLY the dot-prefixed file; leave alerts-ilm-policy.json exactly as-is. Open a
delete MR.
```
