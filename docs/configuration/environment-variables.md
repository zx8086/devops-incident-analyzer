# Environment Variables Reference

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-09-30

Complete reference for all environment variables used across the DevOps Incident Analyzer monorepo. Variables are grouped by service. Each table lists the variable name, whether it is required, its default value (if any), and a description.

---

## Overview

The `.env.example` file at the repository root is the source of truth for all environment variables. Copy it to `.env` before first run:

```bash
cp .env.example .env
```

Bun loads `.env` automatically -- no `dotenv` package is needed. Variables follow a consistent naming convention:

- `SERVICE_PROPERTY` for top-level settings (e.g., `KAFKA_PROVIDER`)
- `SERVICE_ID_PROPERTY` for multi-instance settings (e.g., `ELASTIC_PRODUCTION_URL`)
- Boolean values: `true` or `false` (case-insensitive, coerced by the config loader)
- List values: comma-separated strings (e.g., `ELASTIC_DEPLOYMENTS=production,staging`)

Each MCP server's config loader reads these variables via its `envMapping.ts` file, overlays them onto defaults from `defaults.ts`, and validates the result with the Zod schema in `schemas.ts`. See [MCP Server Configuration](mcp-server-configuration.md) for details on the 4-pillar pattern.

---

## AWS

AWS credentials for Bedrock LLM inference. All three variables are required for the agent to make LLM calls.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_REGION` | Yes | `eu-west-1` | AWS region for Bedrock model access |
| `AWS_ACCESS_KEY_ID` | Yes | -- | IAM access key ID |
| `AWS_SECRET_ACCESS_KEY` | Yes | -- | IAM secret access key |

The agent uses Bedrock for Claude model inference. Ensure your IAM user has `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions for the configured region.

---

## AWS MCP — Multi-Estate

The AWS MCP server (`packages/mcp-server-aws`) serves N target AWS accounts ("estates") from a single runtime. The agent's `awsEstateRouter` node expands a single AWS dispatch into one `Send` per configured estate, and the runtime calls `sts:AssumeRole` per-estate at boot.

### Estate registry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_ESTATES` | Yes (for AWS datasource) | -- | One-line JSON map: `{ "<estate-id>": { "assumedRoleArn": "...", "externalId": "..." }, ... }`. Estate IDs must be lowercase alphanumeric with optional hyphens. The `externalId` is required by the trust policy on each target account's role (confused-deputy protection). See `.env.example` for canonical multi-estate format. |
| `AWS_DEFAULT_ESTATE` | No | First key in `AWS_ESTATES` | Default estate when a tool call omits the `estate` argument. |

Per-estate `AssumeRole` failures do **not** block startup (4-pillar pattern): the runtime always boots and reports per-estate health via the `aws_list_estates` MCP tool. Calls against a degraded estate surface `AccessDenied` at call time.

### AgentCore runtime

The AWS MCP server runs in AWS Bedrock AgentCore Runtime in production; locally it runs behind a SigV4-signed proxy.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_MCP_URL` | Yes (for AWS datasource) | `http://localhost:3001` | URL the agent connects to. Locally points at the SigV4 proxy; in production points at the deployed AgentCore endpoint. |
| `AWS_AGENTCORE_RUNTIME_ARN` | Yes (production) | -- | `arn:aws:bedrock-agentcore:<region>:<account>:runtime/aws_mcp_server-XXXXX`. Set by `scripts/agentcore/deploy.sh` output. |
| `AWS_AGENTCORE_REGION` | Yes (production) | -- | Region of the AgentCore runtime (commonly `eu-central-1`). |
| `AWS_AGENTCORE_PROXY_PORT` | No | `3001` | Local port the SigV4 proxy listens on. Must match `AWS_MCP_URL`. |
| `AWS_AGENTCORE_AWS_PROFILE` | No | -- | AWS CLI profile used by the local proxy to sign requests. Mutually exclusive with explicit creds below. |
| `AWS_AGENTCORE_AWS_ACCESS_KEY_ID` / `AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY` / `AWS_AGENTCORE_AWS_SESSION_TOKEN` | No | -- | Explicit creds for the proxy when no profile is configured. The session token is needed only for temporary credentials. |
| `KAFKA_AGENTCORE_RUNTIME_ARN` | No | -- | When set, the Kafka MCP entry point starts as a SigV4 proxy to that AgentCore runtime instead of connecting to brokers itself, using the same `KAFKA_AGENTCORE_*` naming as the AWS variables above. See [Kafka AgentCore SigV4](../deployment/kafka-agentcore-sigv4.md). |

The AWS MCP server's own process reads a small set of variables besides `AWS_REGION` and `AWS_ESTATES`. Its defaults target AgentCore, so a runtime with only those two set boots correctly.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_MCP_LOG_LEVEL` | No | `info` | `debug`, `info`, `warn` or `error`. |
| `MCP_TRANSPORT` (or `TRANSPORT_MODE`) | No | `agentcore` | `stdio`, `http`, `both` or `agentcore`. Local CLI use sets `MCP_TRANSPORT=stdio`. |
| `MCP_PORT` (or `TRANSPORT_PORT`) | No | `8000` | Listen port. |
| `MCP_HOST` (or `TRANSPORT_HOST`) | No | `0.0.0.0` | Bind host. |
| `TRANSPORT_PATH` | No | `/mcp` | HTTP path. |

### AgentCore proxy retry budget (SIO-868)

These tune the SigV4 proxy's JSON-RPC retry loop and apply to **every** AgentCore-proxied server (AWS and Kafka), not just AWS. A runtime that has scaled to zero emits `-32010` "Runtime health check failed or timed out" for ~40-50s while cold-starting; the proxy retries until it warms. Defaults ride out a ~50s cold-start.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTCORE_JSONRPC_RETRY_MAX_ATTEMPTS` | No | `9` | Max JSON-RPC `-320xx` retry attempts per tool call. Raise for environments with slower cold-starts. |
| `AGENTCORE_JSONRPC_RETRY_DEADLINE_MS` | No | `60000` | Cumulative wallclock budget (ms) for all retries of one tool call -- the effective bound. A retry that would overshoot the deadline is skipped and the call fails fast, and each in-flight TCP try is clamped to the time left, so the whole call never outlasts it (SIO-1871). The agent bridge's AgentCore connect timeout is derived from this value plus 15s. |

**Tradeoff:** a genuinely-unavailable runtime is retried up to the deadline before the call fails, so a higher deadline trades faster cold-start recovery for slower fast-fail on a hard-down runtime.

### AgentCore deployment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EXECUTION_ROLE_ARN` | Yes (for `scripts/agentcore/deploy.sh MCP_SERVER=aws`) | -- | Pre-existing IAM role in the AgentCore account that carries the inline `DevOpsAgentCoreAssumePolicy`. The deploy script pre-flights with `iam:GetRole`; it does **not** create the role. Provisioning is documented in [AWS Estate Onboarding](../runbooks/aws-estate-onboarding.md). |

**Migration from legacy singletons:** `AWS_ASSUMED_ROLE_ARN` and `AWS_EXTERNAL_ID` are removed. Move them into `AWS_ESTATES`. The generic `AGENTCORE_*` vars (without server prefix) are also no longer honored — use `AWS_AGENTCORE_*` (and `KAFKA_AGENTCORE_*` for Kafka, etc.) per.

See [AWS Estate Onboarding](../runbooks/aws-estate-onboarding.md) for the full account-onboarding procedure (IAM role + trust policy + ExternalId + deploy).

---

## Elastic IaC MCP

The Elastic IaC MCP server (`packages/mcp-server-elastic-iac`, port 9086) backs the **Elastic IaC agent** -- the natural-language maker for Elastic Cloud Terraform changes. It is read/plan/branch-only (no apply or destroy tools), and uses a single `src/config.ts` `loadConfig()` rather than the 4-pillar `config/` directory. See the [Elastic IaC Agent design](../superpowers/specs/2026-06-02-elastic-iac-agent-design.md).

