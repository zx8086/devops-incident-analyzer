# 4. Fleet & agent collection

Source: Elastic_Optimisation_Playbook_v12 §4 (reference content).

## §4.1 Philosophy

--------------

Every metric collected must justify its existence. Default Fleet
integrations collect far more than most estates need. Aggressive
curation of agent policies is the single largest lever for ingest-volume
reduction --- bigger than ILM, bigger than rollover tuning. Between the
us-cld aggressive downsize and the eu-cld Fleet trim, roughly 1.44B
docs/day of collection volume has been eliminated in this programme.

## §4.2 Per-integration tuning reference

------------------------------------

  **Integration**            **High-value defaults**                         **Cuts made**                                                                               **Typical saving**
  -------------------------- ----------------------------------------------- ------------------------------------------------------------------------------------------- ---------------------------------------------
  system                     cpu, memory, filesystem, network                Disable system.core on non-container hosts; drop process.* unless explicitly needed 3      0--40% of system docs
  system.process (ongoing)   Top processes per host, configurable interval   Interval 10s → 300s + drop-processor filters for idle / loopback / partition noise (§4.4)   Additional 40--60% on process metrics alone
  windows                    Basic service health                            Service collection whitelist (only critical services, not every installed service)          60--80% of windows docs
  vSphere                    Host + VM CPU/memory/disk                       Raise collection interval 20s → 120s; drop perfmon counters on non-prod                     70%+ of vSphere docs
  Kubernetes                 Node metrics, container counts                  Drop container.labels unless used for routing; disable kubelet verbose                      15--25% of k8s docs
  Self-monitoring            Agent health only                               Disable OS-level self-monitoring on staging clusters entirely                               5--10% total docs on those clusters
  perfmon                    Process, Memory, Disk                           Remove Process counter on all non-app hosts                                                 40%+ of perfmon docs

## §4.3 Agent policy change workflow

--------------------------------

-   Draft the policy change in Fleet UI → review the diff with a cluster
    owner before saving.

-   Apply to a pilot group (5--10 agents) tagged via agent tag, not the
    full policy scope.

-   Watch ingest rate in Stack Monitoring for 60 min; confirm no
    alerting gaps opened up.

-   Roll out to full policy scope; monitor for 24h.

-   Document the change in the cluster's session handover.

## §4.4 Sub-procedure: system.process metric tuning
_Promoted to skill `skills/systemprocess-metric-tuning/`._

## §4.4.1 Interval bump

-   Raise system.process period from default 10s → 300s for
    host-observability policies (not application-metrics policies where
    short-interval process signal matters).

-   Net effect: 30× reduction in docs/host-hour with no loss of
    visibility for 5-minute-granularity dashboards.

## §4.4.2 Drop processor filter (Fleet → integration policy → Advanced → processors)

\- drop_event:
    when:
    or:
    - equals: { process.name: "System Idle Process" }
    - equals: { process.name: "svchost.exe" }
    - regexp: { process.name:
    "\^(kworker\|ksoftirqd\|migration\|rcu_).*" }
    - range: { system.process.cpu.total.pct: { lt: 0.001 } } # drop
    near-zero-CPU processes
    - equals: { process.args: "" } # drop kernel threads

-   The range filter on cpu.total.pct \< 0.001 removes the idle-process
    floor that drives most volume.

-   Test on a single host first (tag-scoped) --- bad filters can silence
    every process except PID 1.

-   Dashboards that depend on a full process inventory must be updated
    to query a longer time window or re-enable the integration on a
    small dedicated policy.

## §4.5 Sub-procedure: Clock-skew ingest pipeline (\@custom) pinning
_Promoted to skill `skills/clock-skew-ingest-pipeline-custom-pinning/`._

## §4.6 Common mistakes

-------------------

-   Disabling an integration globally when only one host was the
    problem. Use tag-based scoping.

-   Dropping fields the Kibana dashboards depend on --- check dashboards
    before removing fields.

-   Not verifying that logs-agent.* itself is still flowing after the
    change --- a mis-edit can silence the agent's own telemetry.

