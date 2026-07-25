# Per-Incident Network Map + Network Topology in the Knowledge Graph

Date: 2026-07-25
Tickets: SIO-1204 (parent), SIO-1205 (AWS tools slice), SIO-1206 (builder/UI slice), SIO-1207 (KG slice)

## Context

The incident analyzer should build a network overview of the components analyzed during an incident (apps, APIs, services, nodes, instances) from data the agents can already fetch: IPs, ENIs, VPCs, subnets, routes, ALB/NLB, DNS, plus service endpoints from Kong/Kafka/Capella/Elastic. The map is mostly ephemeral per session (instance/task IPs churn), but static facts (DNS, VPC, subnets, LBs) persist to the knowledge graph on each incident.

Inspired by two Neo4j references:

- The CIDR-check UDF article (`example.ipBelongsToNetwork(ip, cidr)`) and its repo (looeejee/neo-udf-cidr-check). Adaptation: our KG is embedded lbug/Kuzu with no UDF support, so CIDR containment is computed in TypeScript at ingest time and stored as explicit `IN_SUBNET` edges (with a `derived` flag when it came from CIDR math rather than an explicit SubnetId). Queries stay plain Cypher.
- The Neo4j Network Management browser guide: hierarchical DC model (DataCenter -> Zone networks -> Rack subnets -> Machines -> Interfaces/Ports), path-based impact analysis, and live connection events aggregated into traffic edges. Its containment model maps 1:1 onto ours: DataCenter = AWS estate/account, Zone network = VPC, Rack subnet = Subnet, Machine = workload (EC2 instance / ECS task), Interface = ENI/IpAddress, Port = Endpoint, Application = Service (our `DEPENDS_ON` already exists). Its impact-analysis and traffic-aggregation queries are follow-ups once this schema lands.

## Decisions

1. **UI**: new `NetworkTopologyCard.svelte` following the existing `*FindingsCard` + SSE pattern, rendering the map with an Apache ECharts `graph` series: interactive force-layout node-link diagram with roam/zoom, category coloring per node kind, tooltips. The `NetworkTopologySchema` nodes/edges shape maps 1:1 onto ECharts `data`/`links`/`categories`.
2. **New AWS MCP tools**: ELBv2 (4), Route53 (2), `ec2 DescribeSubnets`. The deployed IAM role already grants every action (`packages/agent/src/aws-policy-actions.ts:24,30-33,157-159`); only the MCP registrations and agent actions are missing.
3. **KG persistence**: static topology (Vpc/Subnet/LoadBalancer/TargetGroup/DnsRecord) AND bi-temporal IP-to-workload bindings (`tValid`/`tInvalid`, one-owner conflict invalidation) so the SIO-1200 reverse-IP protocol becomes KG-cache-first.
4. **Scope v1**: AWS + service-endpoint overlay (Kong host/port + routes, Kafka brokers, Capella/Elastic hostnames).

## Architecture

### Data flow

```text
sub-agents fetch (ec2_state / ecs_state / NEW ingress_state / konnect / kafka / capella / elastic)
  -> toolOutputs[] on DataSourceResult
  -> buildNetworkTopology(dataSourceResults, focusServices)   [pure, called twice]
       in aggregate:       summarizeNetworkTopologyForPrompt -> networkContext prompt part
       in extractFindings: state.networkTopology (replace reducer) -> network_topology SSE event
  -> recordBindings (KG-gated): deriveNetworkTopology(state) -> recordNetworkTopology + recordIpBinding
  -> next incident: graphEnrich known-topology lines; resolveIdentifiers ipHints (KG-cache-first reverse IP)
```

Key constraint: `aggregate` runs BEFORE `extractFindings` in the pipeline, so the builder is a pure function called twice rather than a state handoff. No new pipeline node; the 31-node invariant in `docs/architecture/agent-pipeline.md` is untouched.

### Shared types (`packages/shared/src/agent-state.ts`)

