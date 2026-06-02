**P1 INCIDENT REPORT --- CLOSURE**

**OTel Java Agent DB2 Instrumentation Surge**

*ts-app-sch-\* services \| B2C Ecommerce Backend \| eu-cld cluster
(3935ab4a0d944f778c09ad1e1053c8e0) \| Issued 4 May 2026*

**STATUS: RESOLVED --- verified 4 May 2026**

1. Executive summary
--------------------

The OpenTelemetry Java agent on ts-app-sch-\* (Transaction Server
Application Scheduler) services was capturing every individual DB2
database call as a transaction span. The OTel collector
signaltometricsconnector then aggregated these spans into 1-minute
rollup documents per unique SQL pattern, generating approximately 1.07
billion metric documents per day across the transaction.1m.otel and
service\_transaction.1m.otel datasets. This represented 73% of all
metrics ingestion on eu-cld and drove the cluster from 22 nodes to 30
nodes, raising hourly cost from \$42/hr to \$58.13/hr.

On 4 May 2026 the platform team verified the issue is no longer
reproducing in the live cluster. Direct queries for db.system:db2 spans
and \*db2\* span destinations return zero hits over the past 24 hours.
Combined ts-app-sch APM-metrics volume is 19.4M docs/24h across three
environments --- well under the pre-mitigation 1.1B/day baseline. The
top APM span destination cluster-wide is now mssql/C8 (11M docs/24h);
DB2 is not visible. This item is closed.

A residual \~64M docs/day from ts-app-sch continues to land on
.ds-logs-generic.otel-default-\* and
.ds-metrics-{transaction,service\_transaction}.1m.otel-default-\*. This
is non-DB2 OTel telemetry and is tracked as a separate item --- not a
regression of this incident.

2. Timeline
-----------

-   25 March 2026: OTel Java agent on ts-app-sch began emitting full DB2
    span instrumentation. Cluster ingest volume began climbing.

-   13 April 2026: emergency recovery session. Two rogue index templates
    (created 19 March) had caused 5.8 TB of B2C ecommerce log data to
    accumulate unmanaged on the hot tier over 25 days. Two hot nodes
    reached 86--88% disk utilisation, breaching low watermark and
    blocking new shard allocation. Three-hour manual recovery: ILM
    reassignment, forced rollovers, ILM step migration.

-   14 April 2026: P1 escalation report issued
    (eu-cld\_OTel\_DB2\_Escalation\_Report\_Apr14\_2026.docx).
    Recommended fix: -Dotel.instrumentation.jdbc.enabled=false on
    ts-app-sch JVM args. No application code change required.

-   Late April 2026: fix deployed by B2C Ecom team (date not formally
    recorded; volume dropped quietly).

-   4 May 2026 (this report): live cluster verification confirms
    resolution. Item moved to Resolved on the optimisation tracker.

3. Verification --- 4 May 2026
------------------------------

### 3.1 Direct DB2 query --- zero hits

POST metrics-apm\*,traces-apm\*/\_search\
{ \"size\": 0,\
\"query\": { \"bool\": { \"must\": \[\
{ \"range\": { \"\@timestamp\": { \"gte\": \"now-24h\" } } },\
{ \"bool\": { \"should\": \[\
{ \"term\": { \"db.system\": \"db2\" } },\
{ \"wildcard\": { \"span.destination.service.resource\": \"\*db2\*\" }
}\
\] } }\
\] } } }

Result: 0 hits.

### 3.2 ts-app-sch APM volume --- within expected envelope

-   ts-app-sch-staging-blue: 11.4M docs/24h

-   ts-app-sch-live-blue: 6.8M docs/24h

-   ts-app-sch-live-green: 1.2M docs/24h

-   Combined: \~19.4M docs/24h, vs the pre-mitigation 1.07B/day
    baseline.

-   Span breakdown: 9.2M transaction, 9.2M service\_transaction, 29K
    service\_destination, 25K service\_summary. No db.\* metricset
    visible.

### 3.3 Top APM destination cluster-wide

mssql/C8: 11M docs/24h. No DB2-related destination present in the top
20.

4. Fix that landed
------------------

B2C Ecom team applied -Dotel.instrumentation.jdbc.enabled=false (Option
A from the original escalation report) on ts-app-sch-\* container specs.
JDBC span capture is disabled. DB2 queries no longer generate
transaction metrics. Application-level traces (HTTP endpoints, message
consumers) remain unaffected. Health check query (SELECT
sysibm.sysdummy1) continues to function --- only the observability
instrumentation is disabled.

5. Outstanding items not closed by this fix
-------------------------------------------

-   Residual ts-app-sch OTel volume \~64M docs/day on
    .ds-logs-generic.otel-default-\* +
    .ds-metrics-{transaction,service\_transaction}.1m.otel-default-\*.
    Non-DB2 telemetry. Candidate for separate ingest review with B2C
    Ecom --- possibly sampling-rate or log-level adjustment. Tracked
    outside this incident.

-   Environment label fix
    (-Dotel.resource.attributes=service.environment=ecom-backend-staging)
    for ts-app-sch-staging-green still recommended if not already
    applied. ts-app-sch-staging-green was reporting service.environment
    as \"ecom-backend-prod\", causing staging data to appear in
    production dashboards.

6. Cost impact achieved
-----------------------

The DB2 span fix is the first of four prerequisites for the eu-cld 30→22
node infrastructure downsize (\$331,000/year). With this dependency
cleared, three remain: GK PoS DEBUG/TRACE + credential masking; dual
OTel + k8s log pipeline dedup decision; Genius.app CXF SOAP. The
downsize cannot proceed until all four are resolved, so this fix has not
yet translated to hourly-rate change --- but it has shortened the unlock
chain from four dependencies to three.

7. References
-------------

-   Original escalation:
    eu-cld\_OTel\_DB2\_Escalation\_Report\_Apr14\_2026.docx

-   Tracker: Elastic\_Optimisation\_Tracker\_Apr2026.xlsx (row 22 ---
    Resolved)

-   Live verification log: Tracker\_Validation\_Log\_2026-05-04.md

All volumes and absence claims validated 4 May 2026 against the live
eu-cld cluster (3935ab4a0d944f778c09ad1e1053c8e0) via Elasticsearch MCP
tooling.
