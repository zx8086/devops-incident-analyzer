# MCP AgentCore Image Deployment (Kafka + AWS runtimes)

**Scope:** Deploy a new container image to an existing Bedrock AgentCore MCP runtime (image swap only — estates, env vars, and network config are preserved). Covers the Kafka and AWS runtimes; the procedure is identical except for the per-runtime values below.

**Last validated:** 2026-07-19 — kafka v11 -> v12 and aws v9 -> v10 deploys (SIO-1161), following the SIO-710 hotfix deploy (v8 -> v10) that originated this runbook.

---

## Quick reference

| Field | Kafka runtime | AWS runtime |
|---|---|---|
| Runtime ID | `kafka_mcp_server-7RjmF16MqA` | `aws_mcp_server-iM1Cnu3VtR` |
| Account / profile | `399987695868` — profile `eu-shared-services-prd` (region `eu-central-1`) | same |
| ECR repository | `399987695868.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore` | `.../aws-mcp-agentcore` |
| Execution role | `kafka-mcp-agentcore-role-prd` | `DevOpsAgentCoreRole` |
| Network mode | **VPC** (MSK subnets + SG — see the VPC gotcha below) | PUBLIC |
| SigV4 proxy port (local) | 3000 | 3001 |
| CloudWatch log group | `/aws/bedrock-agentcore/runtimes/kafka_mcp_server-7RjmF16MqA-DEFAULT` | `/aws/bedrock-agentcore/runtimes/aws_mcp_server-iM1Cnu3VtR-DEFAULT` |
| Boot toolCount canary | compare against the previous boot (61 as of 2026-07-19) | **63** (was 61 pre-SIO-1161) |
| Image architecture | linux/arm64 — never push amd64 | same |

**Do not assume — verify the account before every deploy.** `eu-shared-services-prd` is account `399987695868`. Profile stanzas in `~/.aws/credentials` are hand-pasted SSO keys and have held the wrong account's keys before; the stanza header comment controls nothing. Run `aws sts get-caller-identity --profile eu-shared-services-prd` and confirm the account id before touching ECR or the runtime.

## Architecture: which path does a deploy actually change?

Two independent instances of each MCP server exist and are easy to confuse under time pressure:

- **Production path (what this runbook deploys):** web/agent client -> local SigV4 proxy (port 3000 kafka / 3001 aws, signs requests) -> Bedrock AgentCore runtime -> MSK / cross-account AWS APIs. This is the only path real users hit.
- **Local dev path (NOT affected by any AgentCore deploy):** an MCP connector on the developer workstation can launch its own local copy of the same server binary over stdio (kafka: provider `local`, `bootstrapServers localhost:9092`). With no local broker, every call through that connector fails with the exact same MCP error (`-32603`) as a real MSK failure would — while testing nothing. Confirm which path a diagnostic call actually hits (see Verification) before drawing conclusions.

## Prerequisites

- AWS CLI v2 authenticated as a role that can call `bedrock-agentcore-control:UpdateAgentRuntime` and `ecr:*` on the target repo (profile `eu-shared-services-prd`).
- Docker with a running daemon (Apple Silicon builds arm64 natively).
- The new image. Build it from source with the standard script (arm64 + smoke-tested; the kafka smoke-test env was fixed in SIO-1156 — tarballs built before that fix are suspect):

```bash
./scripts/agentcore/push-to-production-ecr.sh --package mcp-server-kafka --export-tarball --tag <ticket-or-date>
./scripts/agentcore/push-to-production-ecr.sh --package mcp-server-aws   --export-tarball --tag <ticket-or-date>
```

## Step-by-step

### 1. Get the image into your working environment

If transferring a large tar (200-300MB is typical) through a slow or capacity-limited channel, split and reassemble rather than retrying a failing single-shot transfer:

```bash
split -b 50m -d kafka-mcp-agentcore.tar.gz kafka-mcp-agentcore.part-
# transfer each part, then on the receiving end:
cat kafka-mcp-agentcore.part-* > kafka-mcp-agentcore.tar.gz
sha256sum kafka-mcp-agentcore.tar.gz   # compare against the source hash
```

### 2. Load and inspect before pushing anything

Never push an image you have not inspected. Confirm the architecture and see how large the change really is:

```bash
docker load -i kafka-mcp-agentcore.tar.gz
docker inspect kafka-mcp-agentcore:<tag> --format 'Architecture: {{.Architecture}}  Os: {{.Os}}'   # MUST be arm64

# Compare layers against the currently-live digest (from get-agent-runtime) to see the real blast radius:
aws ecr get-login-password --profile eu-shared-services-prd --region eu-central-1 | \
  docker login --username AWS --password-stdin 399987695868.dkr.ecr.eu-central-1.amazonaws.com
docker pull 399987695868.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore@sha256:<current-live-digest>
diff <(docker inspect <repo>@sha256:<current-live-digest> --format '{{json .RootFS.Layers}}' | python3 -m json.tool) \
     <(docker inspect kafka-mcp-agentcore:<tag> --format '{{json .RootFS.Layers}}' | python3 -m json.tool)
```

### 3. Push to ECR

```bash
docker tag kafka-mcp-agentcore:<tag> 399987695868.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore:<tag>
docker push 399987695868.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore:<tag>
```

Use a descriptive tag (ticket number or date), not `latest`, so ECR history stays legible.

**Index digest vs inner manifest digest — both work.** `docker push` of a buildx image reports an OCI image-index digest (wrapping the platform manifest + a build attestation). AgentCore's `containerUri` accepts either the index digest or the inner manifest digest — both tested live. Simplest default: use the digest `docker push` prints, in the `repo@sha256:...` form.