- `NetworkTopologySchema`: `nodes[]` (`kind: vpc|subnet|workload|eni|loadBalancer|targetGroup|dnsRecord|serviceEndpoint`; stable ids; cidr/ips/dnsName/health/endpoint/service fields), `edges[]` (`kind: in-vpc|in-subnet|attached-to|resolves-to|routes-to|targets|serves`; `derived: true` for CIDR-math edges), `sources[]`, `truncated`. Separate from `AwsFindings` because it is cross-datasource, per-turn, and dual-consumed (card + KG writer).
- `StreamEventSchema` member: `{ type: "network_topology", topology: NetworkTopologySchema }`.
- `ResolvedIdentifiers.aws` gains optional `ipHints: Array<{ip, workloadArn, service?, lastVerified}>`.
- `packages/shared/src/ip-cidr.ts`: `parseIpv4`, `ipInCidr` (IPv4 only; never throws; false on malformed/IPv6 input — a false negative just omits an edge). The single home for CIDR math; KG writers stay lookup-free.

### AWS tool surface (slice 1, SIO-1205)

New concrete tools in `packages/mcp-server-aws` (mirroring the ec2 group patterns: SIO-838 limit/cursor aliases, `wrapListTool`, `summarize` projections):

| Tool | Notes |
|---|---|
| `aws_elbv2_describe_load_balancers` | Marker/NextMarker pagination (TOKEN_FIELDS compatible) |
| `aws_elbv2_describe_listeners` | `DefaultActions[].TargetGroupArn` is the routes-to link |
| `aws_elbv2_describe_target_groups` | |
| `aws_elbv2_describe_target_health` | No pagination; Target.Id is instance-id or IP |
| `aws_route53_list_hosted_zones` | |
| `aws_route53_list_resource_record_sets` | Positional pagination (NextRecordName/NextRecordType) — continuation advice in the description, no fake token support |
| `aws_ec2_describe_subnets` | CidrBlock/VpcId/AZ — the CIDR source for IP placement |

Agent side: `aws-introspect.yaml` gains `ingress_state` (the 6 ELBv2+Route53 tools) and `describe_subnets` joins `ec2_state`. `aws-agent/RULES.md` gains a Network map protocol (DNS record -> LB DNSName match -> listeners -> target groups -> target health, scoped to focus-relevant TGs) and a step 0 on the SIO-1200 reverse-IP protocol: verify-then-trust any supervisor-injected KG ip-hint.

### KG schema (slice 3, SIO-1207)

New node tables (born complete — no ALTERs, so the SIO-1136 CREATE/ALTER default-parity rule is vacuously satisfied):

- `Vpc(id PK, cidr, accountId, region, name)`
- `Subnet(id PK, cidr, az, vpcId)`
- `LoadBalancer(arn PK, name, dnsName, type, scheme)`
- `TargetGroup(arn PK, name, port INT64, protocol)`
- `DnsRecord(id PK = "<name>:<type>", name, type, target)` — a name legitimately carries A + AAAA + CNAME simultaneously
- `IpAddress(ip PK)` — IP is a node: the flagship query is reverse (ip -> workload), bi-temporal history needs a stable anchor, and `IN_SUBNET` needs an endpoint. Private IPs are unique only per VPC; the reader returns all currently-valid hits with subnet/VPC context for disambiguation.
- `Endpoint(id PK = "<host>:<port>", host, port, protocol, datasource)`

New rel tables, all born with lifecycle columns (`discoveredBy '', tValid '', tInvalid '', consecutiveMisses 0`):

`IN_VPC(Subnet->Vpc)`, `IN_SUBNET(IpAddress->Subnet)`, `ATTACHED_TO(LoadBalancer->Subnet)`, `HAS_TARGET_GROUP(LoadBalancer->TargetGroup)`, `FORWARDS_TO(TargetGroup->AwsResource)`, `FORWARDS_TO_IP(TargetGroup->IpAddress)` (two tables — multi-pair rel groups are unverified on lbug 0.14.3), `RESOLVES_TO_LB(DnsRecord->LoadBalancer)` (the existing `RESOLVES_TO` is typed Alias->Service), `HAS_ENDPOINT(Service->Endpoint, +confidence/evidence/lastVerified)`, `BOUND_TO(IpAddress->AwsResource, +confidence/evidence/lastVerified/incidentId)`.

Workload = the existing `AwsResource(arn)`: `IpAddress-BOUND_TO->AwsResource<-RUNS_ON-Service` answers ip -> service with zero new service linkage.

