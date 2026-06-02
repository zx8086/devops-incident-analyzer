# 9. Validation checklists

Source: Elastic_Optimisation_Playbook_v12 §9 (reference content).

## §9.1 After an ILM policy change

------------------------------

-   GET _ilm/policy/ --- confirm phases match intent.

-   GET _ilm/explain/ --- confirm target indices picked up new phases.

-   Watch phase transitions for 24--48h --- any errors in step_info
    field?

-   Cluster health stays green.

-   Ingest rate unchanged (±5%) --- if it dropped, a stream may have
    stopped being written.

## §9.2 After a Fleet agent policy change

-------------------------------------

-   Agent status --- all agents report Healthy within 10 min.

-   Ingest rate drops by expected amount ± 15%.

-   Target integration's own docs still flowing (e.g. logs-agent.* for
    agent health itself).

-   Check 3--5 Kibana dashboards that depend on the affected data ---
    still populating.

-   Alerts on the affected dataset: any newly quiet alerts that
    shouldn't be?

## §9.3 After a plan change

-----------------------

-   Cluster health green within 30 min of plan completion.

-   All nodes reporting; no nodes missing.

-   Shard allocation complete --- GET
    _cluster/health?wait_for_no_relocating_shards=true.

-   ML jobs reopened (if manually closed per §7.1.2).

-   Monitoring data from the cluster to monitoring cluster still
    flowing.

## §9.4 After a cold-tier/frozen migration

--------------------------------------

-   Searchable snapshot status green: GET
    _snapshot/found-snapshots/_status.

-   Target tier disk usage trending down within 4h.

-   Source tier shard count reducing.

-   Spot-check a query on migrated data --- returns results (cache miss
    is acceptable, error is not).

## §9.5 After a logsdb / synthetic source mode change

-------------------------------------------------

-   GET _index_template/\<override-name\> --- confirm the override
    exists and is at expected priority.

-   Force or wait for one rollover on the affected dataset; verify the
    new backing index has the new mode: GET \<new-index\>/_settings.

-   Spot-check a query on the new index --- results return as expected.

-   Compare disk size on next forcemerge between an old (stored /
    standard mode) and new (synthetic / logsdb) index of the same stream
    --- confirm savings.

## §9.6 After a reroute pipeline change

-----------------------------------

-   GET _ingest/pipeline/\<consolidate-pipeline\> --- verify pipeline
    definition.

-   POST _ingest/pipeline/\<name\>/_simulate with a representative
    document --- confirm the document is rerouted to the expected
    destination index and fields are populated.

-   After wiring \@custom, watch for the new consolidated stream to
    appear in _data_stream within \~10 minutes.

-   Spot-check Kibana dashboards filtering on the affected dimension ---
    confirm queries either continue to work or have been migrated to the
    new field.