### Server (transport + repository)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_IAC_MCP_TRANSPORT` | No | `http` | Transport mode (`http` \| `stdio`) |
| `ELASTIC_IAC_MCP_PORT` | No | `9086` | Server listen port |
| `ELASTIC_IAC_MCP_HOST` | No | `0.0.0.0` | Server bind host |
| `ELASTIC_IAC_MCP_PATH` | No | `/mcp` | HTTP path prefix |
| `ELASTIC_IAC_GITLAB_BASE_URL` | No | `https://gitlab.com` | GitLab REST base for MRs, file blobs, and repository tree (SIO-891 migration name; falls back to `GITLAB_BASE_URL`) |
| `ELASTIC_IAC_GITLAB_PROJECT` | No | `pvhcorp/dhco/observability/observability-elastic-iac` | GitLab project path of the IaC repo |
| `ELASTIC_IAC_GITLAB_PROJECT_ID` | No | `82850717` | GitLab numeric project ID (alternative to the path) |
| `ELASTIC_IAC_GITLAB_TOKEN` | No | -- | GitLab token used to branch/commit/open MRs (SIO-891 migration name; falls back to `GITLAB_PERSONAL_ACCESS_TOKEN`) Rotating it in `.env` requires restarting the process: the elastic-iac MCP (`bun --env-file`) picks a new value up only on its own restart. |
| `ELASTIC_IAC_WORKSPACE_DIR` | No | `/tmp/elastic-iac-workspace` | Local directory the git/task tools clone and operate inside (never the agent's CWD) |
| `ELASTIC_IAC_TASK_BIN` | No | `task` | Path to the Task binary the on-demand CI/pipeline tools invoke |
| `ELASTIC_CLOUD_BASE_URL` | No | `https://api.elastic-cloud.com` | Elastic Cloud API base for deployment / plan-history reads |

### Credentials (optional; tools degrade with a clear message when absent)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITLAB_PERSONAL_ACCESS_TOKEN` | No | -- | GitLab token for MR creation and repo reads (shared name with the GitLab datasource server) |
| `EC_API_KEY` | No | -- | Elastic Cloud API key for deployment reads (shared name with the Elasticsearch MCP cloud/billing tools) |

### Agent connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_IAC_MCP_URL` | Yes (for the IaC agent) | `http://localhost:9086` | URL the web server/agent connects to (`apps/web/src/lib/server/agent.ts`). Its `/identity` role must be `elastic-iac-mcp`. |
| `ELASTIC_IAC_GITLAB_TOKEN` | No | -- | Agent-side GitLab token for branch/commit/MR; mirrors the MCP-side default so no extra config is needed when shared. Rotating it in `.env` requires a full web dev-server restart: Vite restarts in place on the `.env` change but its `loadEnv` keeps the existing (stale) `process.env` value, so the importer keeps 401ing; since SIO-1647 the importer backs off 15 min per rejected token value and logs one warn saying so. |

## PVH Landing Zone IaC MCP

The Landing Zone MCP (`packages/mcp-server-landing-zone-iac`, port 9088) supplies bounded private-GitLab evidence to the `landing-zone-terraform` graph. Its ten read tools are the default surface. Three branch/commit/MR tools are registered only after the write policy validates. It has no merge, pipeline-trigger, Terraform apply, or Terraform state tools.

Account-specific topology authorization is not configured through an environment variable. The server-side Landing Zone graph verifies exact membership against the existing account catalog through its dedicated read-only AWS role. See [Landing Zone Agent Runbook](../operations/landing-zone-agent-runbook.md#landing-zone-account-catalog-access).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANDING_ZONE_IAC_MCP_URL` | Yes (for Landing Zone repository evidence) | `http://localhost:9088` | URL the web runtime connects to. Unset means no Landing Zone MCP tools are registered. |
| `LANDING_ZONE_IAC_MCP_TRANSPORT` | No | `http` | Transport mode: `http` or `stdio`. |
| `LANDING_ZONE_IAC_MCP_PORT` | No | `9088` | HTTP listener port. |
| `LANDING_ZONE_IAC_MCP_HOST` | No | `0.0.0.0` | Bind host. Restrict at the deployment network boundary. |
| `LANDING_ZONE_IAC_MCP_PATH` | No | `/mcp` | HTTP MCP path. |
| `GITLAB_BASE_URL` | No | `https://gitlab.com` | GitLab REST base URL used by this MCP. |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | Conditional | -- | Read credential. Give it only the access needed to read approved Landing Zone repositories. |
| `LANDING_ZONE_IAC_GITLAB_TIMEOUT_MS` | No | `30000` | Per-request GitLab deadline. |
| `LANDING_ZONE_IAC_MAX_RESPONSE_BYTES` | No | `200000` | Response cap; accepted range 1,024 through 2,000,000 bytes. |
| `LANDING_ZONE_WRITE_ENABLED` | No | `false` | Registers governed branch/commit/open-MR tools only when the complete policy below validates. |
| `LANDING_ZONE_GITLAB_WRITE_TOKEN` | Required when writes enabled | -- | Dedicated write credential. It must differ from the read credential. |
| `LANDING_ZONE_WRITE_REVIEW_SECRET` | Required when writes enabled | -- | Independent secret, at least 32 bytes, used to sign short-lived review capabilities. It must differ from the write token. |
| `LANDING_ZONE_WRITE_PROJECTS` | Required when writes enabled | -- | Comma-separated exact GitLab project paths that may receive a proposal. |
| `LANDING_ZONE_WRITE_PATHS` | Required when writes enabled | -- | JSON object mapping every writable project to one or more repository-relative allowed path prefixes. Absolute and parent-traversal paths are rejected. |
| `LANDING_ZONE_WRITE_BACKEND_PROJECTS` | No | -- | Comma-separated subset of writable projects with separately approved backend changes. Empty denies backend changes. |

`AWS_MCP_URL` does not currently enable Landing Zone live-state evidence. The production graph is constructed with Landing Zone AWS reads disabled, and the Terraform/AWS documentation collector seams are also not yet connected. See [the architecture](../architecture/landing-zone-terraform-agent.md) and [operations runbook](../operations/landing-zone-agent-runbook.md).

## Elastic IaC agent-side config-edit JSON path templates

The config-edit proposers resolve repo file paths from templates. `${cluster}`, `${policy}`, etc. are literal placeholders the agent substitutes (config, not JS template literals). All optional with sensible repo-relative defaults; override only if the repo layout changes.

| Variable | Used by |
|----------|---------|
| `ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE` | version-upgrade, tier-resize, topology-edit (deployment JSON) |
| `ELASTIC_IAC_ILM_POLICY_TEMPLATE` / `ELASTIC_IAC_ILM_TEMPLATE_POLICY` | ilm-rollout (policy file path + canonical template fallback) |
| `ELASTIC_IAC_SLO_TEMPLATE` | slo-edit |
| `ELASTIC_IAC_ALERTING_TEMPLATE` | alerting-edit |
| `ELASTIC_IAC_DATAVIEW_TEMPLATE` | dataview-edit |
| `ELASTIC_IAC_CLUSTER_DEFAULT_TEMPLATE` | cluster-default-edit |
| `ELASTIC_IAC_SPACE_TEMPLATE` | space-edit |
| `ELASTIC_IAC_SECURITY_TEMPLATE` | security-edit |
| `ELASTIC_IAC_FLEET_INTEGRATIONS_TEMPLATE` | fleet-integration |
| `ELASTIC_IAC_DASHBOARD_TEMPLATE` | dashboard-edit |
| `ELASTIC_IAC_CLUSTER_SETTINGS_TEMPLATE` | cluster-settings-edit (default `environments/${cluster}/cluster-settings/settings.json`) |
| `ELASTIC_IAC_INDEX_TEMPLATE_TEMPLATE` | index-template-create (default `environments/${cluster}/index-templates/${template}.json`) |
| `ELASTIC_IAC_INGEST_PIPELINE_TEMPLATE` | ingest-pipeline-create / ingest-pipeline-edit (default `environments/${cluster}/ingest-pipelines/${name}.json`) |
| `ELASTIC_IAC_STACK_CONFIG_TEMPLATE` / `ELASTIC_IAC_RECONCILE_MARKER_TEMPLATE` | drift sub-flow |
| `IAC_PIPELINE_POLL_BUDGET_MS` / `IAC_PIPELINE_POLL_BUDGET_MS_EXTENDED` / `IAC_PIPELINE_POLL_INTERVAL_MS` | `watchPipeline` MR poll loop only (defaults `90000` / `90000` / `10000`; SIO-989 capped the extended budget at 90s — a cold-runner pipeline >90s returns at `running` and the user re-checks) |
| `IAC_FLEET_APPLY_TICKER_BUDGET_MS` / `IAC_FLEET_APPLY_TICKER_INTERVAL_MS` | `applyFleetUpgrade` live-ticker poll loop (agent-side `gitlab_get_pipeline` polling before the blocking result fetch; defaults `40000` / `10000`. SIO-1307: split from `IAC_PIPELINE_POLL_BUDGET_MS` so this loop tunes independently of the unrelated MR-watch flow) |
| `ELASTIC_IAC_FLEET_APPLY_POLL_BUDGET_MS` | MCP `gitlab_get_fleet_upgrade_apply_result` poll-to-terminal loop (default `30000`, polls at the shared `ELASTIC_IAC_DRIFT_POLL_INTERVAL_MS` cadence; SIO-1307 cut from `120000` — combined with the `IAC_FLEET_APPLY_TICKER_BUDGET_MS` ticker above, worst-case resume-turn latency for a still-running apply dropped from ~210s to ~70s) |
| `ELASTIC_IAC_DRIFT_POLL_BUDGET_MS` / `ELASTIC_IAC_DRIFT_POLL_INTERVAL_MS` | MCP drift-check / synthetics poll-to-terminal loop (defaults `90000` / `5000`; SIO-989 dropped the budget 300s -> 90s — also feeds the agent's `elastic-iac-mcp` tool timeout = budget + 30s margin) |
| `ELASTIC_IAC_DRIFT_CONCURRENCY`, `ELASTIC_IAC_REPORT_STACKS_EXCLUDE`, `ELASTIC_IAC_CONFIG_DEPLOYMENT_STACKS`, `ELASTIC_IAC_CONFIG_ILM_STACKS` | drift / report stack scoping |
| `ELASTIC_IAC_NESTED_STACKS_EXCLUDE` | SIO-1315: comma list of stacks opted out of the nested-layout families (security, fleet-integrations, agent-policies). An excluded stack falls back to the report-sourced default. Empty by default. |
| `ELASTIC_IAC_EDIT_DRIFT_CHECK` | SIO-1310: kill-switch for the per-request scoped drift check run before a config edit. Default on; `false` restores the repo-only behaviour with no CI trigger. |
| `IAC_APPLY_NOT_STARTED_SETTLE_DAYS` | SIO-1074: days a merged change whose apply job never started must age before the reconcile sweep settles it as applied out-of-band (default `7`). |
| `ELASTIC_IAC_GITLAB_TIMEOUT_MS` | Deadline on every GitLab call the elastic-iac MCP makes (default `30000`). A hung call would otherwise block the server's single event loop and get it marked down. Invalid values fall back to the default and are logged. |

### CI contract (job names, trigger variables, artifacts)

The imperative sub-flows trigger jobs in the IaC repository's pipeline and read their artifacts. These names are the contract with that repository's CI; override one only if the repository renames it.

| Variable | Default | Used by |
|----------|---------|---------|
| `ELASTIC_IAC_DRIFT_JOB_NAME` | `drift-check-on-demand` | drift |
| `ELASTIC_IAC_DRIFT_PIPELINE_REF` | `main` | drift; also the fallback ref for the two below |
| `ELASTIC_IAC_SYNTH_DRIFT_JOB_NAME` / `ELASTIC_IAC_SYNTH_PUSH_JOB_NAME` | `drift-check-synthetics-on-demand` / `synthetics-push-on-demand` | synthetics-drift |
| `ELASTIC_IAC_SYNTH_DRIFT_VAR` / `ELASTIC_IAC_SYNTH_PUSH_VAR` | `SYNTH_DRIFT_CHECK` / `SYNTH_PUSH` | synthetics-drift trigger variables |
| `ELASTIC_IAC_SYNTH_DRIFT_ARTIFACT` | `synthetics-drift-report.json` | synthetics-drift report |
| `ELASTIC_IAC_SYNTH_PIPELINE_REF` | `ELASTIC_IAC_DRIFT_PIPELINE_REF`, else `main` | synthetics-drift |
| `ELASTIC_IAC_FLEET_PREVIEW_JOB_NAME` / `ELASTIC_IAC_FLEET_APPLY_JOB_NAME` | `fleet-upgrade-preview-on-demand` / `fleet-upgrade-apply-on-demand` | fleet-upgrade |
| `ELASTIC_IAC_FLEET_PREVIEW_VAR` / `ELASTIC_IAC_FLEET_APPLY_VAR` | `FLEET_UPGRADE_PREVIEW` / `FLEET_UPGRADE_APPLY` | fleet-upgrade trigger variables |
| `ELASTIC_IAC_FLEET_REPORT_ARTIFACT` | `fleet-upgrade-report.json` | fleet-upgrade report |
| `ELASTIC_IAC_FLEET_PIPELINE_REF` | `ELASTIC_IAC_DRIFT_PIPELINE_REF`, else `main` | fleet-upgrade |

---

## LangSmith

LangSmith provides tracing, feedback collection, and evaluation for the agent pipeline and individual MCP servers.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANGSMITH_API_KEY` | Yes (for tracing) | -- | LangSmith API key from smith.langchain.com |
| `LANGSMITH_PROJECT` | No | `devops-incident-analyzer` | LangSmith project name for agent traces |
| `LANGSMITH_TRACING` | No | `true` | Enable or disable LangSmith tracing globally |
| `LANGSMITH_ENDPOINT` | No | `https://api.smith.langchain.com` | LangSmith API endpoint; override for a self-hosted or regional instance |
| `LANGCHAIN_TRACING_V2`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_ENDPOINT` | No | -- | Legacy names. `LANGCHAIN_TRACING_V2=true` and `LANGCHAIN_API_KEY` are accepted as fallbacks for their `LANGSMITH_*` equivalents; the tracing initializer also writes all four from the `LANGSMITH_*` values so LangChain libraries that still read the old names agree. Prefer setting only `LANGSMITH_*`. |
| `ELASTIC_LANGSMITH_PROJECT` | No | `elastic-mcp-server` | LangSmith project for Elasticsearch MCP server traces |
| `KAFKA_LANGSMITH_PROJECT` | No | `kafka-mcp-server` | LangSmith project for Kafka MCP server traces |
| `COUCHBASE_LANGSMITH_PROJECT` | No | `couchbase-mcp-server` | LangSmith project for Couchbase MCP server traces |
| `KONNECT_LANGSMITH_PROJECT` | No | `konnect-mcp-server` | LangSmith project for Kong Konnect MCP server traces |
| `GITLAB_LANGSMITH_PROJECT` | No | `gitlab-mcp-server` | LangSmith project for GitLab MCP server traces |
| `ATLASSIAN_LANGSMITH_PROJECT` | No | `atlassian-mcp-server` | LangSmith project for Atlassian MCP server traces |
| `AWS_LANGSMITH_PROJECT` | No | `aws-mcp-server` | LangSmith project for AWS MCP server traces |
| `OPENAI_API_KEY` | Yes (for `eval:agent` only) | -- | gpt-4o-mini API key used by the `response_quality` LLM judge in the LangSmith eval pipeline (`packages/agent/src/eval/`). Not required for normal agent operation; only needed when running `bun run eval:agent`./682. |

Each MCP server writes traces to its own LangSmith project. This allows per-server dashboards while the main agent project captures the orchestration layer. Set `LANGSMITH_TRACING=false` to disable all tracing (useful for local development without a LangSmith account).

---

## Elasticsearch MCP Server

The Elasticsearch MCP server supports multi-deployment configuration, allowing a single server instance to query multiple Elasticsearch clusters.

### Multi-Deployment Configuration

Deployments are defined by a comma-separated list of deployment IDs. Each deployment ID becomes a prefix for its connection variables. The env-key transform is: uppercase, hyphens replaced with underscores. So `eu-cld` becomes the prefix `ELASTIC_EU_CLD_`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_DEPLOYMENTS` | Yes | -- | Comma-separated deployment IDs (e.g., `eu-cld,us-cld`) |
| `ELASTIC_DEFAULT_DEPLOYMENT` | No | First ID in `ELASTIC_DEPLOYMENTS` | Deployment used when a tool call omits the `deployment` arg and no `x-elastic-deployment` HTTP header is present. Must match an ID in `ELASTIC_DEPLOYMENTS`. |

For each deployment ID (referred to as `{ID}` below), provide one of two authentication methods:

### Per-Deployment Connection Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_{ID}_URL` | Yes | -- | Elasticsearch cluster URL including port |
| `ELASTIC_{ID}_API_KEY` | Conditional | -- | API key authentication (preferred) |
| `ELASTIC_{ID}_USERNAME` | Conditional | -- | Basic auth username (alternative to API key) |
| `ELASTIC_{ID}_PASSWORD` | Conditional | -- | Basic auth password (paired with username) |
| `ELASTIC_{ID}_CA_CERT` | No | -- | TLS CA cert (PEM string or file path) for clusters with a private CA |

Each deployment requires either `ELASTIC_{ID}_API_KEY` or both `ELASTIC_{ID}_USERNAME` and `ELASTIC_{ID}_PASSWORD`. API key authentication is preferred for production deployments.

Example using the canonical 10-deployment list from `.env.example`:

```bash
ELASTIC_DEPLOYMENTS=eu-cld,us-cld,eu-b2b,ap-cld,gl-cld-reporting,eu-onboarding,eu-cld-monitor,ap-cld-monitor,gl-testing,us-cld-monitor
ELASTIC_DEFAULT_DEPLOYMENT=eu-cld

ELASTIC_EU_CLD_URL=https://eu-cld.es.example.com:9243
ELASTIC_EU_CLD_API_KEY=your-eu-cld-api-key
ELASTIC_US_CLD_URL=https://us-cld.es.example.com:9243
ELASTIC_US_CLD_API_KEY=your-us-cld-api-key
# ... one URL + API_KEY pair per deployment ID
```

If `ELASTIC_DEPLOYMENTS` is unset, the server falls back to legacy single-deployment mode using `ES_URL`, `ES_API_KEY`, `ES_USERNAME`, `ES_PASSWORD`, `ES_CA_CERT`.

### Per-Call Search Timeout

The `elasticsearch_search` tool uses a separate per-call timeout from the shared client `requestTimeout`. Defaults are conservative for heavy aggregations on multi-billion-doc indices. See [Troubleshooting > Elasticsearch Search Times Out at ~30 Seconds](../operations/troubleshooting.md#elasticsearch-search-times-out-at-30-seconds) for the failure mode this addresses.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_SEARCH_REQUEST_TIMEOUT_MS` | No | `60000` | Per-call transport timeout for `elasticsearch_search`, in ms. Independent of the shared client `requestTimeout` (also raised — schema cap is now 120 000 ms, was 60 000 before). |
| `ELASTIC_SEARCH_MAX_RETRIES` | No | `0` | Per-call retry count for `elasticsearch_search`. Default `0` so transient transport errors fail fast rather than stacking 30 s timeouts. |
| `ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS` | No | `8000` | SIO-690: per-call timeout for discovery and metadata reads (cat indices, cluster health, get mappings). These should fail fast so the model can route around them instead of waiting on the shared client's 30 s timeout with retries. |
| `ELASTIC_DISCOVERY_MAX_RETRIES` | No | `0` | SIO-690: per-call retry count for the same discovery reads. |

### Read-only mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `READ_ONLY_MODE` | No | `false` | `true`/`1` restricts destructive operations on the Elasticsearch MCP server. |
| `READ_ONLY_STRICT_MODE` | No | `true` | `true` blocks a restricted operation; `false` lets it through with a warning. Only meaningful with `READ_ONLY_MODE` on. |

### Elastic Cloud Deployment + Billing API

These variables enable the 16 organization-scoped tools (10 `elasticsearch_cloud_*` and 6 `elasticsearch_billing_*`) that talk to `https://api.elastic-cloud.com`. They are **independent** of the per-deployment cluster API keys above and use a separate Elastic Cloud organization API key. When `EC_API_KEY` is unset, those 16 tools simply do not register and the server boots normally for self-hosted users.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EC_API_KEY` | No | -- | Org-scoped Elastic Cloud API key. Generated at Elastic Cloud console -> User profile -> API keys. Gates registration of cloud + billing tools. |
| `EC_API_ENDPOINT` | No | `https://api.elastic-cloud.com` | Override only for non-public Elastic Cloud regions. |
| `EC_DEFAULT_ORG_ID` | No | -- | Fallback `org_id` for billing tools when no `org_id` arg is passed. Without it, every billing tool call must include `org_id` explicitly. |
| `EC_REQUEST_TIMEOUT` | No | `30000` | Request timeout in ms. |
| `EC_MAX_RETRIES` | No | `3` | Retry count on 5xx responses with exponential backoff. |

---

## Kafka MCP Server

The Kafka MCP server uses a provider system to support multiple Kafka deployment types and feature gates to control write access.

### Provider Selection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_PROVIDER` | No | `local` | Kafka provider: `local`, `msk`, or `confluent` |
| `KAFKA_BROKERS` | Yes | `localhost:9092` | Comma-separated list of Kafka broker addresses |

The provider determines authentication and connection behavior:

- `local` -- Plain connection to local brokers, no authentication
- `msk` -- AWS MSK; auth is selected via `MSK_AUTH_MODE` (see below). Defaults to IAM.
- `confluent` -- Confluent Cloud with API key/secret authentication

### MSK Auth Mode

`MSK_AUTH_MODE` selects how the Kafka MCP server connects to an MSK cluster. It applies only when `KAFKA_PROVIDER=msk`.

| Value | Behaviour | Bootstrap broker port (typical) |
|-------|-----------|---------------------------------|
| `none` (default) | Unauthenticated PLAINTEXT. Uses `BootstrapBrokerString`. The cluster must have been created with `Unauthenticated` enabled. | `9092` |
| `tls` | TLS-only, no SASL. Uses `BootstrapBrokerStringTls`. | `9094` |
| `iam` | SASL/OAUTHBEARER with IAM-signed token + TLS. Uses `BootstrapBrokerStringSaslIam`. Set explicitly to opt in. | `9098` |

The default is `none` because the project's MSK cluster is provisioned without authentication. Existing IAM-authenticated deployments must set `MSK_AUTH_MODE=iam` explicitly. The resolved auth mode is logged at startup ("Creating Kafka provider"), so the connection posture is always visible from the logs.

When `MSK_AUTH_MODE=none`, `kafka-cluster:*` IAM permissions are not required by the runtime. See [`docs/deployment/agentcore-msk-no-auth.md`](../deployment/agentcore-msk-no-auth.md) for the full no-auth deployment path.

### MSK Connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MSK_BOOTSTRAP_BROKERS` | No | -- | Comma-separated bootstrap brokers. If set, skips runtime-side `GetBootstrapBrokers`. |
| `MSK_CLUSTER_ARN` | No | -- | MSK cluster ARN. Used for broker discovery (when `MSK_BOOTSTRAP_BROKERS` is unset) and for `kafka_get_cluster_info`. |
| `MSK_AUTH_MODE` | No | `iam` | See above. |
| `AWS_REGION` | No | `eu-west-1` | AWS region for MSK and IAM token signing. |

Either `MSK_BOOTSTRAP_BROKERS` or `MSK_CLUSTER_ARN` must be set when `KAFKA_PROVIDER=msk`.

### Feature Gates

Feature gates control which tool categories are available. All default to `false` for safety. After, `KAFKA_ALLOW_WRITES` and `KAFKA_ALLOW_DESTRUCTIVE` gate not just core Kafka writes but also Confluent Connect, Schema Registry, and REST Proxy write/destructive tools registered through the same MCP server.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_ALLOW_WRITES` | No | `false` | Enable write tools across kafka core (produce, create topic, alter config), Connect (pause/resume/restart), Schema Registry (`sr_register_schema`, `sr_check_compatibility`, `sr_set_compatibility`), and REST Proxy (produce, consumer lifecycle) |
| `KAFKA_ALLOW_DESTRUCTIVE` | No | `false` | Enable destructive tools across kafka core (delete topic, reset offsets), Connect (restart task, delete connector), and Schema Registry (soft/hard delete subject + version) |
| `SCHEMA_REGISTRY_ENABLED` | No | `false` | Register Schema Registry tools (8 read tools by default; `KAFKA_ALLOW_WRITES`/`KAFKA_ALLOW_DESTRUCTIVE` add the 7 new `sr_*` write/destructive tools) |
| `KSQL_ENABLED` | No | `false` | Enable ksqlDB query tools |
| `CONNECT_ENABLED` | No | `false` | Register Kafka Connect tools (4 read tools by default; gates above add 5 write/destructive tools) |

Setting `KAFKA_ALLOW_DESTRUCTIVE=true` requires `KAFKA_ALLOW_WRITES=true` as well. The config loader enforces this constraint during validation.

Tool count grows with the gating and which Confluent components are enabled. Bare `KAFKA_PROVIDER=msk` registers 15 tools; full Confluent stack (`SCHEMA_REGISTRY_ENABLED + KSQL_ENABLED + CONNECT_ENABLED + RESTPROXY_ENABLED + KAFKA_ALLOW_WRITES + KAFKA_ALLOW_DESTRUCTIVE`) registers 55. See `packages/mcp-server-kafka/tests/tools/full-stack-tools.test.ts` for the asserted-correct formula.

### Tool Timeouts

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KAFKA_TOOL_TIMEOUT_MS` | No | `30000` | **Dual role.** (1) Server-side: per-tool admin RPC timeout in ms, mapped to the `@platformatic/kafka` library option `timeout` (the library's own default is 5 000 ms, which trips on first-call MSK warmup). Provider-supplied timeouts still win — for example, the MSK provider's 60 s override is preserved on top of this value. The pre- config option `requestTimeout` was a no-op (the underlying schema is `additionalProperties: false`); it has been renamed to `timeout` to match the library and is now correctly threaded through. (2) SIO-1115 bridge-side: the agent's `defaultToolTimeout` for `kafka-mcp` (was the 60 s adapter default). Intentionally the same knob so the client's per-call abort tracks the server's own admin-RPC budget. Note the two align only at the *default*: a provider override that raises the server-side timeout (e.g. the MSK provider's 60 s) is not mirrored on the bridge side, so set `KAFKA_TOOL_TIMEOUT_MS` explicitly if you need the client abort to match a raised server budget. |

### Confluent Connect

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONNECT_ENABLED` | No | `false` | Register the 4 Connect read tools (cluster info, list connectors, get connector status, get task status) |
| `CONNECT_URL` | Conditional | -- | Required when `CONNECT_ENABLED=true`. Connect REST API URL (e.g., `http://internal-confluent-prd-internal-alb-...:8083` for self-hosted). |
| `CONNECT_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth Connect deployments. Set for Confluent Cloud. |
| `CONNECT_API_SECRET` | No | -- | Basic auth secret paired with `CONNECT_API_KEY`. |

### Confluent REST Proxy

REST Proxy v2 integration provides HTTP-fronted produce/consume in addition to the broker-level kafka tools. Useful when AgentCore can reach an HTTP endpoint but not the broker port directly. PVH's REST Proxy lives on a public ALB (separate from the internal ALB used by ksqlDB / Schema Registry / Connect).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RESTPROXY_ENABLED` | No | `false` | Register REST Proxy tools (3 metadata reads always-on; 6 writes additionally gated by `KAFKA_ALLOW_WRITES`) |
| `RESTPROXY_URL` | Conditional | `http://localhost:8082` | Required when `RESTPROXY_ENABLED=true`. REST Proxy v2 base URL. |
| `RESTPROXY_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth deployments. Set for Confluent Cloud. |
| `RESTPROXY_API_SECRET` | No | -- | Basic auth secret paired with `RESTPROXY_API_KEY`. |

The 3 metadata reads (`restproxy_list_topics`, `restproxy_get_topic`, `restproxy_get_partitions`) register whenever `RESTPROXY_ENABLED=true`. The 6 writes (`restproxy_produce`, `restproxy_create_consumer`, `restproxy_subscribe`, `restproxy_consume`, `restproxy_commit_offsets`, `restproxy_delete_consumer`) require `KAFKA_ALLOW_WRITES=true` in addition.

### Schema Registry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SCHEMA_REGISTRY_ENABLED` | No | `false` | Register Schema Registry tools (8 reads always-on; 7 writes/destructives additionally gated below) |
| `SCHEMA_REGISTRY_URL` | Conditional | `http://localhost:8081` | Required when `SCHEMA_REGISTRY_ENABLED=true`. SR base URL. |
| `SCHEMA_REGISTRY_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth deployments. |
| `SCHEMA_REGISTRY_API_SECRET` | No | -- | Basic auth secret paired with `SCHEMA_REGISTRY_API_KEY`. |

### ksqlDB

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KSQL_ENABLED` | No | `false` | Register ksqlDB tools (7 tools) |
| `KSQL_ENDPOINT` | Conditional | `http://localhost:8088` | Required when `KSQL_ENABLED=true`. ksqlDB REST endpoint. |
| `KSQL_API_KEY` | No | -- | Basic auth key. Leave empty for self-hosted no-auth deployments. |
| `KSQL_API_SECRET` | No | -- | Basic auth secret paired with `KSQL_API_KEY`. |

---

## Couchbase Capella MCP Server

Connection parameters for a single Couchbase Capella cluster.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COUCHBASE_URL` | Yes | `couchbase://localhost` | Connection string for the cluster, for Capella `couchbases://cb.xxxxxxxx.cloud.couchbase.com` |
| `COUCHBASE_USERNAME` | Yes | `Administrator` | Database user with read access |
| `COUCHBASE_PASSWORD` | Yes | `password` | Database user password |
| `COUCHBASE_BUCKET` | No | `default` | Default bucket name for queries (can be specified per query) |
| `COUCHBASE_SCOPE` | No | `_default` | Default scope |
| `COUCHBASE_CONNECTION_TIMEOUT` | No | `5000` | Connection timeout in ms |
| `READ_ONLY_QUERY_MODE` | No | `true` | SIO-1109/1813/1822: read-only gate. When on, the query tools reject a statement that modifies data or structure, and KV document writes are refused too. The gate reads a statement's keywords the way the query service does, so a write cannot be smuggled past it by quoting or escaping. Parsed as a kill-switch (SIO-1898): only an explicit `false` or `0` (any case) turns it off. Unset, `true`, `1`, an empty value and anything unrecognised keep it on, and an unrecognised value is logged as a warning. Set `false` only for a deployment that is meant to write. See [MCP Integration](../architecture/mcp-integration.md). |

The variable names are the ones the server reads (`packages/mcp-server-couchbase/src/config/envMapping.ts`). The "Required" column means required for a real cluster: the code defaults target a local single-node install.

The MCP server connects using the Couchbase Node.js SDK. For Capella the connection string uses the cluster endpoint shown in the Capella console.

---

## Kong Konnect MCP Server

Authentication and region configuration for the Kong Konnect API gateway management platform.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KONNECT_ACCESS_TOKEN` | Yes | -- | Personal or system access token from Konnect |
| `KONNECT_REGION` | No | `eu` | Konnect API region: `us`, `eu`, `au`, `me`, or `in` |

The region determines the Konnect API base URL. Ensure the access token has sufficient permissions for the control planes and services you need to query.

| Region Code | API Base URL |
|-------------|-------------|
| `us` | `https://us.api.konghq.com` |
| `eu` | `https://eu.api.konghq.com` |
| `au` | `https://au.api.konghq.com` |
| `me` | `https://me.api.konghq.com` |
| `in` | `https://in.api.konghq.com` |

---

## GitLab MCP Server

Authentication and connection configuration for the GitLab MCP server, which proxies requests to GitLab's native MCP endpoint and provides custom code analysis tools.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITLAB_INSTANCE_URL` | No | `https://gitlab.com` | GitLab instance base URL (supports self-hosted) |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | Yes | -- | Personal access token with `api` scope |
| `GITLAB_TIMEOUT` | No | `30000` | API request timeout in milliseconds |
| `GITLAB_RETRY_ATTEMPTS` | No | `3` | Number of retry attempts for failed requests |
| `GITLAB_RETRY_DELAY` | No | `1000` | Base delay between retry attempts in milliseconds |

The personal access token requires the `api` scope for full MCP tool access. For self-hosted GitLab instances, set `GITLAB_INSTANCE_URL` to your instance URL (e.g., `https://gitlab.company.com`).

---

## Atlassian MCP Server

OAuth 2.0 configuration for the Atlassian MCP server, which proxies Jira and Confluence tools from Atlassian's hosted MCP endpoint and adds incident-project filtering.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATLASSIAN_MCP_URL` | Yes | `http://localhost:9085` | URL the agent uses to reach the local Atlassian MCP server (matches every other datasource's `*_MCP_URL` convention) |
| `ATLASSIAN_UPSTREAM_MCP_URL` | No | `https://mcp.atlassian.com/v1/mcp` | Upstream Atlassian Cloud Rovo endpoint the local proxy forwards to. Consumed by `mcp-server-atlassian` only. |
| `ATLASSIAN_MCP_PORT` | No | `9085` | Local HTTP port the server listens on |
| `ATLASSIAN_SITE_NAME` | Yes | -- | Atlassian Cloud site identifier (e.g., `your-company`) |
| `ATLASSIAN_OAUTH_CALLBACK_PORT` | No | `9185` | Port for the OAuth 2.0 redirect handler |
| `ATLASSIAN_READ_ONLY` | No | `true` | Disable all write operations (issue create, comment, transition) |
| `ATLASSIAN_INCIDENT_PROJECTS` | No | -- (all projects) | SIO-1184: OPTIONAL comma-separated project keys narrowing `findLinkedIncidents`/`getIncidentHistory`. Empty/unset searches ALL visible projects (`project is not EMPTY`). Configured keys are validated against the live site on first use; nonexistent keys are dropped (wildcard when none remain) and surfaced via a `configWarning` in the tool output -- Jira silently returns empty for nonexistent projects, so a dead allowlist is otherwise invisible. |
| `ATLASSIAN_TIMEOUT` | No | `30000` | SIO-1111: per-call timeout in ms for each upstream Rovo request (was declared but unused before; the SDK's 60s default applied). The clock starts when the request is sent, after any SIO-1097 queue wait. |
| `ATLASSIAN_READINESS_FRESHNESS_WINDOW_MS` | No | `90000` | SIO-1111: `/ready` reports healthy without a live upstream probe if any upstream call succeeded within this window. Prevents the health poll's cloudId probe from queueing behind fan-out tool calls on the serialized transport (false "upstream degraded"). |

The OAuth flow opens a local callback on `ATLASSIAN_OAUTH_CALLBACK_PORT` to receive the auth code, then exchanges it with Atlassian for an access token. `ATLASSIAN_READ_ONLY=true` is the default and is enforced by the incident analyzer's compliance layer.

---

## Agent Configuration

Settings for the LangGraph supervisor agent, including model selection and state persistence.


> **Removed (SIO-1226):** `AGENT_LLM_MODEL`, `AGENT_LLM_HAIKU_MODEL` and `AGENT_LLM_REGION` were
> documented here but read by **no source file**, and the first two advertised
> `claude-sonnet-4-6` long after SIO-1213 moved the orchestrator to Sonnet 5 — so this table was
> actively misleading about which model runs. Models are chosen in `agents/*/agent.yaml`
> (`model:`) and resolved through `MODEL_REGISTRY`; the Bedrock region comes from `AWS_REGION`
> (default `eu-central-1`). See [Model Upgrade Checklist](../development/model-upgrade-checklist.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_LLM_TIER_<ROLE>` | No | per-role default | SIO-1226: flips a role in `TIERABLE_ROLES` between `light` (Haiku) and `standard` (the manifest model) with no code change, e.g. `AGENT_LLM_TIER_FOLLOW_UP=light`. **Caveat:** the light tier borrows the elastic-agent sub-agent manifest, which declares no `fallback:`, so a light-tier role has **no model fallback at all**. |
| `AGENT_LLM_TIMEOUT_<ROLE>_MS` | No | per-role default | SIO-1226: per-role LLM wall-clock deadline. `0` disables that role's timer; `aggregator`, `subAgent` and `responder` are `0` by design and rely solely on the graph-wide abort signal. |
| `AGENT_PROMPT_CACHE_ENABLED` | No | `true` | SIO-1226: Bedrock prompt caching for the sub-agent base prompt and the aggregator. SIO-1773: the same flag also places two rolling cache points on a sub-agent's tool-result history (the newest message and the one that closed the previous round), so each ReAct turn reads the earlier turns from cache instead of paying for them again. Set `false` to kill it on a Bedrock `ValidationException` or a cost regression. Caches are **per model** with a ~5-minute TTL, so any model change invalidates every cached prefix and the sub-agent's up-to-40-iteration amortisation re-primes cold. |
| `AGGREGATION_MIN_RUNWAY_MS` | No | `30000` | SIO-1226: minimum wall-clock runway `aggregate()` requires before starting its LLM call. Below it, the node emits a deterministic degraded summary instead of being hard-aborted mid-generation with zero output (SIO-1220). |
| `AGENT_CHECKPOINTER_TYPE` | No | `memory` | State persistence backend: `memory` or `sqlite` |
| `GRAPH_TIMEOUT_MS` | No | `900000` | Graph-level abort signal in ms. Overrides the `runtime.timeout` value in `agents/incident-analyzer/agent.yaml` when set. Default `900000` (15 min, SIO-1110; was 12 min) fits pre-fan-out (~30 s) + a 360 s fan-out + a 360 s alignment retry + the 120 s aggregation reserve. |
| `SUB_AGENT_TIMEOUT_MS` | No | `360000` | Per-sub-agent `AbortSignal.timeout` in ms. Replaces the previously hardcoded 300 000. Caps any single sub-agent ReAct loop. Tightening this is useful when you want the alignment retry to start sooner; loosening it helps deep-discovery agents that legitimately need more than 6 minutes. |
| `SUB_AGENT_RETRY_TIMEOUT_MS` | No | half of `SUB_AGENT_TIMEOUT_MS` (`180000`) | SIO-1232: budget for an **alignment-retry** sub-agent run. A retry restarts from scratch with the same prompt, so giving it the full first-attempt budget lets one datasource consume the entire post-fan-out runway (900 s − 360 s − 120 s reserve = 420 s of headroom, while `hasRetryBudget` only requires 180 s). Tracks `SUB_AGENT_TIMEOUT_MS` unless set explicitly. Note a timed-out sub-agent is no longer retried at all — this bounds retries triggered by genuine transient *tool* errors. |
| `SUBAGENT_RECURSION_LIMIT_<DATASOURCE>` | No | per-datasource (see below) | SIO-1232: LangGraph `recursionLimit` (super-steps) for one sub-agent, e.g. `SUBAGENT_RECURSION_LIMIT_GITLAB`. Defaults: elastic 40, aws 40, couchbase 30, gitlab/kafka/konnect 24, atlassian 20, unknown 30. Previously only elastic had a limit and the other five ran on LangGraph's default 25 with no explicit budget — gitlab made 97 tool calls before the wall-clock timeout stopped it. A ReAct cycle is 2 super-steps, so `limit ≈ 2 × maxLlmTurns + 1`; the `iteration` counter in logs counts **tool calls**, not steps. Hitting the limit degrades to partial findings via `invokeSubAgentWithSalvage`, never a hard error. |
| `SUBAGENT_ELASTIC_RECURSION_LIMIT` | No | `40` | Back-compat alias for `SUBAGENT_RECURSION_LIMIT_ELASTIC`. Retained so deployed config does not silently stop taking effect; applies to elastic only. |
| `GRAPH_BUDGET_RESERVE_MS` | No | `120000` | SIO-1110: wall-clock reserve kept for aggregation + downstream nodes. Alignment skips retries and late sub-agent timers are capped so this much of the graph budget survives the fan-out phase. |
| `GRAPH_BUDGET_MIN_RETRY_MS` | No | `60000` | SIO-1110: smallest remaining window (beyond the reserve) for which an alignment retry is still dispatched. Below `reserve + minRetry` remaining, alignment proceeds with partial results instead of retrying. |
| `ATLASSIAN_TOOL_TIMEOUT_MS` | No | `120000` | SIO-1111: bridge-side tool-call timeout for atlassian-mcp. Covers upstream serialization queue wait under sub-agent fan-out (the 60s adapter default produced -32001 failures). |
| `ELASTIC_IAC_TOOL_TIMEOUT_MS` | No | `120000` | SIO-893: bridge-side tool-call timeout for elastic-iac-mcp. Defaults to `ELASTIC_IAC_DRIFT_POLL_BUDGET_MS` (90 000) + 30 000 margin so the drift-check tool's internal CI poll is the binding constraint, not the transport. |
| `RESOLVE_IDENTIFIERS_ENABLED` | No | on | SIO-1084: resolve the loose incident service to canonical per-datasource identifiers (elastic APM name, AWS log groups, kafka topics, ...) before fan-out. Default on (kill-switch); set `=false` to skip the bounded per-datasource probe round. See [Resolve Identifiers](../architecture/resolve-identifiers.md). |
| `RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS` | No | `8000` | SIO-1084: per-datasource probe timeout in ms for the `resolveIdentifiers` node. |
| `RESOLVE_IDENTIFIERS_PRESETS_ENABLED` | No | `all` | SIO-1355: which datasources resolve identifiers via the declarative preset workflow (`agents/incident-analyzer/agents/<ds>-agent/workflows/resolve-identifiers.yaml`) instead of the legacy inline probe. **List-valued**, case-insensitive: `all`/`true`/`1` (default) = every datasource; `false`/`0` = none (legacy probe everywhere); or a comma list, e.g. `couchbase,elastic`. A missing/unloadable preset falls back to the legacy probe for that datasource, so the flag can ship ahead of the YAML. See [Agent Concepts: SkillsFlow](../architecture/agent-concepts.md). |
| `SUB_AGENT_MANIFEST_MODEL_ENABLED` | No | on | SIO-1235/1404: when on (any value except `false`/`0`), each sub-agent runs the `model.preferred` declared in its own `agent.yaml` (all seven currently `claude-sonnet-4-6`). Set `=false`/`0` to ignore the manifest models and fall back to the default resolution. This is the switch that makes the SIO-1404 sonnet-4-6 restoration take effect. |
| `EVAL_SUB_AGENT_MODEL_OVERRIDE` | No | -- (unset) | SIO-1371/1379: **eval-only** A/B model swap, read at call time. Substitutes the resolved `preferred` for every sub-agent (and drops the manifest `fallback`, to isolate one model's behavior) so an eval leg can compare models without a redeploy. Unset in every non-eval environment; never set it in production. |
| `EVAL_FIXTURE_MODE` | No | `live` | SIO-1379 sound-freeze record/replay for evals. `live` (default) = hit real MCP + Bedrock; `record` = run live and append the turn's outputs + MCP tool-call audit trail to a fixture file; `replay-outputs` = re-grade frozen agent behavior from the fixture with no live systems touched (skips the MCP precheck). Used only by the eval CLIs — see [Testing](../development/testing.md). |
| `MCP_TOOL_METRICS_DB_PATH` | No | -- (unset = off) | SIO-1400: absolute path to a SQLite file for MCP tool-call usage counters (per server/tool lifetime calls + failures, with the SIO-1402 failure-class breakdown). Unset disables the feature. Several MCP server processes may append to the same file (WAL + `busy_timeout`); metrics soft-fail and never break a tool call. |
| `DECISION_METRICS_DB_PATH` | No | -- (unset = off) | SIO-1858: absolute path to a SQLite file for per-decision rows from the Jev seams (seam, outcome, latency, tokens, item counts, score range, and the rank correlation between the deterministic order and the model's). Distinct from `MCP_TOOL_METRICS_DB_PATH`, which holds lifetime per-tool counters and cannot be windowed. Unset disables it; `NODE_ENV=test` never writes. Read it with `bun scripts/decision-metrics-report.ts [db-path] [--since <ISO>] [--seam <name>]`. |
| `TYPESAFE_API_KEY` | No | -- (unset = off) | SIO-1837: API key for TypeSafe System One (Jev), the classifier used to re-rank Atlassian linked incidents. Unset self-skips every Jev seam, so the deterministic path runs unchanged. Requires egress to `api.typesafe.ai`; ticket summaries and description excerpts leave the account (PII-redacted first), so review the DPA before enabling in an environment that handles customer data. |
| `MONITOR_ACTIONABILITY_ENABLED` | No | `true` | SIO-1838: kill-switch for the Jev actionability gate in the pi-coms monitor. Defaults ON: the gate judges each warn finding, journals its verdict (`actionability_verdict` rows), and -- unless `MONITOR_ACTIONABILITY_ENFORCING=false` -- holds back the ones it is confident about, so a held finding never reaches an agent investigation. Self-skips when `TYPESAFE_API_KEY` is unset. If ANY request in a cycle's batch fails, the whole round is void and every finding is investigated as before. Set `false`/`0` to stop judging entirely. |
| `MONITOR_ACTIONABILITY_ENFORCING` | No | `true` | SIO-1838: whether the gate may hold a finding back from an agent investigation. Defaults ON, like the flag above: a gate that only observes never does its job. `false`/`0` keeps the gate judging and journaling without acting, which is the mode for reading the first days of `actionability_verdict` rows. Safety comes from the decision shape, not from observing: a `critical` finding is NEVER gated, a skip needs `routine`/`duplicate` at or above 0.85, a missing or unconfident verdict sends, and any error sends the whole batch. Each of those is mutation-checked. |
| `PI_MONITOR_REPORT_ONLY_FAMILIES` | No | -- (empty) | SIO-1883: comma list of monitor finding families whose warn findings are reported but never cost an investigation turn. Critical findings in those families are still investigated. |
| `ATLASSIAN_RERANK_ENABLED` | No | `true` | SIO-1837: kill-switch for the Jev re-rank of the Atlassian findings card. Defaults ON; `false`/`0` disables it and the card falls back to the tool's keyword ordering. Self-skips when `TYPESAFE_API_KEY` is unset, and any Jev error or the 3s deadline leaves the deterministic list untouched (`rerank: "failed"` on the findings object). `RERANK_DROP_BELOW` is still tuned from a synthetic probe -- SIO-1861 calibrates it against real envelopes; watch `bun scripts/decision-metrics-report.ts --seam atlassian-rerank` until then. |
| `ACTION_SELECTOR_ENABLED` | No | `true` | SIO-1839: kill-switch for the Jev action selection that decides which tool actions a sub-agent gets. Defaults ON. Its result is UNION-merged with the existing keyword passes (`matchActionsByKeywords`, `inferClusterHealthActions`), never a replacement, so a query the keywords already handle behaves exactly as before and the model only adds the phrasings they miss. Self-skips when `TYPESAFE_API_KEY` is unset; any failure, or an incomplete answer, falls back to the keyword passes alone. One request per sub-agent dispatch, 4s deadline. |

The agent uses two model tiers. The primary model handles complex reasoning tasks (supervision, aggregation, validation). The fast model handles classification and entity extraction where latency matters more than depth. Both models are accessed through AWS Bedrock.

The `memory` checkpointer stores state in-process (lost on restart). The `sqlite` checkpointer uses `bun:sqlite` for persistent state across restarts.

### Sub-agent context, evidence and loop control

Byte caps share one contract unless a row says otherwise: unset, empty, non-numeric or negative falls back to the default, and an explicit `0` disables the cap. The behaviour is described in [Sub-Agent Context Assembly](../architecture/sub-agent-context-assembly.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUBAGENT_TOOL_RESULT_CAP_BYTES` | No | `131072` | SIO-688: cap on each tool result as the sub-agent's model sees it. Larger results are truncated by a shape-aware strategy. Also read by the AWS MCP server config. |
| `SUBAGENT_STATE_TOOL_OUTPUT_CAP_BYTES` | No | `65536` | SIO-1043: cap on the copy of each tool output persisted into graph state (`toolOutputs[].rawJson`), separate from the model-facing cap above. |
| `SUBAGENT_CONTEXT_BUDGET_BYTES` | No | `400000` | SIO-1250: total tool-content budget across a sub-agent's whole message history; older results are elided once it is exceeded. A backstop against context overflow, not a reduction knob: a deliberately harsh 60 000 made a sub-agent lose a live result and flail. |
| `SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1260: when a sub-agent's loop is cut off (for example at its recursion limit) before it wrote a report, one non-tool model call writes it from the full pre-cap tool outputs. Every failure path returns nothing rather than turning a salvaged partial success into an error. |
| `SUBAGENT_SYNTHESIS_EVIDENCE_BYTES` | No | `48000` | Evidence budget for that synthesis pass. Unlike the caps above, `0` and negatives fall back to the default (an uncapped digest could be megabytes); use the flag above to turn the feature off. |
| `EVIDENCE_INDEX_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1688: per-run, in-memory full-text index of pre-truncation tool results and the `search_evidence` tool, so a sub-agent can retrieve what truncation or the context budget removed. Results over 8 KB are indexed (SIO-1775). Built only while the tool-result cap is active. |
| `EVIDENCE_EXEC_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1776/1775: sandboxed JavaScript over indexed evidence (`run_js_on_evidence`, and the in-call `_transform` argument), executed in QuickJS compiled to WebAssembly so model-authored code never runs in a process that holds datasource credentials. |
| `EVIDENCE_TOC_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1687: a provenance table of contents (which datasource ran which tools, how much came back, what failed) stashed per thread and prepended to the next turn's recall block. |
| `DAILYLOG_TOOL_FAILURES_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1687: adds a `<datasource>:<category>` tool-failure breadcrumb to the turn's dailylog line. Off changes what the line says, never whether it is written. |
| `AWS_ABSENCE_EARLY_EXIT_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1268: lets the AWS sub-agent stop once it has proven the focus service absent from an estate, instead of spending its step budget re-searching. |
| `AGGREGATE_RESULT_CAP_BYTES` | No | `32768` | SIO-833: per-datasource-result budget in the aggregator prompt. The effective value is the smaller of this and a fair share of the total below, never under 4096. |
| `AGGREGATE_TOTAL_CAP_BYTES` | No | `262144` | SIO-833: total budget for all results in the aggregator prompt, so an N-estate AWS fan-out stays bounded. |

### Report integrity gates

All default on and are read at call time, so flipping one needs no redeploy. Each `false`/`0` restores the behaviour that preceded the named ticket.

| Variable | Default | Description |
|----------|---------|-------------|
| `ABSENCE_JUDGE_ENABLED` | on | Model veto over the regex verdict that a report's "not found" claim contradicts the evidence. Off: the regex verdict always stands. |
| `ABSENCE_ENTITY_MATCH_ENABLED` | on (only `false` disables) | Treats an absence claim as confirmed when an enumeration-shaped result was returned and none of it mentions the entity. |
| `ABSENCE_UNVERIFIABLE_SPLIT_ENABLED` | on (only `false` disables) | SIO-1266: separates absence claims that could not be verified (every cited tool call failed) from ones the evidence contradicts. |
| `GAPS_JUDGE_ENABLED` | on | Model veto over the regex verdict on reported coverage gaps. |
| `COVERAGE_CAP_SCOPING_ENABLED` | on | SIO-1195: coverage cap reasons (degraded sub-agents, gaps, correlation shortfalls) soft-cap above the HITL gate, but only when every coverage signal is attributable to datasources provably disjoint from the root-cause evidence. Off: any cap reason yields the hard cap. |
| `INTEGRITY_CAP_TIERING_ENABLED` | on | SIO-1198: an integrity cap reason may soft-cap when its per-claim signals show the guard discharged the claim. Off: every integrity reason hard-caps. |
| `NORMALIZER_SERVICE_RECOVERY_ENABLED` | on | SIO-1233: a deterministic pass (no model call) pulls service-shaped tokens out of the raw query when `normalize` extracted no focus service. Off: an empty focus is accepted. |

### Post-loop baselines

Deterministic calls made after a sub-agent's loop, appended to its tool outputs for the topology cards. Soft-failing: a timeout or error contributes nothing and never affects the answer.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_MAP_BASELINE_ENABLED` | on | Application-map baseline (an Elasticsearch APM destination aggregation). Inert for non-elastic datasources. |
| `APP_MAP_BASELINE_LOOKBACK` | `now-1h` | Lookback for that aggregation; must match `now-<N>[m\|h\|d]`. A fixed recent window, not the incident window. |
| `APP_MAP_BASELINE_TIMEOUT_MS` | `8000` | Wall-clock budget for it. |
| `NETWORK_BASELINE_ENABLED` | on | AWS network-topology baseline. Inert for non-aws datasources. |
| `NETWORK_BASELINE_TIMEOUT_MS` | `8000` | Overall budget across all estates; calls are not started past the deadline. |

### Action tools

An action card is offered only when its provider is fully configured.

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL` | Both required for the `notify-slack` action. |
| `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_PROJECT_ID` | All three required for the Linear ticket provider of `create-ticket`. |

### Other agent settings

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_KILL_SWITCH` | off | `true`/`1` halts agent execution (`KillSwitchError`) and makes memory-pr skip every PR. |
| `PII_REDACTION_ALLOWED_DOMAINS` | -- (empty) | Comma list of email domains restored after PII redaction, for addresses already public to the user (for example ticket assignees). Other PII stays redacted. |
| `EMBEDDINGS_MAX_CHARS` | `24000` | Head-truncation cap on text sent to the embedder. `0` disables the cap. |
| `WORKSPACE_ROOT` | -- | Last-resort workspace root when the agent cannot find `agents/incident-analyzer/agent.yaml` by walking up from its own location or the working directory. |
| `EVAL_ROOT_MODEL_OVERRIDE` | -- (unset) | Eval-only twin of `EVAL_SUB_AGENT_MODEL_OVERRIDE` for the non-sub-agent roles. Logs a warning whenever it takes effect. Never set it outside an eval run. |

---

## pi-coms integration (web app and agent)

What the incident analyzer needs to reach a pi-coms hub: the action cards, the fleet pane, the `fetchFleetInbox` node and the fleet console. Every capability self-skips when no hub is configured. The hub's own variables, and the monitor's (`PI_MONITOR_*`), are documented with the package: [pi-coms docs](../../packages/pi-coms/docs/README.md). Behaviour: [pi-coms verification](../architecture/pi-coms-verification.md), [pi-fleet pane](../architecture/pi-fleet-pane.md), [fleet inbox enrichment](../architecture/fleet-inbox-enrichment.md), [pi-fleet console graph](../architecture/pi-fleet-third-graph.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_COMS_HUBS` | -- | JSON map of hubs keyed by AWS account name (SIO-1666). Each entry: `serverUrl`, `authToken`, `environment`, an explicit `estates` list, and optional `project` (default `default`) and `fallbackTarget` (default `ops`). Invalid JSON or an invalid map throws at first use. An estate no hub claims, or two hubs claim, is refused. |
| `PI_COMS_NET_SERVER_URL`, `PI_COMS_NET_AUTH_TOKEN` | -- | Legacy single-hub form, used only when `PI_COMS_HUBS` is unset. Both are required for the hub to count as configured. |
| `PI_COMS_NET_ENVIRONMENT` | `dev` | Environment of the legacy single hub, which also becomes its key. |
| `PI_COMS_NET_ESTATES` | -- (empty) | Comma list of estates the legacy single hub claims. Required for routing even with one hub. |
| `PI_COMS_NET_PROJECT` | `default` | Project of the legacy single hub. |
| `PI_COMS_FALLBACK_TARGET` | `ops` | Fallback recipient of the legacy single hub. |
| `PI_COMS_ESTATE_AGENT_MAP` | -- (empty) | JSON string map from estate to spoke agent name, for estates whose spoke is not named after the estate. Invalid input is logged and ignored. |
| `PI_COMS_VERIFY_TIMEOUT_MS` | `300000` | Budget for a `verify-with-pi` request. |
| `PI_COMS_INVESTIGATE_TIMEOUT_MS` | `900000` | Budget for an `investigate-with-pi` request. |
| `PI_HANDOFF_ENABLED` | on (kill-switch) | SIO-1651: the pi-handoff workflow. |
| `PI_COMS_INBOX_ENABLED` | on (kill-switch) | SIO-1652: the `fetchFleetInbox` node. |
| `PI_FLEET_GRAPH_ENABLED` | on (kill-switch) | SIO-1655: the fleet console agent. Also hidden from the selector without a configured hub. |
| `PI_COMS_INBOX_TIMEOUT_MS` | `5000` | Budget for the inbox read before `aggregate`. |
| `PI_COMS_INBOX_EXCLUDE_SENDERS` | `incident-analyzer-,pi-fleet-` | Comma list of sender-name prefixes dropped from the inbox digest, so the analyzer does not read its own mail back. |
| `PI_COMS_PANE_SENDER_PREFIX` | `pi-fleet` | Sender-name prefix the fleet pane registers under. On a directory-mode hub the prefix needs its own principal. |
| `PI_COMS_PANE_TOKENS` | -- (empty) | JSON map from hub key to the token the pane uses on that hub, when it differs from the hub's `authToken`. Invalid JSON throws. |
| `PI_COMS_PANE_AWAIT_MS` | `25000` | One await slice per pane request; the browser re-polls by message id. Capped in code. |
| `PI_COMS_PANE_TIMEOUT_MS` | `300000` | Total budget the pane gives one reply across slices. |

---

## Live Memory, Knowledge Graph & Skill Learning

Optional cross-session subsystems. All are off / file-backed by default; the deep-dives are [Agent Memory](../architecture/agent-memory.md) and [Knowledge Graph](../architecture/knowledge-graph.md).

### Live memory (Couchbase Agent Memory backend)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LIVE_MEMORY_ENABLED` | No | off | Master gate for the live-memory tier (recall at bootstrap, append at boundaries); writer no-ops when unset |
| `LIVE_MEMORY_BACKEND` | No | `file` | `file` (git-tracked markdown) or `agent-memory` (Couchbase Agent Memory REST) |
| `LIVE_MEMORY_RAW_PROMPTS_ENABLED` | No | off | (SIO-1038) Store each elastic-iac turn's **verbatim** user prompt as a RAW, **unredacted** durable fact (`kind: user-prompt-raw`). WARNING: bypasses PII redaction — an explicit override of the elastic-iac manifest's `pii_handling: redact`. Only effective with `LIVE_MEMORY_ENABLED=true` **and** `LIVE_MEMORY_BACKEND=agent-memory` |
| `AGENT_MEMORY_BASE_URL` | When backend=agent-memory | *(none)* | Agent Memory service URL (no default) |
| `AGENT_MEMORY_ENABLED` | No | off | Enables the Agent Memory client (used only when backend=agent-memory) |
| `AGENT_MEMORY_BEARER_TOKEN` | No | *(none)* | OIDC bearer token, only if the service runs with `OIDC_AUTH_ENABLED` |
| `AGENT_MEMORY_DAILYLOG_TTL_SECONDS` | No | *(none)* | Short TTL for dailylog breadcrumbs; omit for no decay (facts never decay) |
| `AGENT_MEMORY_SYNC_WRITES` | No | `false` | `true` -> `async_processing=false`: a written block is searchable immediately |
| `IAC_PROPOSAL_FACT_TTL_SECONDS` | No | 90d | TTL on the elastic-iac change proposal fact; it expires once reconciliation writes the terminal fact (SIO-1005) |
| `IAC_IMPORT_LOOKBACK_DAYS` | No | `30` | SIO-1525: first-run backfill window (days) for the gitlab-import sweep that imports externally-made config changes into memory + the knowledge graph. Reuses `ELASTIC_IAC_GITLAB_{TOKEN,BASE_URL,PROJECT}`; runs when (agent-memory backend OR `KNOWLEDGE_GRAPH_ENABLED`) AND the token is set. Cadence and on/off live in `schedules/iac-gitlab-import-sweep.yaml` |
| `KG_UNCURATED_RETENTION_DAYS` | No | `30` | SIO-1135: retention window (days) for the scheduled purge of uncurated `Incident` rows; a value <= 0 disables the purge. Requires `KNOWLEDGE_GRAPH_ENABLED` to run at all (a backend precondition). SIO-1358: cadence and on/off live in `schedules/kg-purge-sweep.yaml`, not an env var (`KG_PURGE_CRON_ENABLED`/`KG_PURGE_CRON_SCHEDULE` removed) |
| `SKILL_LEARNING_ENABLED` | No | on (kill-switch: `false`/`0` disables) | post-turn learning-candidate learner for every top-level agent (writes `kind:skill` candidate facts; agent-memory backend only, SIO-1015 / SIO-1889) |
| `LEARNING_INGEST_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1892: `learn:ingest` records harvested candidate drafts (fleet journal lessons, reflect items) as candidate facts after the rubric, the Jev gate and dedupe |
| `LEARNING_REVIEW_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1891: the learning review pane and `/api/agent/memory/candidates` (list / approve-with-edits / reject / supersede). Approve records the verdict and then asks memory-pr to open the promotion PR; that step is `skipped` unless the `MEMORY_PR_*` variables below are configured, and merge stays the only activation |
| `MEMORY_PR_ENABLED` | No | off (opt-in: `true`/`1`) | SIO-849/1896: lets `packages/memory-pr` open pull requests that promote approved learning into the repository. Off, every entry point returns `skipped`. Also skipped while `AGENT_KILL_SWITCH` is active |
| `MEMORY_PR_REPO` | When `MEMORY_PR_ENABLED` | -- | `owner/repo` of the GitHub repository the promotion PR is opened against |
| `MEMORY_PR_BASE` | No | `main` | Base branch of the promotion PR. A proposal whose branch equals the base is blocked, never written |
| `GITHUB_TOKEN` | When `MEMORY_PR_ENABLED` | -- | Token memory-pr uses for the GitHub API. Without it (or without `MEMORY_PR_REPO`) the PR step is `skipped` |
| `LEARNING_FEEDBACK_DEADLINE_MS` | No | `5000` | SIO-1890: hard deadline on the best-effort write that records a thumbs vote against the thread's learning candidates, so it can never hold up the feedback response |
| `CLOSURE_LEARNING_ENABLED` | No | off (opt-in: `true`/`1`) | SIO-1357: the incident-closure learning workflow. Still opt-in in code, unlike the kill-switch flags around it |
| `SKILL_OUTCOME_TRACKING_ENABLED` | No | off (opt-in: `true`/`1`) | SIO-1016: after a turn that used a promoted skill, updates the usage, success and failure counters and the recomputed confidence in that skill's `SKILL.md` frontmatter (the file, never the memory fact) |
| `LIVE_MEMORY_IMMUTABLE` | No | off (opt-in: `true`/`1`) | SIO-845: wraps dailylog appends in the shared hash chain so the file-backed audit log is tamper-evident |
| `LEARNING_JEV_GATE_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1889: Jev three-question gate (task_success, reusable_correction, evidence_supported) before the full-model judge and in the fleet harvest; self-skips without `TYPESAFE_API_KEY`, every verdict is a `learning-gate` decision-metrics row |
| `HIL_LEARNING_ENABLED` | No | on | SIO-1126: master gate for the human-in-the-loop learning lane (learn-from-ticket). Default on (kill-switch semantics — the lane only fires on an explicit `learn from TICKET-123` command, so it never triggers on normal traffic); set `=false` to disable the lane entirely. Requires `KNOWLEDGE_GRAPH_ENABLED`. See the [HIL learning lane](../architecture/agent-pipeline.md#hil-learning-lane). |

### Knowledge graph (lbug / in-process MCP server)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KNOWLEDGE_GRAPH_ENABLED` | No | off | Master gate (`true`/`1`); every graph node + `kg_*` tool no-ops when unset. SIO-954 "default on" is set via deployment config, not the code default |
| `KNOWLEDGE_GRAPH_PATH` | No | `.data/knowledge-graph` | Embedded lbug data directory (the file-locked path) |
| `KNOWLEDGE_GRAPH_MCP_HOST` | No | `127.0.0.1` | In-process KG MCP server bind host |
| `KNOWLEDGE_GRAPH_MCP_PORT` | No | `9087` | In-process KG MCP server port |
| `KNOWLEDGE_GRAPH_MCP_PATH` | No | `/mcp` | KG MCP endpoint path |
| `KG_MCP_ALLOW_CYPHER` | No | on | Register the read-only-guarded `kg_run_cypher` tool; set `false` to disable |
| `EMBEDDINGS_MODEL` | No | `amazon.titan-embed-text-v2:0` | Bedrock embedder for `Incident` similarity in `graphEnrich` |
| `KG_BINDINGS_WRITE_ENABLED` | No | on | SIO-1100 (W8): MERGE each turn's confirmed telemetry-to-service bindings into the graph. Requires `KNOWLEDGE_GRAPH_ENABLED`; produces bindings only when `resolveIdentifiers` ran. Writes are additive + soft-failing (never change the answer). Set `=false` to disable. |
| `KG_BINDINGS_READ_ENABLED` | No | on | SIO-1101 (R7): seed each sub-agent with the service's known coordinates from the graph before it probes (labelled "not probed this turn -- verify"; probes still always run). Requires `KNOWLEDGE_GRAPH_ENABLED`. Set `=false` to disable. |
| `KG_BINDINGS_READ_DATASOURCES` | No | `elastic,aws` | SIO-1101: comma list of datasources that accept graph seeds (`all` = every datasource). Widen without a code change. |
| `KG_BINDINGS_STALENESS_ENABLED` | No | on | SIO-1103: when a graph-seeded coordinate's datasource reports not-found this turn, retire the agent-discovered binding (human bindings are only flagged, never auto-invalidated). Set `=false` to disable auto-invalidation. |
| `KG_NETWORK_WRITE_ENABLED` | No | on | SIO-1204: persist the turn's network topology into the graph. Inert without `KNOWLEDGE_GRAPH_ENABLED` or when the turn produced no network topology. |
| `KG_APP_MAP_WRITE_ENABLED` | No | on | SIO-1457: persist the turn's application map into the graph. Inert without `KNOWLEDGE_GRAPH_ENABLED`, when the turn produced no application topology, or when the map carried only prior-knowledge edges. |
| `KNOWLEDGE_GRAPH_MCP_TRANSPORT` | No | `http` | `http` or `stdio`, for running the KG MCP server standalone. The web app mounts it in-process over HTTP. |

#### Scheduled topology sweep (SIO-1104 / SIO-1115 / SIO-1358)

The scheduled topology sweep collects live topology edges (elastic APM `DEPENDS_ON`, Konnect `ROUTES_TO`, Kafka `CONSUMES_FROM`, AWS ECS `RUNS_ON`) and runs the K-consecutive-miss staleness invalidation. It runs at all only when `KNOWLEDGE_GRAPH_ENABLED` is set (a backend-availability precondition, not an on/off flag).

**SIO-1358: cadence and on/off are configured in `schedules/kg-topology-sweep.yaml`, not env vars.** Edit that file's `cron:` to retune, and its `enabled:` to turn the sweep on/off. The topology sweep ships **`enabled: false`** (opt-in per deployment) and is additionally gated by `KNOWLEDGE_GRAPH_ENABLED`; the reconcile sweep (`schedules/iac-reconcile-sweep.yaml`) ships `enabled: true`, the purge sweep (`schedules/kg-purge-sweep.yaml`) ships `enabled: false`. `KG_TOPOLOGY_CRON_ENABLED` and `KG_TOPOLOGY_CRON_SCHEDULE` have been removed.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KG_TOPOLOGY_MISS_THRESHOLD` | No | `3` | SIO-1104: K — a topology edge missing from K consecutive complete sweeps is invalidated (`tInvalid` set). Edge staleness SLO = interval x K |
| `KG_TOPOLOGY_SOURCE_TIMEOUT_MS` | No | `60000` | SIO-1115: per-source wall-clock budget for one collector (the losing side of the race is not cancelled — the adapter SDK takes no AbortSignal — it just stops being awaited) |
| `KG_TOPOLOGY_MAX_PAGES` | No | `10` | SIO-1115: page cap shared by the APM composite aggregation and the ECS `nextToken` pagination. Hitting the cap marks the source incomplete (sweep skipped this round — safe) and warns, rather than reading partial data as authoritative |
| `KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS` | No | `15000` | SIO-1115: per-`kafka_describe_consumer_group` timeout inside the bounded-concurrency describe pool, well under the source budget so one stuck group cannot eat the wall clock |
| `KG_TOPOLOGY_AWS_ESTATE_TIMEOUT_MS` | No | `20000` | Per-estate budget inside the AWS collector, so one slow estate settles as rejected instead of discarding the edges the fast estates already collected |

---

## MCP Server URLs

URLs the agent uses to connect to each MCP server via `MultiServerMCPClient`. These must match the actual running addresses of your MCP servers.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELASTIC_MCP_URL` | Yes | `http://localhost:9080` | Elasticsearch MCP server URL |
| `KAFKA_MCP_URL` | Yes | `http://localhost:9081` | Kafka MCP server URL |
| `COUCHBASE_MCP_URL` | Yes | `http://localhost:9082` | Couchbase Capella MCP server URL |
| `KONNECT_MCP_URL` | No | `http://localhost:9083` | Kong Konnect MCP server URL. Leave unset while konnect is offline by design (SIO-1439): when set, the bridge dials it at boot, logs a `Failed to connect to MCP server, skipping` warn, and `/health` reports `degraded` for as long as it stays down (SIO-1643) |
| `GITLAB_MCP_URL` | Yes | `http://localhost:9084` | GitLab MCP server URL |
| `ATLASSIAN_MCP_URL` | Yes | `http://localhost:9085` | URL the agent uses to reach the local Atlassian MCP server (the upstream Rovo endpoint the proxy forwards to is `ATLASSIAN_UPSTREAM_MCP_URL`) |
| `AWS_MCP_URL` | Yes (for AWS datasource) | `http://localhost:3001` | URL the agent uses to reach the AWS MCP server. Locally points at the SigV4 proxy; in production points at the deployed AgentCore endpoint. See [AWS MCP — Multi-Estate](#aws-mcp--multi-estate) for the full AgentCore configuration. |
| `LANDING_ZONE_IAC_MCP_URL` | Yes (for Landing Zone repository evidence) | `http://localhost:9088` | URL for the PVH Landing Zone read and optional governed proposal server. |

In Docker Compose, these resolve to service names (e.g., `http://elastic-mcp:9080`). In bare-metal development, they resolve to `localhost` with each server's configured port.

---

## Server

General server configuration for the SvelteKit web frontend.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVER_PORT` | No | `5173` | Port for the SvelteKit development server |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `CORS_ORIGINS` | No | `http://localhost:5173` | Comma-separated list of allowed CORS origins |
| `ARCHIFY_DIAGRAMS_ENABLED` | No | on (kill-switch: `false`/`0` disables) | SIO-1876/1877: the Diagram tab on the network and application map cards, and `/api/diagram`. One read point (`apps/web/src/lib/server/archify/flag.ts`) |
| `ARCHIFY_DIR` | No | -- | Path to the vendored Archify directory. Unset, the renderer walks up from the working directory until it finds `vendor/archify/bin/archify.mjs`, and throws naming this variable if it finds none |

In production, set `CORS_ORIGINS` to the actual frontend domain. For local development, the default value matches the SvelteKit dev server.

### Telemetry and OAuth (shared by the MCP servers)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEMETRY_MODE` | No | -- (unset = off) | Setting it at all enables OpenTelemetry export: `console`, `otlp` or `both` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://localhost:4318` | OTLP collector endpoint used when the mode exports over OTLP |
| `MCP_OAUTH_HEADLESS` | No | -- | `true` makes the GitLab and Atlassian proxies treat the process as headless: no browser flow is started and a missing or expired token is reported instead. A process whose stdout is not a TTY is treated as headless either way. See [OAuth Seeding](../operations/oauth-seeding.md) |
| `OAUTH_PROACTIVE_REFRESH_INTERVAL_MS` | No | `1800000` | How often the GitLab and Atlassian proxies refresh their OAuth token ahead of expiry, to keep the refresh token inside its inactivity window. Clamped to between 60 000 and 3 600 000 |

---

## See Also

- [MCP Server Configuration](mcp-server-configuration.md) -- 4-pillar config pattern and per-server deep dives
- [Local Development](../deployment/local-development.md) -- port assignments and startup instructions

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial environment variables reference created (Phase 3: Configuration + Deployment) |
| 2026-04-09 | Fixed MCP server URL port defaults to match standardized ports (9080-9083) |
| 2026-04-13 | Added GitLab MCP server env vars, added GITLAB_MCP_URL and GITLAB_LANGSMITH_PROJECT |
| 2026-04-23 | Added Atlassian MCP server env vars (ATLASSIAN_SITE_NAME, ATLASSIAN_MCP_URL upstream, ATLASSIAN_MCP_URL_LOCAL, ATLASSIAN_OAUTH_CALLBACK_PORT, ATLASSIAN_READ_ONLY, ATLASSIAN_INCIDENT_PROJECTS, ATLASSIAN_TIMEOUT, ATLASSIAN_MCP_PORT, ATLASSIAN_LANGSMITH_PROJECT) |
| 2026-05-08 | added Confluent Connect (`CONNECT_ENABLED`, `CONNECT_URL`, `CONNECT_API_KEY`, `CONNECT_API_SECRET`), Schema Registry (`SCHEMA_REGISTRY_URL`, `SCHEMA_REGISTRY_API_KEY`, `SCHEMA_REGISTRY_API_SECRET`), ksqlDB (`KSQL_ENDPOINT`, `KSQL_API_KEY`, `KSQL_API_SECRET`), and REST Proxy (`RESTPROXY_ENABLED`, `RESTPROXY_URL`, `RESTPROXY_API_KEY`, `RESTPROXY_API_SECRET`) env vars. Expanded `KAFKA_ALLOW_WRITES` / `KAFKA_ALLOW_DESTRUCTIVE` scope description to cover Connect, SR, and REST Proxy gating. |
| 2026-05-10 | post-log-hygiene sync: added Elasticsearch per-call search tuning (`ELASTIC_SEARCH_REQUEST_TIMEOUT_MS`, `ELASTIC_SEARCH_MAX_RETRIES`) with shared-client `requestTimeout` cap raised to 120 000 ms; added Kafka admin-RPC timeout (`KAFKA_TOOL_TIMEOUT_MS`, default 30 000) replacing the previously dead `requestTimeout` knob; added agent graph and sub-agent timeout overrides (`GRAPH_TIMEOUT_MS` default 720 000, `SUB_AGENT_TIMEOUT_MS` default 360 000). |
| 2026-05-16 | collapsed the agent's Atlassian connection URL to `ATLASSIAN_MCP_URL` (was `ATLASSIAN_MCP_URL_LOCAL`) to match every other datasource's convention. The upstream Rovo endpoint the local proxy forwards to is now `ATLASSIAN_UPSTREAM_MCP_URL`. |
| 2026-05-28 | docs drift sweep: added new "AWS MCP — Multi-Estate" section documenting `AWS_ESTATES` (JSON map of `assumedRoleArn` + `externalId` per estate), `AWS_DEFAULT_ESTATE`, `AWS_MCP_URL`, `AWS_AGENTCORE_RUNTIME_ARN`, `AWS_AGENTCORE_REGION`, `AWS_AGENTCORE_PROXY_PORT`, `AWS_AGENTCORE_AWS_PROFILE`, `EXECUTION_ROLE_ARN`; added `AWS_LANGSMITH_PROJECT` to the LangSmith table; documented migration from legacy `AWS_ASSUMED_ROLE_ARN` / `AWS_EXTERNAL_ID` singletons. No new env vars required for SIO-822–826 (the new 9 Elastic cloud/billing tools are gated by the existing `EC_API_KEY`). |
| 2026-07-15 | SIO-1110: `GRAPH_TIMEOUT_MS` default raised to 900 000 (15 min); added budget-aware retry knobs `GRAPH_BUDGET_RESERVE_MS` (default 120 000) and `GRAPH_BUDGET_MIN_RETRY_MS` (default 60 000) — alignment skips retries and caps late sub-agent timers so aggregation always keeps its reserve. |
| 2026-07-15 | SIO-1111: added `ATLASSIAN_READINESS_FRESHNESS_WINDOW_MS` (default 90 000, passive readiness for the /ready cloudId component) and bridge-side `ATLASSIAN_TOOL_TIMEOUT_MS` (default 120 000); `ATLASSIAN_TIMEOUT` now actually bounds each upstream Rovo call (was dead config); documented the previously undocumented `ELASTIC_IAC_TOOL_TIMEOUT_MS`. |
| 2026-07-15 | SIO-1115: added `KG_TOPOLOGY_SOURCE_TIMEOUT_MS` (default 60 000), `KG_TOPOLOGY_MAX_PAGES` (default 10, shared APM composite-agg + ECS pagination cap), and `KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS` (default 15 000); extended `KAFKA_TOOL_TIMEOUT_MS` to also drive the bridge-side `defaultToolTimeout` for `kafka-mcp`; documented the previously undocumented topology-cron knobs `KG_TOPOLOGY_CRON_ENABLED` / `KG_TOPOLOGY_CRON_SCHEDULE` / `KG_TOPOLOGY_MISS_THRESHOLD`. |
| 2026-07-23 | SIO-1184: `ATLASSIAN_INCIDENT_PROJECTS` is now documented as optional-narrowing with an all-projects wildcard default; configured keys are validated against the live site on first custom-tool use (nonexistent keys dropped, wildcard fallback, `configWarning` in tool output). `.env.example` no longer ships the `INC,OPS` example -- those projects did not exist on the connected site and silently zeroed `findLinkedIncidents`/`getIncidentHistory` (SIO-1181 audit finding F1). |
| 2026-08-01 | SIO-1358: migrated the 3 hand-wired Bun.cron jobs (SIO-1005, SIO-1104, SIO-1135) to a declarative `schedules/*.yaml` layer with a generic scheduler. Removed `IAC_RECONCILE_CRON_SCHEDULE`, `KG_TOPOLOGY_CRON_ENABLED`, `KG_TOPOLOGY_CRON_SCHEDULE`, `KG_PURGE_CRON_ENABLED`, `KG_PURGE_CRON_SCHEDULE` -- cadence and on/off now live in each schedule's YAML file, not env vars. Documented the previously-undocumented `KG_UNCURATED_RETENTION_DAYS`. See `docs/superpowers/specs/2026-08-01-declarative-schedules-design.md`. |
| 2026-08-08 | SIO-1162..1459 sync. Added five previously-undocumented vars: `RESOLVE_IDENTIFIERS_PRESETS_ENABLED` (SIO-1355 preset-workflow selector, list-valued, default `all`), `SUB_AGENT_MANIFEST_MODEL_ENABLED` (SIO-1235/1404 manifest-model switch, default on), `EVAL_SUB_AGENT_MODEL_OVERRIDE` (SIO-1371 eval-only A/B swap), `EVAL_FIXTURE_MODE` (SIO-1379 sound-freeze record/replay), and `MCP_TOOL_METRICS_DB_PATH` (SIO-1400 MCP tool-call SQLite counters). **Corrected the wrong `schedules/kg-topology-sweep.yaml` default** in the SIO-1358 note: the topology sweep ships `enabled: false` (opt-in), not `enabled: true`. |
| 2026-09-30 | SIO-1897 docs sync (SIO-1635..1896 window), a code-vs-docs sweep over every `process.env` read outside tests. **Window additions:** `ARCHIFY_DIAGRAMS_ENABLED` / `ARCHIFY_DIR` (SIO-1876/1877); the sub-agent context, evidence and loop-control table (`SUBAGENT_*`, `EVIDENCE_INDEX_ENABLED`, `EVIDENCE_EXEC_ENABLED`, `EVIDENCE_TOC_ENABLED`, `DAILYLOG_TOOL_FAILURES_ENABLED`, `AWS_ABSENCE_EARLY_EXIT_ENABLED`, `AGGREGATE_*_CAP_BYTES`; SIO-1686..1689, 1773..1776); `MEMORY_PR_*` / `GITHUB_TOKEN` and `LEARNING_FEEDBACK_DEADLINE_MS` (SIO-1890/1896); couchbase `READ_ONLY_QUERY_MODE` (SIO-1109/1813/1822); a new pi-coms integration section for the web-app and agent-side `PI_COMS_*` / `PI_*_ENABLED` variables, which this file had never listed. **Corrections:** `LEARNING_REVIEW_ENABLED` (approve is `skipped` without memory-pr configured), `AGENT_PROMPT_CACHE_ENABLED` (also the SIO-1773 rolling history points). **Older drift:** report integrity gates, post-loop baselines, action-tool providers, `AGENT_KILL_SWITCH`, the elastic-iac CI contract and remaining path templates, elastic discovery timeouts and read-only mode, the AWS MCP process variables, `KAFKA_AGENTCORE_RUNTIME_ARN`, legacy `LANGCHAIN_*` aliases, telemetry and OAuth variables, and four knowledge-graph knobs. |
