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

## Offset-growth when broker timestamps are unusable (SIO-1141)

A **timestamp-based** offset lookup (`kafka_get_topic_offsets` with a `timestamp`
argument) returns the offset of the first message whose broker-stored timestamp is
`>= timestamp`. When a broker's stored timestamps are corrupt or far-future, NO
stored timestamp exceeds a recent incident timestamp, so the broker returns the
**current high-water mark** for every partition. Symptom: the timestamp lookup for a
past incident window returns values identical to the LATEST offsets.

When you see that symptom, DO NOT report offset-growth as "unavailable" or the
backlog-drain hypothesis as unconfirmable. Timestamp lookups are only ONE way to
measure growth. Pivot to a **timestamp-independent** measure before concluding
anything:

1. `kafka_get_consumer_group_lag({ groupId })` — committed offsets vs current
   high-water marks. This is a real position-in-log measure and does not depend on
   broker timestamps at all. Growing lag is the direct signal of a backlog.
2. Two-sample delta over wall-clock time — call `kafka_get_topic_offsets` (no
   `timestamp`; LATEST) once, wait ~30s, call it again; `secondSample - firstSample`
   is live message inflow. This is exactly how `kafka_list_dlq_topics` computes
   `recentDelta`; apply the same technique to any topic.

Use whichever timestamp-independent measure is available: consumer-group lag
supports a current-backlog finding (report the lag evidence you have), while two
wall-clock samples support a recent-offset-growth finding. Either one alone is
enough to draw a conclusion. Only when NEITHER measure is available may you report
an offset-growth gap — and phrase it as "historical per-window offset deltas could
not be reconstructed because broker timestamps are unusable", never a flat "unavailable".

## Targeted Message Lookup by Business Key (SIO-1201)

When asked to confirm delivery or presence of an event referencing a specific
business identifier (order ID, SKU, product/notification code, etc.) in a named
topic, Kafka has no secondary content index -- there is no tool that searches a
topic by key or payload content. The only way to answer this is a bounded scan
across the topic's partitions:

1. Call `kafka_consume_messages` with `fromBeginning: true` and an explicit bound
   on both `maxMessages` (e.g. 500, the tool's max) and `timeoutMs` (at or below
   the tool's 60s max). Match the business key against each returned message's
   `key` with EXACT equality first. If the key does not carry the business
   identifier (e.g. the key is a partition/routing key, not the business ID),
   `JSON.parse` the `value` and compare the specific expected field to the
   business key with exact equality. Do not substring-match the raw serialized
   `value` string -- an unrelated field or nested object containing the same
   digits/text as the business key produces a false positive.
2. **There is no partition-narrowing shortcut.** `kafka_consume_messages` has no
   partition parameter -- it always scans every partition of the topic, not one.
   Kafka's admin/broker API also does not expose a topic's partitioning strategy
   (key-hash vs. round-robin is a producer-side decision), so there is no way to
   compute which single partition a business key would land in. Do not claim or
   attempt a single-partition scan; every lookup under this protocol scans all
   partitions from the beginning, bounded by `maxMessages`/`timeoutMs`.
3. **This is a bounded scan, not an exhaustive one.** `maxMessages`/`timeoutMs`
   caps mean the scan may stop before reaching the end of a large or high-volume
   topic even with `fromBeginning: true`. Respect the existing `fromBeginning`
   caveat above: an empty scan result within the bound means "not found within
   this bounded scan," not "the topic is empty" or "the message does not exist" --
   do not conflate the two.
4. If the scan completes without a match, report "message for `<business-key>`
   not found within a `<N>`-message / `<T>`-second bounded scan from the
   beginning of `<topic>`" -- a falsifiable, bounded claim. Never report a bare
   "not sampled" or "not queried".
