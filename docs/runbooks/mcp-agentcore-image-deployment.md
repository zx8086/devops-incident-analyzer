# MCP AgentCore Image Deployment (Kafka + AWS runtimes)

**Scope:** Deploy a new container image to an existing Bedrock AgentCore MCP runtime (image swap only — estates, env vars, and network config are preserved). Covers the Kafka and AWS runtimes; the procedure is identical except for the per-runtime values below.

**Last validated:** 2026-08-07 — kafka v17 -> v18 and aws v14 -> v15 deploys (SIO-1420/1421/1422/1423), following the 2026-08-06 kafka v14 -> v16 / aws v11 -> v13 deploy (SIO-1400/1402/1407), the 2026-07-19 kafka v11 -> v12 / aws v9 -> v10 deploy (SIO-1161), and the SIO-710 hotfix deploy (v8 -> v10) that originated this runbook.

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
| Boot toolCount canary | **61** (confirmed 2026-08-07; unchanged since 2026-07-19) | **70** (confirmed 2026-09-17; was 63 pre-SIO-1420/1421, 61 pre-SIO-1161) |
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

**Runtime READY is not "the new version is live".** The runtime and its DEFAULT endpoint update separately, and traffic follows the endpoint. On 2026-09-17 the runtime reported READY at v16 within 20 seconds of the update (16:14:07), while the endpoint's `liveVersion` only moved to 16 at 16:14:53. A verification call made in between can land on the previous version. Wait for the endpoint before step 6:

```bash
aws bedrock-agentcore-control get-agent-runtime-endpoint --agent-runtime-id <id> --endpoint-name DEFAULT \
  --profile eu-shared-services-prd --region eu-central-1 \
  --query '{live:liveVersion,target:targetVersion,status:status,lastUpdatedAt:lastUpdatedAt}'
# done when live == the new agentRuntimeVersion, target is null and status is READY
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

**Reset the proxy's session before you verify, or you will test the OLD image (2026-09-17).** The SigV4 proxy keeps ONE process-wide `mcpSessionId` (`packages/shared/src/agentcore-proxy.ts`) and reuses it for every client that connects, and an AgentCore session stays pinned to the microVM, and therefore the image version, it started on. After an update the runtime boots fresh microVMs on the new image, but a proxy that was already running keeps routing to its pre-update microVM: the toolCount still matches (it is the same when no tool was added) and a behavioural check reports the old behaviour, which reads exactly like "the update did not take". Reset the session with the proxy's own endpoint, then verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:3001/mcp   # 3000 for kafka; expect 200
```

**The proxy must be idle when you do this.** The DELETE aborts the session's `AbortController`, and that signal is attached to the upstream `fetch` itself as well as to the retry sleep, so EVERY request in flight through that proxy fails, not only one that is waiting to retry. `activeSseConnections: 0` on the web app's `/health` is necessary but not sufficient: it counts the web app's streams only, and says nothing about another client of the same proxy (an eval run, a probe of your own, a second session). Stop your own probes first and make sure nobody else is using the proxy.

**The proof that the new image is serving is the new BEHAVIOUR, seen after the endpoint has switched.** Log streams cannot prove it, only disprove it. When a behavioural check still shows the old behaviour, use the streams to find out whether your call was pinned to a microVM that predates the update. List boots and tool calls per stream from a few minutes BEFORE the update:

```bash
RUNTIME=aws_mcp_server-iM1Cnu3VtR   # or kafka_mcp_server-7RjmF16MqA
SINCE_MS=<epoch ms, about 10 minutes before update-agent-runtime>
aws logs filter-log-events \
  --log-group-name "/aws/bedrock-agentcore/runtimes/${RUNTIME}-DEFAULT" \
  --start-time "$SINCE_MS" \
  --filter-pattern '?"Starting AWS MCP Server" ?"Starting Kafka MCP Server" ?"tools/call ok"' \
  --profile eu-shared-services-prd --region eu-central-1 \
  --query 'events[*].[timestamp,logStreamName,message]' --output text \
  | awk -F'\t' '{ kind = ($3 ~ /Starting/) ? "BOOT" : "CALL"; print $1, substr($2, length($2)-11), kind }' \
  | sort -n
```

Read it in one direction only. A `CALL` on a stream whose `BOOT` is earlier than the update, or that has no `BOOT` in the window at all, ran on the OLD image for certain and tested nothing: reset the session and call again. A `BOOT` after the update is NOT proof of the new image. The runtime boots a fresh microVM about once a minute on whatever version is live (16:11:35, 16:12:35 and 16:13:35 on the old image, before the 16:14:04 update), so an old-image microVM can boot after any cutoff you note by hand and before the endpoint switches. On the 2026-09-17 deploy the query showed three `CALL` lines on a stream with no `BOOT` in the window (the pinned pre-update microVM) and, after the reset, one on a stream that booted at 16:14:24; what proved the image was that call returning the new behaviour.

