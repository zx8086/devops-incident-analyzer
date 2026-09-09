# Handover: SIO-1675 Haiku 4.5 trial on the eu-oit-prd spoke

- **Date:** 2026-09-09
- **Ticket:** [SIO-1675](https://linear.app/siobytes/issue/SIO-1675) (Done by merge automation; the evaluation is still open work)
- **Parent work:** [SIO-1673](https://linear.app/siobytes/issue/SIO-1673) mute and budget monitor investigations (PR #717, squash `c3263057`); [SIO-1674](https://linear.app/siobytes/issue/SIO-1674) drift and Config reads (PR #716, squash `05aca3b2`)
- **Repo state:** `main` at `88cd6642` (`docs: bake-off ledger for PR #718`); trial root merged in PR #718, squash `af26bd91`
- **Suggested branch for follow-up:** `sio-1675-haiku-trial-decision`

## TL;DR

eu-oit-prd's Pi spoke has run on `eu.anthropic.claude-haiku-4-5-20251001-v1:0` since 2026-09-09 13:35Z on instance `i-0cfa0e49f544e1288` (bundle `58d4ac28`). The other prd spokes stay on the fleet default `eu.anthropic.claude-sonnet-5`. On or after 2026-09-16, compare a week of Bedrock usage and report quality against the Sonnet baseline below and decide: keep on eu-oit-prd, widen to the fleet, or revert. Success is a clear cost reduction with no rise in unparseable or wrong diagnoses.

## Context: how this ticket came to be

The eu-oit-prd spoke sat at 98% of a 1,000,000-token window and its account read 148.9M cached tokens plus 52.6M cache writes over 7 to 9 Sep (386 invocations), about ten times eu-mendix-platform-prd. SIO-1673 fixed the mechanism (per-day and per-resource investigation budget, operator controls, spoke refusal rail, token-based compaction) and shipped in bundle `58d4ac28`. With turns bounded, the remaining lever is the per-token price, so the user asked for a Haiku 4.5 trial on the noisiest account only. Design note: the SIO-1673 plan in `docs/code-review-bakeoff.md` (PR #717 and #718 entries) and the Linear tickets above. There is no spec file; the change was bounded.

Per Pi's model registry (Bedrock provider, USD per million tokens): Sonnet 5 input 2.2 / output 11 / cache read 0.22 / cache write 2.75, 1M window; Haiku 4.5 input 1.1 / output 5.5 / cache read 0.11 / cache write 1.375, 200K window. The Bedrock pricing page is authoritative.

## Where the bodies are buried

The model rides in userdata, so changing it replaces the instance:

`packages/pi-coms/deploy/modules/agent/userdata.sh.tftpl:33`
```bash
export PI_MODEL='${pi_model}'
```

`packages/pi-coms/deploy/modules/agent/main.tf:544` (`user_data_replace_on_change = true`) and `:559` (`pi_model = var.pi_model`).

The per-spoke override lives in the gitignored manifest and is rendered into a TRACKED root:

`packages/pi-coms/scripts/fleet/render.ts:109-113`
```hcl
variable "pi_model" {
  description = "Bedrock inference-profile id the agent runs."
  type        = string
  default     = ${hcl(spoke.pi_model ?? manifest.defaults.pi_model)}
}
```

`packages/pi-coms/deploy/accounts/eu-oit-prd/main.tf:71-75` now defaults to the Haiku profile (PR #718). The manifest override is in the main checkout only:

`packages/pi-coms/deploy/fleet.yaml` (gitignored), under `spokes.eu-oit-prd`:
```yaml
    # SIO-1675: Haiku 4.5 trial on the noisiest prd account ...
    pi_model: eu.anthropic.claude-haiku-4-5-20251001-v1:0
```

The monitor's state is on the instance root volume and is lost on replacement:

`packages/pi-coms/scripts/coms-net-monitor.ts:120`
```ts
const STATE_DB = process.env.PI_MONITOR_STATE_DB ?? path.join(os.homedir(), ".pi", "monitor", "state.db");
```

After the swap the two SIO-1673 suppressions were re-sent and accepted (ledger: `logs:/ecs/fargate/eu-oit-prd-log-group:%`, `logs:/ecs/fargate/connectors-prd-log-group:%`). Any future replacement needs the same.

Rails that bound the comparison regardless of model (all shipped in `58d4ac28`):

`packages/pi-coms/scripts/coms-net-monitor.ts:85-88`
```ts
const INVESTIGATE_BUDGET: BudgetLimits = {
	perDay: envCount(process.env.PI_MONITOR_INVESTIGATE_BUDGET_PER_DAY, 24),
	perResourcePerDay: envCount(process.env.PI_MONITOR_INVESTIGATE_PER_RESOURCE_PER_DAY, 3),
};
```

`packages/pi-coms/extensions/coms-net.ts:31-33`
```ts
const MUTE_SENDERS = parseMutePatterns(process.env.PI_COMS_NET_MUTE_SENDERS);
const REFUSE_ABOVE_PCT = Number(process.env.PI_COMS_NET_REFUSE_ABOVE_PCT) || 85;
const COMPACT_ABOVE_TOKENS = Number(process.env.PI_COMS_NET_COMPACT_ABOVE_TOKENS) || 150_000;
```

Note for the comparison: Haiku's 200K window means Pi's own compaction also fires at about 184K tokens, and the extension compacts after investigation turns past 150K, so the Haiku spoke will compact more often than the Sonnet spokes. That is expected and is part of what makes it cheaper.

## The evaluation (step by step)

### 1. Pull a week of Bedrock usage for both models

Save as `bedrock-usage.sh` and run; SSO profiles `eu-oit-prd`, `eu-mendix-platform-prd`, `eu-shared-services-prd` exist. Re-authenticate with `aws sso login --profile <p>` if STS fails.

```bash
#!/usr/bin/env bash
set -u
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START=$(date -u -v-14d +%Y-%m-%dT00:00:00Z)
for P in eu-oit-prd eu-mendix-platform-prd eu-shared-services-prd; do
  for MODEL in eu.anthropic.claude-haiku-4-5-20251001-v1:0 eu.anthropic.claude-sonnet-5; do
    echo "===== $P  $MODEL"
    Q=$(python3 - "$MODEL" <<'PY'
import json,sys
m=sys.argv[1]
def q(i,n): return {"Id":i,"MetricStat":{"Metric":{"Namespace":"AWS/Bedrock","MetricName":n,"Dimensions":[{"Name":"ModelId","Value":m}]},"Period":86400,"Stat":"Sum"}}
print(json.dumps([q("inv","Invocations"),q("inp","InputTokenCount"),q("cr","CacheReadInputTokenCount"),q("cw","CacheWriteInputTokenCount"),q("out","OutputTokenCount")]))
PY
)
    AWS_PROFILE=$P aws cloudwatch get-metric-data --region eu-central-1 --start-time "$START" --end-time "$END" \
      --metric-data-queries "$Q" --output json | python3 -c '
import json,sys
d=json.load(sys.stdin); rows={}
for r in d.get("MetricDataResults",[]):
  for t,v in zip(r["Timestamps"],r["Values"]): rows.setdefault(t[:10],{})[r["Id"]]=int(v)
print("date        invocations  input  cache_read  cache_write  output")
for day in sorted(rows):
  x=rows[day]; g=lambda k:x.get(k,0)
  print("%s  %11s  %5s  %10s  %11s  %6s" % (day,format(g("inv"),","),format(g("inp"),","),format(g("cr"),","),format(g("cw"),","),format(g("out"),",")))'
  done
done
```

Expected: eu-oit-prd shows Sonnet rows up to 2026-09-09 and Haiku rows from 2026-09-09 on. The Sonnet baseline to beat, 7 to 9 Sep on eu-oit-prd: 386 invocations, 148.9M cache-read, 52.6M cache-write, 0.2M output. Use the cost columns above for USD; note the SIO-1673 budget also cuts the numbers, so compare per-invocation cache figures as well as totals, and compare against the two Sonnet spokes over the same week to separate the model effect from the budget effect.

### 2. Measure report quality from the ops inbox

Open a tunnel to the prd hub, read the mailbox, count markers per sender and day. Token and project come from `PI_COMS_HUBS` in the repo root `.env` (key `eu-shared-services-prd`).

```bash
cd packages/pi-coms && just hub-tunnel eu-shared-services-prd     # leaves localhost:8788 forwarded; Ctrl+C when done
```

```bash
python3 - <<'PY'
import json,re,urllib.request,collections
env=open(".env").read()
hub=json.loads(re.search(r'^PI_COMS_HUBS=(.*)$',env,re.M).group(1).strip().strip("'\""))["eu-shared-services-prd"]
r=urllib.request.Request(hub["serverUrl"]+f"/v1/mailbox?name=ops&project={hub['project']}&limit=500",headers={"authorization":"Bearer "+hub["authToken"]})
msgs=json.load(urllib.request.urlopen(r,timeout=30))["messages"]
c=collections.Counter()
for m in msgs:
    day=m["created_at"][:10]; s=m["sender_name"]; b=m["prompt"]
    c[(day,s,"reports")]+=1
    c[(day,s,"invalid_json")]+=b.count("response not valid JSON")
    c[(day,s,"schema_mismatch")]+=b.count("did not match the diagnosis schema")
    c[(day,s,"refused")]+=b.count("refused:")
    c[(day,s,"budget_held")]+=b.count("investigation cap")+b.count("budget exhausted")
for k in sorted(c): print(k,c[k])
PY
```

Expected: for `monitor-eu-oit-prd`, `invalid_json` and `schema_mismatch` stay at or near zero. Any sustained non-zero count is the Haiku disqualifier (the diagnosis contract is bare JSON, `packages/pi-coms/scripts/monitor/report.ts` `DIAGNOSIS_RESPONSE_SCHEMA`). Then spot-check five diagnoses from the Haiku spoke against the same finding families on a Sonnet spoke.

Kill the tunnel afterwards and prove it: `lsof -nP -iTCP:8788 -sTCP:LISTEN` returns nothing.

### 3. Decide

- **Keep:** no action; leave the manifest override and the root as they are.
- **Widen to the fleet:** set `defaults.pi_model` in `deploy/fleet.yaml`, remove the eu-oit-prd override, `just fleet render` for every spoke, then a plan-guarded apply per spoke (each is an instance replacement; re-send that spoke's suppressions afterwards). Commit the re-rendered roots.
- **Revert:** delete the `pi_model` line under `spokes.eu-oit-prd` in `deploy/fleet.yaml`, re-render, apply, commit the root. Same replacement and suppression consequences.

Apply recipe that avoids the render trap (a bare render writes a PLACEHOLDER hub token into `terraform.tfvars`, and the plan then wants to rewrite the SSM token parameter):

```bash
cd packages/pi-coms && bun scripts/fleet.ts render eu-oit-prd
cd deploy/accounts/eu-oit-prd
# use the real inputs from the main checkout, not the rendered placeholder
cp /path/to/main-checkout/packages/pi-coms/deploy/accounts/eu-oit-prd/{terraform.tfvars,backend.hcl} .
AWS_PROFILE=eu-oit-prd terraform init -input=false -backend-config=backend.hcl -reconfigure
AWS_PROFILE=eu-oit-prd terraform plan -input=false -no-color -out=plan.tfplan | grep -E "^Plan:|^  # "
# expect EXACTLY: aws_instance.agent must be replaced + agent_status_check updated in-place, "1 to add, 1 to change, 1 to destroy"
AWS_PROFILE=eu-oit-prd terraform apply -input=false plan.tfplan
```

Then wait for `eu-oit-prd` and `monitor-eu-oit-prd` to be online on the hub (`GET /v1/agents?project=pi-coms-prd&include_explicit=true`, the `model` field shows the profile) and re-send the two suppressions to `monitor-eu-oit-prd`. A programmatic sender registers as `incident-analyzer-<suffix>` with the `PI_COMS_HUBS` token (that principal's allowed name pattern), POSTs `/v1/messages`, awaits, then DELETEs its session.

## Verification

```bash
bun run typecheck && bun run lint && bun run test
cd packages/pi-coms && bun test          # 296 pass on main as of 88cd6642
```

Live probes: step 1 and step 2 above; `AWS_PROFILE=eu-oit-prd aws sts get-caller-identity` returns account `762715229080`.

## Files to modify

| File | Change |
|---|---|
| `packages/pi-coms/deploy/fleet.yaml` (gitignored, main checkout) | keep, move to `defaults.pi_model`, or delete the eu-oit-prd override |
| `packages/pi-coms/deploy/accounts/eu-oit-prd/main.tf` | re-rendered `pi_model` default; commit whatever the decision renders |
| `packages/pi-coms/deploy/accounts/<spoke>/main.tf` (widen only) | one re-rendered root per spoke |
| `docs/code-review-bakeoff.md` | one ledger entry per PR |

## Workflow

Branch off `main`; Linear SIO-1675 is already Done (merge automation), so record the decision as a comment there rather than reopening unless work is needed. PRs ready for review, never draft. Greptile has SKIPPED every PR since #711 and CodeRabbit is silent; merge only on the user's explicit per-PR go-ahead and append the bake-off ledger. Commit template:

```bash
git commit -F - <<'MSG'
SIO-1675: <keep|widen|revert> the Haiku 4.5 trial on eu-oit-prd

<one paragraph: the week's numbers, the quality counts, the decision>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Haiku replies are not bare JSON, reports show `response not valid JSON` | medium | step 2 counts it; revert if sustained |
| Comparison confounded by the SIO-1673 budget (fewer prompts on every spoke) | high | compare per-invocation cache figures and the two Sonnet spokes over the same week |
| A `fleet apply` from a stale checkout reverts the model (instance churn) | low after #718 | the root is committed; pull main before any fleet apply |
| Render writes a placeholder hub token | high if rendered without `tokens ensure` | diff tfvars against the main checkout before planning; plan must not touch `aws_ssm_parameter.coms_token` |
| Replacement loses monitor state | certain on any replacement | re-send suppressions; fingerprints reset so expect a first-cycle re-alert burst, bounded by the budget |
| SSO session expired | medium | `aws sso login --profile <p>` before probes |

## Out of scope

- Changing the logs check's per-signature re-alert or per-group caps (`packages/pi-coms/scripts/monitor/checks/logs.ts`); SIO-1673 deliberately left the noise source alone.
- Moving the monitor state db to a persistent volume.
- Any other spoke's model.

## Related code references

- `packages/pi-coms/scripts/fleet.ts:166-183` `runPublish` (`--hub <key>`), `:248-288` `runRollout` (needs the hub token in the env named by the hub's `token_env`; its poll waits on spokes that go offline mid-run)
- `packages/pi-coms/scripts/monitor/budget.ts` `investigationUsage` / `planInvestigation` (refused rows do not count)
- `packages/pi-coms/scripts/monitor/controls.ts` `investigate on|off`, `pause`, `resume` (persisted in the state db, lost on replacement)
- `packages/pi-coms/extensions/inboundPolicy.ts` `decideInbound` (refusal reasons start with `refused:`)
- `packages/pi-coms/docs/architecture/monitoring.md` "Investigation budget and operator controls (SIO-1673)"
- `packages/pi-coms/docs/deployment/operations-gotchas.md` per-host `~/.coms-env.local` and the 1M-window compaction note

## Memory references

- `reference_sio1675_fleet_render_placeholder_token_and_model_swap`
- `reference_sio1673_spoke_context_1m_window_and_early_reply_race`
- `reference_sio1653_fleet_deploy_cli`
- `reference_sio1635_pi_coms_hub_client_gotchas`
- `reference_pi_coms_send_403_name_not_allowed`
- `feedback_no_cross_environment_access`
