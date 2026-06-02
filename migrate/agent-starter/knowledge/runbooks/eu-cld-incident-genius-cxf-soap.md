**INCIDENT REPORT**

**Genius.app CXF SOAP Payload Logging at INFO Level**

*eu\_pos\_genius\_backend\_prod \|
.ds-logs-genius.app-eu\_pos\_genius\_backend\_prod-\* \| eu-cld cluster
(3935ab4a0d944f778c09ad1e1053c8e0) \| Issued 4 May 2026*

1. Executive summary
--------------------

The Genius.app backend is logging full SOAP envelope content via the
Apache CXF logging interceptor at INFO level. Each outbound or inbound
SOAP call writes the complete XML payload (headers, body, namespaces) to
the application log. Logs are then collected and ingested into
.ds-logs-genius.app-eu\_pos\_genius\_backend\_prod-\*, where they
accumulate at much higher document size than typical structured log
entries.

Live volume on the genius.app prod data stream is approximately 1.6
million documents per day. A keyword check for \"Envelope\" (the SOAP
marker) returns 1.5 million matches in the same 24-hour window,
confirming SOAP payload logging is active.

This is the lowest-volume of the four prerequisites for the eu-cld 30→22
node infrastructure downsize (\$331,000/year unlock). The fix is
configuration-only.

2. Current state --- verified 4 May 2026
----------------------------------------

### 2.1 Volume

-   .ds-logs-genius.app-eu\_pos\_genius\_backend\_prod-\*, last 24
    hours: \~1.6M documents (1,452,800 on the 2026.05.03 backing index
    plus secondary spillover).

-   Documents matching the SOAP marker \"Envelope\" in the message
    field: \~1.5M of the 1.6M. Approximately 94% of genius.app messages
    still contain SOAP XML.

-   Companion data streams active:
    .ds-logs-genius.ftp-eu\_pos\_genius\_backend\_prod-\* (\~1M
    docs/day, separate FTP-related logging, lower priority).

### 2.2 Log-level breakdown across genius.\* indices, last 24 hours

-   error: 63,341

-   information: 56,220

-   warn: 11,827

-   info: 1,395

-   warning: 898

-   critical: 1

Note: the level-categorised counts above sum to \~133K, which is far
below the 1.6M total. Most genius.app messages are not landing in
indexed log.level buckets --- consistent with CXF interceptor output
being written as unstructured INFO-level log lines without an explicit
level field. This shape is what was identified as the \"null error
handler\" pattern.

3. Root cause
-------------

The Apache CXF LoggingFeature is enabled on the Genius backend\'s SOAP
endpoint chain. Its default behaviour is to log full request and
response payloads at INFO level. The interceptor output includes the
complete SOAP envelope --- headers, body, and any embedded data --- for
every inbound and outbound SOAP call. There is no built-in size limit or
content filter unless explicitly configured. The \"null error handler\"
observation suggests the production logger configuration does not have a
structured handler attached, which is why the per-message content lands
as a raw string rather than as a level-tagged structured event.

4. Required fix
---------------

### 4.1 Option A --- set LoggingFeature limit=0 (recommended)

Configure the LoggingFeature bean to suppress payload output entirely:

\<bean class=\"org.apache.cxf.ext.logging.LoggingFeature\"\>\
\<property name=\"limit\" value=\"0\"/\>\
\<property name=\"logBinary\" value=\"false\"/\>\
\<property name=\"verbose\" value=\"false\"/\>\
\</bean\>

limit=0 disables payload capture; the interceptor still records that a
SOAP call occurred but writes no envelope content. Operational
visibility (call count, endpoints exercised) is retained.

### 4.2 Option B --- remove LoggingFeature from production

Remove the LoggingFeature bean from the production Spring/CXF
configuration. SOAP calls continue to function; observability is
delegated to higher-level mechanisms (APM, structured application logs).

### 4.3 Option C --- structured logger reconfiguration

Wire a structured logger to the CXF logging output, attach a JSON
handler with field extraction, and configure log.level explicitly. This
both fixes the \"null handler\" pattern (messages now carry log.level)
and lets platform-side filtering selectively drop verbose payloads at
the ingest pipeline. More engineering effort than Options A or B; only
recommended if Genius needs SOAP payloads retained for debug and is
willing to filter on structured fields.

5. Validation method
--------------------

Post-fix validation, 24h after deployment:

POST .ds-logs-genius.app-eu\_pos\_genius\_backend\_prod-\*/\_search\
{ \"size\": 0,\
\"query\": { \"bool\": { \"must\": \[\
{ \"range\": { \"\@timestamp\": { \"gte\": \"now-24h\" } } },\
{ \"match\_phrase\": { \"message\": \"Envelope\" } }\
\] } } }

Closure criterion: 0 hits, or near-zero (a small residual is acceptable
from inbound payloads from upstream systems that may still log
envelopes).