A hand-rolled `invoke-agent-runtime` JSON-RPC probe can misreport a 400 from an incomplete MCP session handshake — weight the three signals above over it.

### 7. Rollback

No image is deleted from ECR by a normal deploy, so rollback is always available: edit `containerUri` back to the previous known-good digest and re-run step 5. This creates a new version pointing at the old image, READY within a minute.

## Lessons learned

**2026-09-17 (aws v15 -> v16, SIO-1774 via SIO-1786; kafka NOT redeployed):**

- Rebuilt the aws image from main `68f670f2` to ship SIO-1774's `aws_cloudwatch_describe_alarms` change (PR #813): the six notification and raw-state fields are omitted unless `includeNotificationConfig: true`. It adds a parameter, not a tool. Image tag `sio-1774`. Live digest after this deploy:
  - aws: `399987695868.dkr.ecr.eu-central-1.amazonaws.com/aws-mcp-agentcore@sha256:390b78bce8bd5493c2e2d2dc86eaf16eeb31832124661f20bbc4515ddaf0bd6c`
  - rollback target (previous live): the 2026-08-07 aws digest below.
- First image build since SIO-1776 added `quickjs-emscripten-core` and `@jitl/quickjs-singlefile-cjs-release-sync` to `packages/shared`. `bun install --frozen-lockfile --production` passed inside the container (651 packages); the `Dockerfile.agentcore` COPY list needed no change because these are dependencies of an existing workspace member, not a new member. Image 321 MB in ECR against 316 MB before.
- The push failed twice, and NOT with the 403 seen on earlier deploys: `failed commit on ref "layer-sha256:..."` with `net/http: timeout awaiting response headers` on the 1.23 GB `node_modules` layer. Re-login and retry failed the same way once; the third `docker push` completed in one second with every layer `already exists`. The layer had landed and only ECR's response to the commit had timed out. So: on this error retry the same push again before suspecting the network or IAM, and confirm with `aws ecr describe-images --image-ids imageTag=<tag>`.
- Config diff after the update: only `containerUri`, `agentRuntimeVersion` and `lastUpdatedAt`. Three env vars carried unchanged; `MCP_TOOL_METRICS_DB_PATH` still absent. UPDATING to READY in under 20 seconds.
- toolCount canary unchanged: aws 70.
- The DEFAULT endpoint went live on v16 at 16:14:53, 46 seconds after the runtime's own `lastUpdatedAt` (16:14:07). The first verification call (16:14:25) was therefore made before the switch and proves nothing either way; the two that followed (16:15:11, 16:15:19) were after it and still returned the old payload, which is what isolates the pinned session as the cause rather than the endpoint lag. Step 5 now says to wait for the endpoint.
- **The first three verification calls tested the old image.** They returned the old 78 KB payload with every noise field present, which looked like a failed deploy. The cause was the proxy's pinned session (see the session reset note in step 6): all of them, and the "before" call made ahead of the update, were served by the same pre-update log stream. After `DELETE /mcp` on the proxy the same call was served by a stream that booted after the update and returned 36186 bytes against 78618, none of the six noise fields, all 25 alarms. Zero error lines in the log group since the update. The payload is still delivered as `text` plus `structuredContent`, so both halves shrink; the agent drops the duplicate on its side (`dropDuplicateStructuredContent`).

**2026-08-07 (kafka v17 -> v18, aws v14 -> v15, SIO-1420/1421/1422/1423):**

