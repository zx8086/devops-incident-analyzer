# 5. Application instrumentation

Source: Elastic_Optimisation_Playbook_v12 §5 (reference content).

## §5.1 OTel SDK / Java auto-instrumentation

----------------------------------------

-   JDBC auto-instrumentation on Java apps creates a span per SQL
    statement --- on ts-utils this alone was 25--30% of total eu-cld
    transaction volume. Disable via
    OTEL_INSTRUMENTATION_JDBC_ENABLED=false for services where DB
    calls are not the user-facing unit of work.

-   DB2 auto-instrumentation exploded on one service and produced 1.2B
    spans/day before being disabled. Result after fix: 99.5% reduction.

-   HTTP client spans are usually high-value; do not disable those by
    default.

## §5.2 Boomi / EDI logging levels

------------------------------

-   Boomi EDI Molecule defaults to INFO-level process step logging,
    which produces 10--20× the docs of the actual EDI payload. Move to
    WARN for prod; keep INFO in dev.

-   Per-step timing metrics are useful but should be sampled (1-in-N)
    not logged for every execution.

## §5.3 GK PoS application-tier chatter reduction

---------------------------------------------

Pattern: the GK point-of-sale estate (1,089 tills across EU retail)
emits three high-volume, low-value log classes that together dominate
the retail-till ingest budget.

  **Chatter class**                                       **What it is**                                                                                 **Reduction approach**
  ------------------------------------------------------- ---------------------------------------------------------------------------------------------- -------------------------------------------------------------------------------
  ProcessExecutionServiceImpl DEBUG                       Per-transaction DEBUG logs from the core PoS execution service --- one record per order line   Raise log level to WARN on production till images; keep DEBUG in staging only
  LoginManager session-rotation logs                      INFO-level logs on every shift login/logout --- amplified by rapid manager-override flows      Sample 1-in-10 via log4j filter; preserve auth-failure events at 100%
  IMessageProvider 'no listener registered' warnings Ha   rmless warnings emitted every poll when a store has no active subscriber Su                    ppress via log4j package-level filter; these carry no operational signal

-   Coordinate the log4j config change with the till image owner ---
    till images are rebuilt on a fortnightly cadence, so the fix lands
    on all 1,089 tills over two weeks, not overnight.

-   Keep a monitoring data view on tills still running the old image;
    ingest volume per till is a reliable proxy for 'old image still
    deployed'.

-   Separately, the cleartext session-token issue (documented in the
    issue register) is a P1 security/privacy item --- do not confuse it
    with the chatter reduction work.

## §5.4 APM sampling

----------------

-   Head-based sampling at 10% is a safe default for high-volume
    services. Combine with tail-based sampling of errors to keep the
    ones that matter.

-   Drop RUM sessions from bots by checking user-agent in the APM ingest
    pipeline --- bot traffic is often 40%+ of RUM volume and adds no
    product insight.

## §5.5 Service onboarding gate

---------------------------

Any new service wanting to send APM or logs to production must complete
this gate:

-   Declared peak docs/day estimate signed off by product owner.

-   Log level set to WARN or higher for prod (INFO only on explicit
    exception).

-   APM sample rate set (not default). 100% sampling requires written
    justification.

-   No unbounded high-cardinality fields (user_id as a term, etc.)
    without tokenization.

-   Retention requirement stated --- cold and frozen min_age derive
    from this.