Deliberately NOT in `TOPOLOGY_KINDS` / the cron sweep in v1: the sweep contract requires complete enumeration per kind, and per-incident collection is inherently partial — feeding it to `sweepStaleTopology` would accrue false misses. IP staleness uses one-owner conflict invalidation instead (a new binding to a different workload sets `tInvalid` on the prior valid edge — the proven `RESOLVES_TO` alias mechanism). A future network sweep collector is a follow-up ticket.

Writers: `recordNetworkTopology(store, record, incidentId?)` (Zod-parse the whole record; MERGE parents-before-children; keep-first `tValid` idiom) and `recordIpBinding` (mirror of `recordServiceBinding` incl. conflict invalidation). Readers: `networkMapForService(store, service, asOf?)` and `ipToWorkload(store, ip, asOf?)` (uses `validityClause`; `asOf` gives the historical tier a KG answer before flow logs are touched).

Pipeline wiring: inside `recordConfirmedBindings` (record-bindings.ts), behind a new `isNetworkWriteEnabled` gate (`KG_NETWORK_WRITE_ENABLED`, default ON, inert without `KNOWLEDGE_GRAPH_ENABLED`), in its own try/catch (`reason: "network-write-failed"`). The no-bindings early-return is relaxed so a turn that confirmed no telemetry bindings still persists its network map.

Query surface: curated tools `kg_network_map { service }` and `kg_ip_to_workload { ip, asOf? }`; the hand-maintained `SCHEMA_CARD` in `cypher.ts` gains a network-subgraph block (explicit checklist item — known drift failure mode). `rebuild.ts`'s NOT-rebuilt message lists network topology + IP bindings (machine-rediscoverable; no durable mirror facts per the SIO-1135 curated-only rule).

### Frontend (slice 2, SIO-1206)

ECharts via direct modular imports (`echarts/core` + `GraphChart` + `TooltipComponent` + `LegendComponent` + `CanvasRenderer`), no wrapper library. `NetworkTopologyCard.svelte` is SSR-guarded (`onMount` + dynamic import), disposes on teardown, resizes with its container. A pure `apps/web/src/lib/network-chart.ts` module transforms `NetworkTopology` -> ECharts option (categories = the 8 node kinds with brand palette colors; symbolSize by kind; dashed lineStyle for `derived` edges; health-colored target groups; force layout with roam/drag; label suppression until zoom). Node cap (MAX_NODES=200) is enforced upstream in the builder.

## Error handling

- Builder is pure and total: malformed toolOutputs are skipped via `safeParse`; the map degrades to fewer nodes, never throws.
- KG writes soft-fail to `partialFailures` and never change the turn's answer (existing KG node contract).
- CIDR helper never throws; IPv6 and malformed inputs return false (an omitted edge, not a wrong edge).
- DNS -> LB matching is string-based (normalize case/trailing dots); unmatched records are emitted unlinked rather than dropped.

## Testing

- `packages/shared`: ip-cidr unit tests (/32, /0, boundaries, bad octet, IPv6, empty).
- `packages/mcp-server-aws`: per-tool tests; fixture updates for the tool-enumerating smoke/integration tests.
- `packages/agent`: builder tests over synthetic toolOutputs (full elbv2 chain, route53 alias match, CIDR-derived placement, caps); record-bindings wiring test.
- `packages/knowledge-graph`: writer/reader unit tests (exact-Cypher asserts via InMemoryGraphStore: MERGE order, conflict invalidation, keep-first tValid) + temp-dir integration round trip (idempotent init, re-bind invalidation, as-of reads).
- `apps/web`: reducer case + pure network-chart transform tests (no DOM).
- Manual: live-call the new AWS tools against a real estate; replay an incident turn with `KNOWLEDGE_GRAPH_ENABLED=true`; verify the SSE event, the ECharts render, KG persistence, and the second-turn KG hint.

## Out of scope (follow-up tickets)

- Network sweep collector (cron ELBv2/Route53/subnet enumeration per estate with lifecycle management).
- Traffic edges from VPC flow logs (`CONNECTS_TO` aggregation — observed traffic vs configured topology).
- Path-based impact analysis over the persisted network subgraph (complements `blastRadiusForServices`).
- IPv6 CIDR support.
- Supervisor direct `kg_network_map` tool routing via mcp-bridge (in-process readers cover it).