- Rebuilt both images to pick up the AWS/Kafka `registerTool` conversions (SIO-1420/1421), the structuredContent/outputSchema wave 1 (SIO-1422, PR #622), and the `bootstrap-lifecycle.ts` extraction from `packages/shared/src/bootstrap.ts` (SIO-1423, PR #624) — the latter is a shared-package change that reaches both runtimes' boot path the same way the SIO-1400/1402/1407 metrics/proxy changes did on the prior deploy.
- Image tag `sio-1420-1421-1422-1423` on both repos. Live digests after this deploy:
  - kafka: `399987695868.dkr.ecr.eu-central-1.amazonaws.com/kafka-mcp-agentcore@sha256:55dda9df7b91f9a3369a8ac4149f13e4b1666df6f525962408ef6a66b71c543d`
  - aws: `399987695868.dkr.ecr.eu-central-1.amazonaws.com/aws-mcp-agentcore@sha256:3e2693033fda93c2d9f5dd6a3ca4c47ddf26f586783a7bf76237eda68aeb0fd0`
- Hit the same transient ECR push 403 documented below (2026-08-06 entry) on both images again, on the first push attempt each time. Re-login + retry resolved both immediately, same as before — this is now a recurring transient pattern observed on this repo, not a one-off; verify the account, IAM permissions, and repository policy if re-login and retry do not succeed.
- toolCount canary unchanged from the prior deploy: kafka 61, aws 70. `MCP_TOOL_METRICS_DB_PATH` confirmed absent on both runtimes before and after (the 2026-08-06 stopgap removal held; not reintroduced by this deploy).

**2026-08-06 (kafka v14 -> v16, aws v11 -> v13, SIO-1400/1402/1407):**

- `Dockerfile.agentcore`'s deps stage `COPY`s an explicit, hand-maintained list of workspace `package.json` files rather than globbing `packages/*/package.json`. When SIO-1388 added `packages/tools-verify` it was never added to that list, so `bun install --frozen-lockfile` failed inside the container (workspace member missing from the copied context) while passing cleanly on the host (`bun install --frozen-lockfile --dry-run` sees the real, complete workspace). If a build fails at that step with "lockfile had changes, but lockfile is frozen" and the host-side dry-run is clean, suspect a `Dockerfile.agentcore` COPY-list drift before suspecting the lockfile itself — diff `ls packages/*/package.json` against the `COPY packages/.../package.json` lines.
- `docker push` to this ECR repo intermittently 403'd mid-push (`unexpected status from HEAD request ... 403 Forbidden`) on both images, after a `Login Succeeded` and after the build/smoke-test already passed. Re-running `aws ecr get-login-password | docker login` and retrying the same `docker push` immediately succeeded both times (already-pushed layers correctly reported `Layer already exists`). Treat this as a transient token/session hiccup first: re-login and retry before anything else. Only if the retry still 403s should you move on to checking IAM permissions, the AWS account/region, and the target repository policy — don't rule those out entirely on the strength of two occurrences resolving on retry.
- **Do not enable `MCP_TOOL_METRICS_DB_PATH` on the kafka/aws AgentCore runtimes.** The SIO-1400/1402 tool-call metrics feature (`packages/shared/src/tool-call-metrics.ts`) writes to a local `bun:sqlite` file opened directly by the process — there is no network write path. It works for local dev because every MCP server process shares one filesystem via `.env`. In production, kafka and aws run as two separate AgentCore containers with no shared filesystem with each other or with `apps/web`; setting the env var on both just creates two isolated, unreadable, `/tmp`-ephemeral files (wiped on every redeploy) that nobody can query. It was set live on both runtimes on 2026-08-06 as a stopgap, immediately recognized as inert (`apps/web` has no read path to either container's disk), and removed the same day. If central tool-call visibility is wanted, use the SigV4 proxy's existing CloudWatch logging instead (`Tool call started: <name>` / `tools/call ok` per runtime's log group — see Verification above) — it already provides this without the architecture gap. Centralizing the SQLite-based counters into `apps/web` would need a real design change (counters shipped over HTTP to `apps/web`, or written to a store `apps/web` can query) — file a ticket rather than re-attempting the env var.

**2026-07-19 (kafka v11 -> v12, aws v9 -> v10, SIO-1161):**

- The VPC-mode update asymmetry above (get omits `networkModeConfig`, update requires it, old CLI models reject it) cost the most time; the boto3 fallback resolved it.
- The `docker push` digest in `repo@sha256:...` form went straight into `containerUri` for both runtimes without issue.
- Config-preservation diff (step 5) passed byte-identical for both runtimes on the first try when the payload was jq-projected from the captured JSON rather than retyped.

**2026-07-19 (kafka v8 -> v10, SIO-710 hotfix):**

- A 283MB image tar failed single-shot transfer through capacity-limited channels; split into ~50MB chunks and verify sha256 after reassembly.
- OCI index digest vs inner manifest digest as `containerUri`: both tested live, both work — do not re-investigate.
- The main time sink was testing through the wrong (local stdio) connector; always confirm which physical process a diagnostic call hits, using CloudWatch's incoming-request evidence as the tie-breaker.
- The SIO-710 incident itself was root-caused from CloudWatch logs alone: group-related kafka tools failed with a fixed ~3s timeout while producer-path tools kept succeeding, because the old code built a new Admin client per group call. If that symptom class recurs (some tool types fail, others do not, all failures share one fixed timeout), re-read the SIO-710 comment in `packages/mcp-server-kafka`'s client-manager.
