---
type: Runbook
title: "High Error Rate Investigation"
description: "Investigate a spike in application error rate across the API gateway, Elasticsearch logs, Couchbase, and Kafka."
status: stable
tags: [elastic, apm, errors]
generated:
  by: human:simon
  at: 2026-07-29
triggers:
  metrics:
    - error rate
    - 5xx
    - http status
    - http_status
    - gateway
    - ingest failure
    - ingest_failure
  severity:
    - critical
    - high
  match: any
tools:
  - konnect_query_api_requests
  - konnect_list_services
  - konnect_list_routes
  - konnect_get_service
  - konnect_list_plugins
  - elasticsearch_search
  - elasticsearch_count_documents
  - elasticsearch_get_ingest_pipeline
  - elasticsearch_get_cluster_stats
  - elasticsearch_simulate_ingest_pipeline
  - capella_get_system_vitals
  - capella_get_fatal_requests
  - capella_get_longest_running_queries
  - kafka_list_consumer_groups
  - kafka_describe_consumer_group
  - kafka_get_consumer_group_lag
---
# High Error Rate Investigation

Investigate a spike in application error rate across the API gateway, Elasticsearch logs, Couchbase, and Kafka.

## Symptoms
- Elevated 5xx responses on API gateway (Kong Konnect)
- Error rate exceeding SLO threshold (>1% of requests)
- Backend service health checks failing
- Elasticsearch ingest pipeline failures (grok, rename processors)

## Investigation Steps

### 1. Quantify Error Rate at the Gateway
Use `konnect_query_api_requests` to pull status code distribution over the last 30 minutes, filtered by 5xx codes. Use `konnect_list_services` and `konnect_list_routes` to map erroring routes to upstream services.

### 2. Identify Affected Services and Routes
Use `konnect_get_service` for each upstream showing errors. Check `konnect_list_plugins` on affected routes for misconfigured auth, rate-limiting, or transformation plugins that could cause 5xx responses.

### 3. Search Application Logs in Elasticsearch
Use `elasticsearch_search` against application log indices, filtering for level:ERROR or level:FATAL in the matching time window. Filter by service name fields. Use `elasticsearch_count_documents` to quantify error volume per service.

### 4. Check Elasticsearch Ingest Pipeline Health
Use `elasticsearch_get_ingest_pipeline` to retrieve pipeline definitions. Use `elasticsearch_get_cluster_stats` to check processor failure counts (grok, rename). Use `elasticsearch_simulate_ingest_pipeline` with a sample failing document to reproduce the failure pattern.

### 5. Verify Couchbase Cluster Health
Use `capella_get_system_vitals` for CPU, memory, disk, rebalance status. Use `capella_get_fatal_requests` to check for query errors. Use `capella_get_longest_running_queries` to identify queries that may be timing out.

### 6. Check Kafka Consumer Processing
Use `kafka_list_consumer_groups` and `kafka_describe_consumer_group` to check for stalled or rebalancing groups. Use `kafka_get_consumer_group_lag` to quantify processing delay. Stalled consumers can cause cascading backend timeouts.

## Cross-Datasource Correlation
- Gateway 5xx + Couchbase fatal requests = likely database-induced errors
- Gateway 5xx + Kafka consumer lag = async dependency failure
- Gateway 5xx + Elasticsearch pipeline failures = observability gap (logs may be missing)
- Gateway 5xx isolated to specific routes = plugin misconfiguration or upstream deployment issue

## Escalation Criteria
- Error rate >5% sustained for 10+ minutes: page on-call
- Error rate >25%: escalate to incident commander
- Single service >50% error rate: consider emergency rollback (requires human approval)

## All Tools Used Are Read-Only
konnect_query_api_requests, konnect_list_services, konnect_list_routes, konnect_get_service, konnect_list_plugins, elasticsearch_search, elasticsearch_count_documents, elasticsearch_get_ingest_pipeline, elasticsearch_get_cluster_stats, elasticsearch_simulate_ingest_pipeline, capella_get_system_vitals, capella_get_fatal_requests, capella_get_longest_running_queries, kafka_list_consumer_groups, kafka_describe_consumer_group, kafka_get_consumer_group_lag
