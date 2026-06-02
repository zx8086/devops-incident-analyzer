**INCIDENT REPORT**

**GK PoS Plaintext Credential Exposure & DEBUG/TRACE Volume**

*eu\_pos\_gk\_till Fleet Policy \| logs-gkpos-eu\_pos\_gk\_till data
stream \| eu-cld cluster (3935ab4a0d944f778c09ad1e1053c8e0) \| Issued 4
May 2026*

1. Executive summary
--------------------

The GK PoS application emits Apache CXF HTTP logging interceptor output
at INFO level. These messages contain full HTTP headers including
JSESSIONID (Java session cookie) and INGRESSCOOKIE (Kubernetes ingress
controller affinity token). The tokens are full, valid session
credentials --- not hashed, not redacted. They are ingested as
unstructured text into the logs-gkpos-eu\_pos\_gk\_till data stream and
remain searchable for 90 days.

On 4 May 2026 the platform team verified the issue is active in the live
cluster: 65.3 million GK PoS log documents ingested in the last 24
hours; 1.86 million of those documents contain plaintext session tokens
on a single shard alone. With 90-day retention, this represents on the
order of 5.9 billion records carrying valid credentials, accessible to
anyone with read permission on the index pattern.

This item is the one of four remaining prerequisites for the eu-cld
30→22 node infrastructure downsize (\$331,000/year unlock).

2. Current state --- verified 4 May 2026
----------------------------------------

### 2.1 Volume

-   .ds-logs-gkpos-eu\_pos\_gk\_till\* total ingest, last 24 hours:
    65,337,905 documents.

-   Documents matching JSESSIONID or INGRESSCOOKIE on
    .ds-logs-gkpos-eu\_pos\_gk\_till-2026.05.03-003290 alone, last 24
    hours: 1,863,338.

-   Implied steady-state stored exposure with 90-day retention: \~5.9
    billion records containing session tokens.

-   Top contributing shards in the period: rolling daily indices each
    carrying 33--36M documents at 10--10.4 GB primary shard size ---
    consistent with pre-mitigation throughput.

### 2.2 Search reproducibility

Anyone with read access to the data stream can locate exposed tokens
with a trivial query:

GET .ds-logs-gkpos-eu\_pos\_gk\_till\*/\_search\
{ \"query\": { \"match\_phrase\": { \"message\": \"JSESSIONID\" } },
\"size\": 10 }

3. Root cause
-------------

The CXF framework PosLoggingInInterceptor and PosLoggingOutInterceptor
are configured to log full HTTP request and response metadata at INFO
level. CXF\'s default LoggingFeature includes all HTTP headers in the
log output without sanitisation. The interceptors execute on every HTTP
call the till makes to the cloud4retail backend, including
high-frequency polling traffic (command-channel messages, heartbeat).
Each call carries JSESSIONID and INGRESSCOOKIE; these are written to the
log file at C:\\gkretail\\pos-full\\log\\\*.log on each till and
collected by the Elastic Agent Filestream integration on the
eu\_pos\_gk\_till Fleet policy.

A secondary contribution to volume comes from
ProcessExecutionServiceImpl and LoginManager logging at INFO. Their
heartbeat output adds approximately 33 million documents per day against
tokens of comparable size. Reducing these to DEBUG is a separate
quick-win.

4. Required fix
---------------

### 4.1 Option A --- Remove CXF Logging Interceptors

Remove PosLoggingInInterceptor and PosLoggingOutInterceptor from the CXF
endpoint chain in production Spring/CXF configuration. Application
functionality is unaffected --- these interceptors are
observability/debug tooling, not functional components.

### 4.2 Option B --- Configure header redaction

If HTTP logging must remain for diagnostics: override the interceptors
to mask values for JSESSIONID, INGRESSCOOKIE, and Authorization headers.
Replace token values with \[REDACTED\] before the log.info() call.
Retains visibility of which headers are present without exposing values.

### 4.3 Option C --- CXF LoggingFeature limit

Minimum mitigation. Configure LoggingFeature to suppress header output:

\<bean class=\"org.apache.cxf.ext.logging.LoggingFeature\"\>\
\<property name=\"logBinary\" value=\"false\"/\>\
\<property name=\"verbose\" value=\"false\"/\>\
\</bean\>

### 4.4 Companion change --- heartbeat log-level reduction

In the same release, set ProcessExecutionServiceImpl and LoginManager
loggers to DEBUG level in production. Reduces approximately 33 million
documents per day at no functional cost.

5. Validation method
--------------------

Platform team will run the following query immediately after fix
deployment and again 24h after:

POST .ds-logs-gkpos-eu\_pos\_gk\_till\*/\_search\
{ \"size\": 0,\
\"query\": { \"bool\": { \"filter\": \[\
{ \"range\": { \"\@timestamp\": { \"gte\": \"now-10m\" } } },\
{ \"match\_phrase\": { \"message\": \"JSESSIONID\" } }\
\] } } }

Closure criterion: zero hits in the 10-minute window. Existing exposed
records age off naturally under 90-day retention; destructive
delete-by-query is available if immediate purge is required (impacts log
completeness).

7. Cost framing
---------------

Direct cost contribution: GK PoS volume (\~65M docs/day) is part of the
upstream ingest load that gates the eu-cld 30→22 node downsize. The
downsize itself unlocks \$331,000/year. Reducing GK PoS heartbeat volume
by \~33M docs/day (the companion fix) is a meaningful fraction of the
total volume reduction needed.

Indirect cost: the security exposure window has been open since April
2026. Each additional day extends the population of credentials
searchable in the cluster.
