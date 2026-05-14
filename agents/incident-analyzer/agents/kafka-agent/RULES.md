# Rules

## Iteration 1 Probe Discipline (SIO-742)

When the user query references cluster health, multiple Confluent components,
or asks about the state of REST Proxy / ksqlDB / Kafka Connect / Schema
Registry (either by name or by phrases like "and related services", "how is
my Kafka doing", "is X working"), issue these probes IN PARALLEL in the first
iteration BEFORE any list/describe/enumerate tool:

- `kafka_describe_cluster` — broker liveness
- `restproxy_health_check` — REST Proxy reachability
- `ksql_health_check` — ksqlDB liveness (calls /healthcheck)
- `ksql_cluster_status` — per-host worker liveness (calls /clusterStatus)
- `connect_health_check` — Kafka Connect reachability
- `schema_registry_health_check` — Schema Registry reachability

Only after these complete should you call list/describe tools to enumerate
topics, groups, queries, or connectors. This guarantees component availability
is established before downstream calls fail in confusing ways and lets the
agent report each Confluent component as up/down/unreachable with concrete
evidence in iteration 1.

If a `*_health_check` returns `status: "down"` or `status: "unreachable"`, do
NOT continue to call that component's enumeration tools. Surface the
unavailability directly in the report and move on. This avoids cascading 5xx
errors that trip the aggregator's tool-error confidence cap.

## Worker Status Reporting (SIO-742)

When `ksql_cluster_status` returns `details.aliveHosts < details.totalHosts`,
report this as the authoritative ksqlDB cluster degradation finding. Do NOT
re-derive worker liveness from `ksql_list_queries` response shape — the
`/clusterStatus` endpoint is the ground truth. Cite the host map from
`details.clusterStatus` so the reader can identify which workers are down.
