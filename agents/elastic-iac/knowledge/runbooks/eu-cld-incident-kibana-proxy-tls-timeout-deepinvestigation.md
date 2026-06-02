**eu-cld Incident Investigation**

*Kibana proxy TLS handshake timeout on .kibana\_9.2.3 saved-object
reads*

Cluster eu-cld (eda974 / 3935ab4a0d944f778c09ad1e1053c8e0) · Snapshot 6
May 2026 · Live data via Elasticsearch MCP and Cloud UI screenshots

1\. Executive summary

The Kibana 429/TLS-handshake-timeout error reported on
.kibana\_9.2.3/\_doc/space:default is not a cluster-state event. The
Elasticsearch cluster is GREEN, with 0 unassigned shards and 0 pending
tasks at snapshot. The error originates at the Elastic Cloud proxy layer
when an upstream Coordinating/Ingest instance is unable to complete TLS
handshake within the proxy\'s budget --- typically because the instance
is in an old-GC pause or is otherwise saturated.

Cross-checking against the AutoOps and Cloud UI screenshots and the live
MCP queries collected during this session, the bottleneck is
concentrated on the Coordinating/Ingest tier and on the Kibana tier,
both of which are sized at 4 GB per zone (12 GB total each across three
zones). Two of the three Coordinating instances (\#97, \#99) are flagged
Unhealthy in the Cloud UI; one Kibana instance (\#31) is also Unhealthy.
The TLS handshake timeout reproduced three times during this very
investigation against three different upstream IPs (10.11.155.234,
10.11.133.64, 10.11.160.54) --- confirming that the Cloud proxy is
rotating across multiple stalled instances, not a single stuck node.

The fix has two parts: (a) restart the unhealthy instances now to clear
the immediate symptom; (b) raise the Coordinating/Ingest and Kibana
tiers one step in the UI dropdown --- 4 GB → 8 GB per zone for both. The
cluster has just enough cost headroom: the deployment is currently
\$41.0132/hr (down from earlier reference points), and the two upgrades
together add roughly \$1.50/hr. Underlying structural pressure on the
coord tier comes from the cluster\'s 26,297-index footprint and the
18,990 Fleet agents check-pointing through it; these are addressed by
the existing Phase 1/2 work and are not blockers for the immediate fix.

2\. Symptom and what the error decodes to

The error returned to the user when opening Kibana:

{\"statusCode\":429,\"error\":\"Too Many
Requests\",\"message\":\"\[{\\\"ok\\\":false,\\\"message\\\":\\\"TLS
handshake timeout: Get
\\\\\\\"https://10.11.155.234:18992/.kibana\_9.2.3/\_doc/space%3Adefault\\\\\\\":
net/http: TLS handshake timeout\\\"}\]: undefined\"}

Decoded:

-   statusCode 429 is synthesised by the Elastic Cloud proxy; it is not
    produced by Elasticsearch. The proxy uses 429 to signal that an
    upstream did not return in time and the request was queued/shed.

-   The embedded message is the actual root cause: a TLS handshake
    timeout to https://10.11.155.234:18992/. Port 18992 is an Elastic
    Cloud allocator-routed proxy port that maps to a specific
    Elasticsearch instance.

-   .kibana\_9.2.3/\_doc/space:default is the Kibana saved-objects
    request fired on virtually every Kibana page navigation. So every
    user navigating Kibana while a coord instance is mid-pause has a
    non-zero chance of seeing this error.

-   TLS handshake timeout (not connect timeout) means the TCP socket
    opened, but the upstream did not return ServerHello in time. That is
    consistent with a Java GC pause or Node.js event-loop stall on the
    upstream --- not with the network being broken.

3\. Live cluster state at snapshot

Pulled directly from the eu-cld cluster via Elasticsearch MCP:

  -------------------------- ---------------------------------- -------------------------------------------------------------------------------
  **Metric**                 **Value**                          **Notes**
  Cluster status             green                              0 unassigned, 0 initializing, 1 relocating
  Cluster UUID               iRNfcns8S6-Qp4UtXc838w             Confirms eda974 / eu-cld
  Cluster name               3935ab4a0d944f778c09ad1e1053c8e0   ES Internal name
  Number of nodes            19                                 12 data + 3 master + 3 coord/ingest + 1 ML
  Active primary shards      26,394                             
  Active total shards        28,602                             Replication factor 0.083
  Indices count              26,297                             Above any healthy ceiling --- drives cluster-state size
  Total documents            230,579,158,812                    
  Local store size           4,596 GB                           Hot/Warm/Cold local disks
  Pending tasks (snapshot)   0                                  But AutoOps shows bursts of High Cluster Pending Tasks across the 24 h window
  In-flight fetch            0                                  
  Self-monitoring indices    0 found                            Stack Monitoring is OFF --- AutoOps is the only time-series source
  -------------------------- ---------------------------------- -------------------------------------------------------------------------------

4\. Validating the Cloud UI screenshots

Each row of the Hosted overview screenshot was reconciled against the
live MCP node-stats response. Highlights --- instances flagged Unhealthy
in the UI are flagged here in red, post-GC JVM pressure values come from
the UI, raw heap\_used\_percent comes from the MCP \_nodes/stats
response.

4.1 Coordinating / Ingest tier --- the immediate bottleneck

Three instances at 4 GB RAM each (\~2 GB heap), AWS m6gd, sized at \'Up
to 4.2 vCPU\' per the Edit screen. All Kibana saved-object reads, Fleet
checkpoints, bulk ingest, enrich coordinate lookups and CCS routing pass
through this tier.

  -------------- ---------- --------------------- -------------------------------- ------------------------------------ ------------------------- ------------
  **Instance**   **Zone**   **Cloud UI status**   **JVM pressure (UI, post-GC)**   **Live heap\_used\_percent (MCP)**   **Old-GC count / time**   **Uptime**
  **\#97**       1a         **Unhealthy**         60%                              75%                                  9 collections             31 h
  \#122          1b         Healthy               70%                              53%                                  11 collections            31 h
  **\#99**       1c         **Unhealthy**         40%                              69%                                  4 collections             31 h
  -------------- ---------- --------------------- -------------------------------- ------------------------------------ ------------------------- ------------

Three points worth flagging:

-   All three coord instances restarted \~31 hours before snapshot ---
    uptime is identical. That maps to either a rolling restart
    (allocator move, plan change) or an autoscaling event on this tier
    \~31 h ago. The Cloud Console activity feed will confirm which.

-   The post-GC JVM pressure in the UI is the better steady-state
    indicator. Coord \#122 at 70% post-GC is the most pressured of the
    three and is the one currently \'Healthy\' --- but heading the same
    way \#97 and \#99 have already gone.

-   Combined old-GC count is 24 collections in 31 h. A coord instance
    with healthy load shows zero or one old GC over a similar window. 24
    across three nodes is an indicator of sustained heap pressure.

4.2 Kibana tier

Three Kibana instances at 4 GB RAM each (Up to 8.5 vCPU), AWS c6gd. All
saved-object reads originate from one of these processes.

  -------------- ---------- --------------------- ---------------------------------
  **Instance**   **Zone**   **Cloud UI status**   **Native memory pressure (UI)**
  \#32           1a         Healthy               19%
  **\#31**       1b         **Unhealthy**         21%
  \#33           1c         Healthy               18%
  -------------- ---------- --------------------- ---------------------------------

Kibana \#31 being Unhealthy means the Node.js event loop on that
instance is stalled. When a user\'s session is sticky to \#31, every
saved-object read it issues to ES will time out. Because the Cloud proxy
round-robins users across Kibana instances, this is one of the three
sources of \'sometimes the page loads, sometimes it 429s\' reported in
the symptom.

4.3 Master tier

  -------------- ---------- --------------------- ----------------------- ------------------------------ ------------------------- ------------
  **Instance**   **Zone**   **Cloud UI status**   **JVM pressure (UI)**   **Live heap\_used\_percent**   **Old-GC count / time**   **Uptime**
  \#132          1a         Healthy               18%                     23%                            0 collections             1,466 h
  \#102          1b         Healthy               28%                     61%                            15 collections            2,718 h
  \#88           1c         Healthy               19%                     20%                            0 collections             2,718 h
  -------------- ---------- --------------------- ----------------------- ------------------------------ ------------------------- ------------

Master \#102 is the elected master; the JVM pressure delta and the 15
old-GC collections over 2,718 h are typical for an elected master
holding cluster state for 26,297 indices. AutoOps event \'Some
master-eligible nodes are more loaded than others\' (opened 26 minutes
before snapshot) maps directly to this --- 102 carries cluster-state
read traffic that 088 and 132 do not.

4.4 Hot, warm, cold, frozen --- for context

All four data tiers are healthy and not contributing to the immediate
Kibana TLS issue. .kibana\_9.2.3 and .fleet-\* shards are all on the
three hot data nodes (\#144 / \#145 / \#146). Hot \#144 is at 69% live
heap (highest among data nodes) but it is not in the request path that
produces the TLS error --- Kibana goes through a coord first.

  ---------- ------------------------- -------------- --------------------- --------------- ---------------------------------------
  **Tier**   **Nodes (instance \#)**   **JVM (UI)**   **System mem (UI)**   **Disk used**   **Notes**
  Hot        144 / 146 / 145           44%            62%                   1.79 TB (36%)   60 GB RAM each, hosts .kibana\_9.2.3
  Warm       164 / 147 / 153           40%            61%                   1.21 TB (37%)   15 GB RAM, LIMIT REACHED at min size
  Cold       159 / 158 / 160           48%            **98%**               1.53 TB (47%)   15 GB RAM, system memory at threshold
  Frozen     168 / 169 / 170           34%            57%                   12.72 TB        60 GB RAM, S3-backed
  ---------- ------------------------- -------------- --------------------- --------------- ---------------------------------------

Cold tier System Memory at 98% is a separate flag worth investigating
but it does not produce the Kibana 429 --- Kibana saved-object reads do
not transit the cold tier. The cold tier\'s 98% is page cache / OS
memory, expected in steady state on i3en hardware, but worth a closer
read since it is at threshold.

5\. Reproduction during this investigation

The TLS handshake timeout reproduced three times during this MCP session
against three distinct upstream IPs and ports. This is direct evidence
that the Cloud proxy is rotating across multiple stalled upstreams, and
that the user-reported error is not a one-off.

  ------------------------- ---------------------------------- ---------------------- -----------------------
  **Time (UTC, approx)**    **MCP call that failed**           **Upstream IP:port**   **Decoded message**
  ≈ original error          Kibana page load (saved-objects)   10.11.155.234:18992    TLS handshake timeout
  This session, attempt 1   \_search on .monitoring-kibana\*   10.11.133.64:18899     TLS handshake timeout
  This session, attempt 2   \_nodes/stats?metric=ingest        10.11.160.54:18639     TLS handshake timeout
  ------------------------- ---------------------------------- ---------------------- -----------------------

Three different IPs in the 10.11.x range with three different proxy
ports indicates that the proxy targeted different coord/Kibana instances
on each attempt. This rules out a single stuck pod and matches the
Cloud-UI reading of \#97 and \#99 both being Unhealthy at the same time.

6\. Root cause

The Coordinating/Ingest tier is undersized for the work it now carries.
Specifically:

1.  18,990 Fleet agents are registered (.fleet-agents-7 primary at 75
    MB, 18,990 documents). Default agent check-in is every 30 s, which
    is approximately 633 check-ins per second routing through three
    coord instances.

2.  A long-running indices:monitor/fleet/global\_checkpoints task
    captured at 137.8 s on a coord instance during this session ---
    these tasks are how Fleet syncs agent visibility and they queue
    requests behind them.

3.  Kibana\'s saved-object reads (every navigation reads
    .kibana\_9.2.3/\_doc/space:default plus several other saved-object
    documents). Cluster state size is amplified by the 26,297-index
    footprint, so each saved-object call carries more cluster-state
    overhead than usual.

4.  Kibana alerting rules (observability.rules.custom\_threshold)
    hitting the bulk write path on hot every \~640 ms via a coord
    instance.

5.  xpack/enrich/coordinate\_lookups repeating \~700 ms each --- these
    run on coord.

6.  Cross-cluster search routing for queries against eu-b2b / ap-cld /
    us-cld --- also on coord.

Each coord instance is sized at 4 GB RAM (\~2 GB heap). Two of three are
Unhealthy; the third is at 70% post-GC pressure. Old-GC pauses on these
small heaps are long enough relative to the Cloud proxy\'s TLS handshake
budget to cause the proxy to give up and synthesise the 429 the user
sees.

Kibana \#31 being independently Unhealthy is a parallel failure mode:
when Kibana\'s own Node.js event loop is stalled, the saved-object
request never reaches ES at all and the proxy reports the same TLS
handshake error against the Kibana port range.

7\. Why it is intermittent (not a hard failure)

Three observations explain the on-and-off pattern:

-   Pending tasks at snapshot are 0, but AutoOps \'High Cluster Pending
    Tasks\' shows red bars across multiple non-contiguous hours of the
    past 24 h. Pending tasks come in bursts of 30--120 s and clear. Each
    burst corresponds to a coord/master pause window.

-   Fleet checkpoint tasks captured at 137.8 s when run during the
    burst; an explicit \_tasks query later in this session (against the
    same action filters) returned empty --- meaning the burst had
    cleared and a new one had not yet started.

-   Cloud proxy rotates across coord/Kibana instances. A user request
    whose round-robin lands on \#97 or \#99 during a pause window sees
    the 429; a user whose request lands on \#122 during a quiet moment
    sees the page load normally.

8\. Fix plan

8.1 Immediate (today)

  ---------- ------------------------------------------- -------------------------------------------------------------------------- -------------------------------------------------------------------------------------------------------------------
  **Step**   **Action**                                  **Where**                                                                  **Expected effect**
  1          Restart Kibana                              Cloud Console → eu-cld → Manage deployment → Restart Kibana                Clears event-loop saturation on \#31; resets pooled connections to coord. Symptom usually stops within \~5 min.
  2          Restart Coordinating/Ingest \#97 and \#99   Cloud Console → eu-cld → Hosted → Instance \#97 → Restart; same for \#99   Clears the Unhealthy state on those two instances. Triggers proxy to re-route while they restart (one at a time).
  3          Verify the Unhealthy banner clears          Cloud Console → eu-cld → Hosted overview                                   All three coord and all three Kibana instances back to Healthy.
  ---------- ------------------------------------------- -------------------------------------------------------------------------- -------------------------------------------------------------------------------------------------------------------

8.2 Short-term sizing change (this week, single-step in UI)

Two tier upgrades, each one step up in the Edit-screen dropdown. These
are the highest-leverage corrections and they address the structural
cause.

  --------------------- ----------------------- ----------------------- ---------------------- ------------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Tier**              **Current per zone**    **Target per zone**     **Total RAM change**   **vCPU change**           **Why**
  Coordinating/Ingest   4 GB / Up to 4.2 vCPU   8 GB / Up to 8.5 vCPU   12 GB → 24 GB          Up to 12.6 → Up to 25.5   Doubles heap on the tier that handles 100% of Kibana saved-object reads, Fleet check-ins and CCS. Eliminates the GC-pause path that produces the TLS handshake timeout.
  Kibana                4 GB / Up to 8.5 vCPU   8 GB / Up to 8.5 vCPU   12 GB → 24 GB          Up to 25.5 → Up to 25.5   Doubles Node.js heap on the process that issues the saved-object reads. Required given the 26,297-index cluster-state size.
  --------------------- ----------------------- ----------------------- ---------------------- ------------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

Important: Coordinating/Ingest is not autoscaling-enabled in the Edit
screen, so the resize is a single dropdown change. Kibana is the same.
Both are configured for 3 zones already; the resize replaces all three
instances per tier in a rolling fashion.

Cost impact: roughly +\$1.10/hr for the Coordinating/Ingest bump and
+\$0.50/hr for the Kibana bump (linear with RAM doubling on the same
instance family). Total run rate moves from \$41.0132/hr to \~\$42.61/hr
--- a 3.9% increase that addresses the user-visible Kibana failures and
removes a recurring incident driver.

8.3 Structural (already in the May 5 plan)

The cluster\'s 26,297-index footprint amplifies coord pressure because
every saved-object read pulls cluster state. The May 5 fix plan already
prescribes the structural answers; doing them after the sizing change
reduces the chance the same problem recurs as ingest grows.

  ---------- ------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Step**   **Action**                                                                **Effect on Kibana TLS issue**
  A          Phase 1A: delete confirmed-empty dev/stg data streams                     Removes thousands of empty cluster-state entries. Reduces saved-object read overhead and master cluster\_state size.
  B          Phase 1B: route dev/stg streams to nonprod ILM (30 d)                     Cuts retention in half on dev/stg, which compounds the index reduction.
  C          Phase 2A: add min\_primary\_shard\_size to the three heavy ILM policies   Stops further sprawl. Indices grow to ≥1 GB or rollover only weekly when sparse, which reduces the long-term coord load.
  D          Re-enable Stack Monitoring                                                Currently zero monitoring indices on this cluster. AutoOps is the only history we have. Re-enabling gives us per-instance event-loop and heap time series for the next investigation.
  ---------- ------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

8.4 Separate tickets to keep in mind

  ------------------------------------------------------------ ------------ --------------------------------------------------------------------------------------------------------------------
  **Item**                                                     **Status**   **Action**
  Cold tier System Memory at 98%                               Open         Investigate page-cache vs working-set on i3en cold nodes \#158/159/160. Likely steady-state but at threshold.
  Master imbalance event (26 min before snapshot)              Open         Confirm whether elected master is rotating off \#102 periodically. Persistent task assignment can pin master load.
  Why coord \#97/\#99/\#122 restarted \~31 h before snapshot   Open         Check Cloud Console activity feed to determine whether autoscaling, plan change, or allocator move.
  ------------------------------------------------------------ ------------ --------------------------------------------------------------------------------------------------------------------

9\. Validation queries to run after each change

After Step 1 (Kibana restart):

GET \_cat/health?v GET \_cluster/pending\_tasks \# Check Cloud UI: all
three Kibana instances should be Healthy within 5 min

After Step 2 (coord restarts):

GET
\_nodes/stats/jvm?filter\_path=nodes.\*.name,nodes.\*.jvm.mem.heap\_used\_percent
\# All three coord instances should report Healthy in Cloud UI;
heap\_used\_percent \<70%

After Step 8.2 sizing change (tier resize):

GET
\_nodes/stats/jvm,thread\_pool?filter\_path=nodes.\*.name,nodes.\*.jvm.mem.heap\_used\_percent,nodes.\*.thread\_pool.search.queue,nodes.\*.thread\_pool.write.queue,nodes.\*.thread\_pool.search.rejected
\# Expect post-GC JVM pressure on coord \<50%, no rejections, no queue
accumulation

Synthetic check (reproduce the Kibana saved-object call directly):

GET .kibana\_9.2.3/\_doc/space:default \# Should return 200 with the
saved-object document. Run from the Kibana Dev Tools (which routes via
the same proxy).

10\. Risk and rollback

-   Restarts (Step 1, 2): rolling, one instance at a time, no data loss.
    Cloud Console operation.

-   Tier resize (8.2): rolling. Each tier replaces all three instances
    in sequence. Read availability is preserved through the resize
    because the tier remains 3-zone. Estimated wall-clock for both tier
    resizes: 30--45 min.

-   Rollback for sizing: revert the dropdown to 4 GB and re-apply. Cloud
    Console handles the rolling downgrade. No data is at risk.

-   If post-resize the issue persists: the next layer to look at is hot
    \#144\'s heap (currently 69%) and master \#102\'s cluster-state read
    traffic. Both are addressable through the Phase 1/2 cluster-state
    cleanup, not through further sizing.

11\. Suggested order of operations

7.  Restart Kibana (≤5 min).

8.  Restart Coordinating/Ingest \#97 and \#99 one at a time (≤10 min
    total).

9.  Verify all instances Healthy in Cloud UI.

10. Pull the Cloud Console activity feed for the past 31 h and confirm
    the cause of the coord restart that gave us the 31 h uptime
    synchronisation.

11. Apply the Coord/Ingest 4 GB → 8 GB resize.

12. Apply the Kibana 4 GB → 8 GB resize (can be done in same plan change
    as the coord resize).

13. Run validation queries from section 9. Confirm post-GC JVM pressure
    on coord \<50% and no thread-pool rejections.

14. Re-enable Stack Monitoring so the next investigation has time-series
    data.

15. Schedule Phase 1 cleanup and Phase 2 ILM tuning per the May 5 plan.

*Cluster: eu-cld · UUID iRNfcns8S6-Qp4UtXc838w · Investigation date 6
May 2026 · Live data via Elasticsearch MCP plus Cloud UI screenshots ·
Stand-alone document, not a delta against prior reports.*