### 4. Preserve the existing runtime configuration exactly

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id kafka_mcp_server-7RjmF16MqA \
  --profile eu-shared-services-prd --region eu-central-1 > current-runtime-config.json
```

Build the update payload from that JSON, changing ONLY `agentRuntimeArtifact.containerConfiguration.containerUri` and projecting to the fields `update-agent-runtime` accepts (`agentRuntimeId`, `agentRuntimeArtifact`, `roleArn`, `networkConfiguration`, `protocolConfiguration`, `environmentVariables`, `description`). Do not hand-retype `environmentVariables` — the kafka runtime carries 18 of them and a typo is silent config drift.

> **VPC-mode gotcha (kafka runtime; verified live 2026-07-19).** `get-agent-runtime` returns only `{"networkMode": "VPC"}` — it does NOT return the `networkModeConfig` (subnets/security groups), yet `update-agent-runtime` REQUIRES it for VPC runtimes (`ValidationException: NetworkModeConfig is required for VPC mode`). Two additional traps:
>
> 1. **An outdated AWS CLI rejects the parameter entirely** (`Unknown parameter in networkConfiguration: "networkModeConfig"` — CLI 2.28.16's model predates it). Use an up-to-date CLI, or boto3 in a venv: `client.update_agent_runtime(**payload)` with current botocore works.
> 2. **Recovering the subnets/SGs:** the kafka runtime was created with the MSK cluster's own client subnets + security group. Read them live rather than guessing:
>    ```bash
>    aws kafka describe-cluster-v2 --cluster-arn <MSK_CLUSTER_ARN from the runtime env> \
>      --query 'ClusterInfo.Provisioned.BrokerNodeGroupInfo.{subnets: ClientSubnets, securityGroups: SecurityGroups}'
>    ```
>    Cross-check via `aws ec2 describe-network-interfaces --filters Name=group-id,Values=<sg>` — the runtime's own in-use ENIs appear on that SG in the same subnets.
>
> The AWS runtime is PUBLIC mode and unaffected.

### 5. Apply the update and wait for READY

```bash
aws bedrock-agentcore-control update-agent-runtime \
  --cli-input-json file://update-runtime.json \
  --profile eu-shared-services-prd --region eu-central-1

# Poll until UPDATING -> READY (typically under a minute):
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id> \
  --profile eu-shared-services-prd --region eu-central-1 --query status
```

Each update creates a new immutable version (v10, v11, v12...). Immediately re-fetch the config and diff against the captured one — confirm the only differences are `containerUri` plus the expected metadata churn (`agentRuntimeVersion`, timestamps, `status`); any other delta means a field was dropped or retyped.

### 6. Verify — the step that has gone wrong before

**Do not test through the local stdio MCP connector** (see Architecture above — it produced ~40 minutes of false-alarm debugging on 2026-07-19 because its failure is indistinguishable from a real outage). Use these instead, in order of trust:

1. **toolCount canary.** Through the SigV4 proxy, run the MCP handshake and `tools/list`; compare the count against the expected value (see Quick reference). A count matching the OLD build means the runtime is still serving the previous image — the update did not take or pointed at the wrong digest.
2. **A real tool call through the SigV4 proxy** — e.g. `kafka_get_cluster_info` (returns live MSK topic counts) or `aws_cloudwatch_metrics_insights_query` with a known-good query. The proxy log shows `Proxying tool call: X` -> `Tool call proxied: X -> ok`.
3. **CloudWatch logs** in the runtime's log group: a fresh container booting cleanly (component reachability + tools-registered lines), then `Tool call started: <name>` / `tools/call ok` for real invocations. Zero `Tool call started` lines across repeated real invocations means requests are not reaching tool dispatch — a genuine transport signal, not connector noise.

```bash
aws logs filter-log-events \
  --log-group-name /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT \
  --start-time <ms-epoch> --end-time <ms-epoch> \
  --filter-pattern '?"tools/call" ?ERROR ?error' \
  --profile eu-shared-services-prd --region eu-central-1 \
  --query 'events[*].message' --output text
```

A hand-rolled `invoke-agent-runtime` JSON-RPC probe can misreport a 400 from an incomplete MCP session handshake — weight the three signals above over it.

### 7. Rollback

No image is deleted from ECR by a normal deploy, so rollback is always available: edit `containerUri` back to the previous known-good digest and re-run step 5. This creates a new version pointing at the old image, READY within a minute.

## Lessons learned

**2026-07-19 (kafka v11 -> v12, aws v9 -> v10, SIO-1161):**

- The VPC-mode update asymmetry above (get omits `networkModeConfig`, update requires it, old CLI models reject it) cost the most time; the boto3 fallback resolved it.
- The `docker push` digest in `repo@sha256:...` form went straight into `containerUri` for both runtimes without issue.
- Config-preservation diff (step 5) passed byte-identical for both runtimes on the first try when the payload was jq-projected from the captured JSON rather than retyped.

**2026-07-19 (kafka v8 -> v10, SIO-710 hotfix):**

- A 283MB image tar failed single-shot transfer through capacity-limited channels; split into ~50MB chunks and verify sha256 after reassembly.
- OCI index digest vs inner manifest digest as `containerUri`: both tested live, both work — do not re-investigate.
- The main time sink was testing through the wrong (local stdio) connector; always confirm which physical process a diagnostic call hits, using CloudWatch's incoming-request evidence as the tie-breaker.
- The SIO-710 incident itself was root-caused from CloudWatch logs alone: group-related kafka tools failed with a fixed ~3s timeout while producer-path tools kept succeeding, because the old code built a new Admin client per group call. If that symptom class recurs (some tool types fail, others do not, all failures share one fixed timeout), re-read the SIO-710 comment in `packages/mcp-server-kafka`'s client-manager.
