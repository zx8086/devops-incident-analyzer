**INCIDENT REPORT**

**Dual OTel + Kubernetes Log Pipeline Duplicate Ingestion**

*B2C Ecommerce \| .ds-logs-generic.otel-default-\* and
.ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd-\* \| eu-cld
cluster (3935ab4a0d944f778c09ad1e1053c8e0) \| Issued 4 May 2026*

1. Executive summary
--------------------

B2C Ecommerce workloads emit application logs through two parallel
ingestion pipelines into the eu-cld cluster: the OpenTelemetry collector
pipeline (landing in .ds-logs-generic.otel-default-\*) and the
Kubernetes container-logs pipeline (landing in
.ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd-\*). For services
where both pipelines are active, the same log records are stored twice,
doubling storage cost and shard count for that workload.

On 4 May 2026 the platform team verified that both pipelines are
actively ingesting in parallel. The OTel pipeline is processing 430.7M
documents in the past 24 hours; the Kubernetes container-logs pipeline
for B2C Ecom prod is processing 60.6M documents in the same window.
Pre-existing analysis estimated overlap at 100--200M docs/day duplicate.
The incident is not a defect --- both pipelines are doing what they are
configured to do. The fix is a per-app decision: which pipeline is the
system of record, and disable duplicate emission at source for the
others.

This is the third of fourth remaining prerequisites for the eu-cld 30→22
node infrastructure downsize (\$331,000/year unlock). Unlike GK PoS and
Genius, this item is owner arbitration, not a code change: it requires a
single decision-maker to be named.

2. Current state --- verified 4 May 2026
----------------------------------------

### 2.1 Pipeline volumes, last 24 hours

-   .ds-logs-generic.otel-default-\*: 430,671,930 documents (93 shards)

-   .ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd-\*:
    60,595,416 documents (10 shards)

### 2.2 Top services on each pipeline

OpenTelemetry pipeline (.ds-logs-generic.otel-default-\*), last 24
hours:

-   ts-app-live-blue --- 185.6M docs

-   product-details --- 61.4M docs

-   ts-app-sch-live-green --- 25.8M docs

-   th-browsesearch-live --- 25.3M docs

-   coremedia-content --- 23.2M docs

-   kong-proxy --- 19.1M docs

-   ck-browsesearch-live --- 18.1M docs

-   product-search --- 15.3M docs

-   logstash --- 14.1M docs

-   ts-app-staging-blue --- 7.9M docs

Kubernetes container-logs pipeline
(.ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd-\*), last 24
hours:

-   browsesearch --- 43.4M docs

-   logstash --- 12.9M docs

-   myaccount --- 555K docs

-   checkout --- 519K docs

-   services --- 474K docs

-   vpa --- 415K docs

-   help --- 412K docs

-   opentelemetry-kube-stack-gateway-collector --- 344K docs

### 2.3 Confirmed duplication signal

-   logstash service appears on both pipelines (12.9M k8s + 14.1M OTel =
    duplicate emission).

-   browsesearch on the k8s pipeline (43.4M) likely overlaps with
    th-browsesearch-live (25.3M) and ck-browsesearch-live (18.1M) on the
    OTel pipeline (combined 43.4M) --- strong indication of
    like-for-like duplication, just labelled differently. Note:
    service.name on OTel comes from the application resource attribute;
    on k8s pipeline it derives from the pod/container name. Confirms the
    decision must be per-app.

3. Root cause
-------------

There is no single defect. Both pipelines are functioning correctly in
their own terms. The overlap is an architectural consequence of running
two collection mechanisms over the same pod logs: the OpenTelemetry
collector reads logs via the application or sidecar; the Kubernetes
integration reads stdout/stderr via Filebeat-equivalent collection.
Without a pipeline-of-record decision, both are kept on for safety,
doubling storage.

4. Required action
------------------

### 4.1 Decision needed

A single decision-maker (B2C Ecom platform lead, with observability
programme owner CC\'d) must designate, per service or per service group,
which pipeline is the system of record:

-   OTel pipeline as system of record → disable Kubernetes
    container-logs collection for that pod via integration policy
    (selector-based exclusion).

-   Kubernetes container-logs as system of record → remove the OTel logs
    exporter for that service, or scope the OTel collector logs receiver
    to exclude the workload.

### 4.2 Recommended default

OTel as system of record for instrumented application services. The OTel
pipeline carries richer correlation context (trace\_id, span\_id,
resource.attributes), so it is the more useful artifact for distributed
tracing-led investigations. Kubernetes container-logs pipeline retained
only for pods that are not OTel-instrumented (cluster-level operators,
sidecars, system DaemonSets). This pattern would dedupe
ts-app-live-blue, product-details, th/ck-browsesearch, kong-proxy, and
similar at a stroke.

### 4.3 Implementation steps once decision is made

-   B2C Ecom platform: produce per-service mapping of \"system of
    record\" pipeline.

-   Platform team: update the Kubernetes integration policy (Fleet) with
    a namespace/label-based exclusion for services where OTel is the
    system of record.

-   Platform team: roll out via Fleet integration update; verify volume
    decline on .ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd-\*
    over 24--48h.

-   Update the eu-cld\_Outstanding\_Issues\_Register and the
    optimisation tracker to record closure.

5. Validation method
--------------------

Daily volume comparison post-rollout:

POST
.ds-logs-generic.otel-default-\*,.ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd\*/\_search\
{ \"size\": 0,\
\"query\": { \"range\": { \"\@timestamp\": { \"gte\": \"now-24h\" } }
},\
\"aggs\": { \"by\_pipeline\": { \"filters\": { \"filters\": {\
\"otel\": { \"prefix\": { \"\_index\": \".ds-logs-generic.otel-default\"
} },\
\"k8s\_b2c\": { \"prefix\": { \"\_index\":
\".ds-logs-kubernetes.container\_logs-eu\_b2c\_ecom\_prd\" } }\
} } } } }

Closure criterion: combined daily document count drops by 100--200M
against the 4 May 2026 baseline of 491.3M (combined OTel + k8s
eu\_b2c\_ecom\_prd).

6. Cost framing
---------------

Storage saving: at 100--200M docs/day duplicate, the cluster carries
roughly 9--18B duplicate documents under 90-day retention. Removing
duplication reduces hot/warm/cold/frozen tier footprint proportionally
on the relevant data streams.

Programme impact: this is one of three remaining prerequisites for the
eu-cld 30→22 node downsize (\$331,000/year). Without a decision-maker,
the downsize cannot proceed. This is the lowest-effort remediation of
the three remaining items --- it requires a decision, not engineering
work.
