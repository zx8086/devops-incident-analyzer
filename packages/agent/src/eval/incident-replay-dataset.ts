// packages/agent/src/eval/incident-replay-dataset.ts
//
// Replaces the earlier 10-entry ad-hoc dataset. All 32 entries below are derived from real,
// human-curated incident tickets in Jira epic DEVOPS-1354 ("Agentic Investigations"), the set
// the user identified as good-enough-quality baselines -- generated under the pre-SIO-1367
// ("reverted") sub-agent model config. Ground truth (expectedDatasources, qualityRubric) is
// derived from each ticket's own Executive Summary / Correlated Timeline / Findings sections.
//
// Query recovery: each ticket's ORIGINAL verbatim query was cross-referenced against the Agent
// Memory service (curated kg-incident blocks, `fact` field format "Incident <id>: <query> (curated
// via DEVOPS-XXXX)"), matched by that trailing "(curated via DEVOPS-XXXX)" tag, NOT by the loose
// `annotations.ticket` field on the memory block -- an earlier attempt trusted `annotations.ticket`
// and produced several wrong-ticket matches (fixed after cross-checking every entry's query text
// against each ticket's own re-fetched description). 13 of 32 tickets had a directly matching,
// unambiguous memory block (marked VERBATIM below, using Agent Memory's own stored text, which is
// itself truncated to ~350 chars at the source -- that is the genuine stored content, not a
// truncation added here); 1 more (DEVOPS-1391) had no Agent Memory match but its full ticket
// content was already in hand (marked VERBATIM-adjacent). The remaining 18 tickets had no
// recoverable original-query memory block after exhausting reasonable search angles (marked
// RECONSTRUCTED below): their query is built from the exact error string/exception message quoted
// in the ticket's own description, in the same "Investigate this error" phrasing style real users
// submit, but is NOT a verbatim capture of what was actually typed.
//
// Same rubric-grading constraint as dataset.ts (SIO-692): the judge sees only the final response
// string, never tool-call trajectory, so qualityRubric clauses must be response-content checks.
//
// uiSelectedDataSources/uiSelectedElasticDeployments/uiSelectedAwsEstates are set on every entry
// to match the real DataSourceSelector UI state for that incident (all 6 non-Konnect sources,
// Elastic deployment eu-b2b, and the AWS estate(s) the incident actually spanned -- most often
// eu-oit-prd and/or eu-shared-services-prd, with eu-ediservices-prd for the Boomi incident and
// eu-mendix-platform-prd for the Mendix ones) -- these all came from
// PVH/Tommy Hilfiger production services in that same estate/deployment family. Without these
// fields, run-function.ts falls through to targetDataSources/targetDeployments/uiAwsEstates: []
// (free entity extraction, nothing pinned), which is NOT how a real user drives this UI and was
// the root cause of an early run's high "aws missing" datasources_covered failure rate -- that
// result reflected an eval-harness fidelity gap, not a genuine model/scoping defect.

import type { EvalExample } from "./dataset.ts";

export const INCIDENT_REPLAY_DATASET: EvalExample[] = [
	{
		// DEVOPS-1353 -- RECONSTRUCTED. Prior Couchbase connectivity incident on styles-v3,
		// same endpoint later recurring in DEVOPS-1407/1412/1413. Root-caused (per ticket) to an
		// ECS security-group missing from the Capella private endpoint's inbound allowlist.
		inputs: {
			query:
				'Investigate the "pvh-services-styles-v3" service for this error:\n\ncom.couchbase.client.core.endpoint.BaseEndpoint$2 exception, source IP 10.0.0.61, connecting to private-endpoint.xxxxxxxxxxxxxxxx.cloud.couchbase.com -- connection refused/failed at the network layer.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "aws", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should identify this as a client-side network/connectivity failure (BaseEndpoint exception) rather than a Couchbase server-side fault, and should check whether the Couchbase cluster itself reports healthy. Response should investigate the AWS security-group configuration for the ECS service and note whether it is present in the Capella private endpoint's inbound allowlist as a candidate root cause. Response should check Atlassian for prior related incidents on the same endpoint/service. Response should include a Gaps section if the exact allowlist state could not be directly confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1353): pvh-services-styles-v3 is throwing com.couchbase.client.core.endpoint.BaseEndpoint$2 exceptions exclusively for this service while all other services connecting to Couchbase remain healthy. The Couchbase cluster itself is fully healthy (12/12 nodes healthy, zero fatal N1QL requests, low CPU and memory pressure). The Kafka pipeline feeding Couchbase is at zero lag with empty DLQs. No code changes have been deployed since 2026-05-05, ruling out a code regression. The primary root cause hypothesis, supported by AWS evidence, is that the ECS security group sg-0aaaaaaaaaaaaaaaa (styles-v3-service-ecs-sg) has never been added to the inbound allowlist of the Couchbase Capella private endpoint's security group. This is a network-layer block specific to this service's dedicated SG. Secondary hypotheses are a stale or rotated SSM credential and a TLS certificate mismatch from the hardcoded certs/capella.pem in the container image. Root cause confidence: 0.72 (SG allowlist gap ranked highest at 0.82). Elastic agent failed on both invocations in the real investigation, so the full exception stack trace and error-rate distribution were gaps in the original report.",
			referenceFindings: {
				couchbase:
					"Cluster is not the source of the problem: all 12 nodes healthy, fatal request count zero, both N1QL query nodes have empty queues, CPU and memory well within normal bounds -- the BaseEndpoint$2 exception is thrown client-side by the Couchbase Java SDK when it cannot establish/maintain a TCP/TLS connection, and the cluster accepts connections from all other services without issue.",
				aws: "Security group sg-0ac93a0b035d94b63 (styles-v3-service-ecs-sg) has no inbound rules for Couchbase ports (11207, 18093, 18094, 18095, 18096); the Capella private endpoint's own security group controls which source SGs may connect inbound, and if this SG is not allowlisted there, all TCP connections from this service to Couchbase are refused at the network layer -- exactly the BaseEndpoint$2 pattern. Other services use different SGs that are already permitted. Zero CloudWatch alarms exist for this service.",
				atlassian:
					"Zero prior Jira incidents for pvh-services-styles-v3 in the last 30 days, and no matching runbook found for this service or the BaseEndpoint exception pattern -- either a first-occurrence failure mode or the service has not previously been tracked under this label.",
			},
		},
	},
	{
		// DEVOPS-1355 -- RECONSTRUCTED. MSK Kafka controller-election storm disrupting ksqlDB;
		// secondary GitLab MR added noisy error-level logging that amplified visible errors.
		inputs: {
			query:
				"Investigate ksqlDB errors -- all 31 persistent queries reporting UNRESPONSIVE/RUNNING mixed status, seeing LEADER_NOT_AVAILABLE and NOT_CONTROLLER errors on the ksql-service cluster.",
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["kafka", "aws", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should identify an MSK controller-election storm (ActiveControllerCount reporting more than 1, e.g. 5) as the root cause rather than a ksqlDB application fault, and should check AWS CloudWatch Kafka metrics (ActiveControllerCount, broker traffic) to confirm. Response should check whether the ksqlDB ECS containers themselves remained healthy throughout (ruling out a container-layer cause). Response should check GitLab for a recent change adding error-level logging that could amplify the visible error signal during the instability window, and should distinguish this contributing/amplifying factor from the root cause. Response should confirm Couchbase is not in the incident path if it investigates it. Response should include a Gaps section if the exact trigger for the controller storm could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1355): The ksqlDB errors are caused by a 90-minute MSK Kafka controller election storm on cluster c72-shared-services-msk. From 13:00:00Z to 14:25:00Z, ActiveControllerCount reported 5 (healthy value: 1), meaning all brokers simultaneously asserted controller status, preventing stable partition leader election and causing ksqlDB's internal Kafka Streams state machines to receive LEADER_NOT_AVAILABLE and NOT_CONTROLLER errors across all 31 persistent queries. The storm was triggered by a traffic spike on Broker 3 (9.3 MB/s inbound, CPU 27.2%), which disrupted ZooKeeper sessions. The ksqlDB ECS containers themselves remained healthy throughout -- the failure is entirely at the MSK broker/ZooKeeper layer. A secondary contributing factor: GitLab MR !154 introduced log.error calls in ArticleConsumer.java for null Kafka records/payloads, amplifying the visible error signal during the instability window (tombstone/null-value messages trigger the new error paths). Couchbase Capella is healthy and not in the incident path. No CloudWatch alarm existed for ActiveControllerCount, so the storm generated no infrastructure-level alert. Confidence: 0.82.",
			referenceFindings: {
				kafka:
					"The ksqlDB REST coordinator is alive (RUNNING, version 7.2.1) but all 31 persistent queries report a uniform {RUNNING: 1, UNRESPONSIVE: 2} worker status matching the 3-replica configuration -- the direct application-layer manifestation of the MSK controller storm, since ksqlDB workers that cannot obtain stable partition metadata from MSK stop heartbeating and are marked UNRESPONSIVE across every pipeline domain.",
				aws: "ActiveControllerCount on c72-shared-services-msk reported 5 (healthy value: 1) from 13:00:00Z to 14:25:00Z, preceded by a Broker 3 inbound traffic spike of 9.3MB/s at 13:00:00Z (CPU 27.2%) consistent with a rebalance storm disrupting ZooKeeper sessions; the ksql-service ECS containers themselves stayed healthy throughout (CPU ~3%, memory ~6.9%, no stopped tasks), and no CloudWatch alarm exists for ActiveControllerCount, so the 90-minute storm generated no infrastructure-level alert.",
				gitlab:
					"MR !154 (merged 2026-05-26) added log.error calls in ArticleConsumer.java for null Kafka records and null ArticleDTO payloads; during the MSK instability window this amplifies the visible error signal because tombstone/null-value messages produced during the controller storm trigger the new error paths -- a secondary contributing factor, not the root cause.",
			},
		},
	},
	{
		// DEVOPS-1356 -- RECONSTRUCTED. Connectors Service degradation, 4.11% failure rate --
		// ALB health-check timeout loop (eu-oit-prd) plus SSL/TLS trust-chain failure to a webhook
		// callback endpoint (Kafka DLQ evidence), amplified by an OTel telemetry blind spot.
		inputs: {
			query:
				'Investigate the "connectors-service" -- Kong monitor showing a 4.11% failure rate (808 5xx errors) in the last hour. ECS tasks report healthStatus UNKNOWN. Need root cause.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["aws", "kafka", "couchbase"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should identify at least two concurrent failure mechanisms rather than a single root cause: an ALB health-check timeout loop on connectors-service ECS tasks in eu-oit-prd, and a distinct SSL/TLS handshake/trust-chain failure (e.g. PKIX path building failed) preventing webhook delivery, evidenced by Kafka DLQ accumulation. Response should check AWS ECS task health/CPU/memory to confirm tasks are not resource-exhausted despite failing health checks. Response should report Couchbase as healthy/not a contributing factor if investigated. Response should include a Gaps section noting any observability blind spot (e.g. missing Elasticsearch/APM telemetry for this service) that limited root-cause confidence.",
			referenceReport:
				"Executive Summary (DEVOPS-1356): The Connectors Service is experiencing a sustained 4.11% failure rate (808 5xx errors) driven by two concurrent failure mechanisms operating at different infrastructure layers. In eu-oit-prd, connectors-service ECS tasks have been cycling through an ALB health-check timeout loop since 06:44Z. All three running tasks report healthStatus UNKNOWN against the target group. The root cause is application-level: tasks start and run without resource exhaustion (CPU 3-6%, memory ~1.4%) but fail to respond to health checks on port 8080 within the ALB timeout; healthCheckGracePeriodSeconds is 0. In eu-shared-services-prd, connect-service (Kafka Connect REST API) has five tasks running continuously for 11+ days with CPU locked at ~37.7%, also healthStatus UNKNOWN, no CloudWatch alarms. At the application layer, Kafka DLQ evidence confirms an SSL/TLS trust chain failure: connectors-api cannot deliver webhook notifications to pim.byt.pvhcorp.com due to a javax.net.ssl.SSLHandshakeException (PKIX path building failed) -- the direct mechanism producing the 5xx responses. Over 3 million messages have been written to DLQ_T_NOTIFICATION_SUBSCRIPTION_UPDATE_EVENTS. Elasticsearch telemetry for connectors-api is absent because the OTel gateway collector has been dropping ~249,000 telemetry events/hour, creating a complete observability blind spot. Couchbase Capella is healthy and not a contributing factor. Confidence: 0.74.",
			referenceFindings: {
				aws: "In eu-oit-prd, connectors-service ECS tasks have cycled through an ALB health-check timeout loop since 06:44Z with all three tasks reporting healthStatus UNKNOWN against the target group, despite no resource exhaustion (CPU 2.96-6.51%, memory ~1.4%) and healthCheckGracePeriodSeconds: 0. In eu-shared-services-prd, connect-service has five tasks running 11+ days with CPU locked at ~37.7% and zero CloudWatch alarms configured.",
				kafka:
					"DLQ message evidence confirms a javax.net.ssl.SSLHandshakeException (PKIX path building failed) on outbound webhook delivery from connectors-api to pim.byt.pvhcorp.com/notifications/callback -- the JVM trust store cannot validate the target's TLS certificate. Over 3 million messages have been written to DLQ_T_NOTIFICATION_SUBSCRIPTION_UPDATE_EVENTS lifetime; the connectors-api consumer group itself has zero lag, so consumption is healthy and the failure is isolated to downstream webhook delivery.",
				couchbase:
					"Cluster is healthy and not a contributing factor: totalErrorCount 0 fatal N1QL errors, both query nodes report healthy:true, CPU 0.027-0.026%, ~21GB memory free on both nodes, zero queued requests -- no expensive or long-running queries fall within the incident window.",
			},
		},
	},
	{
		// DEVOPS-1375 -- VERBATIM (Agent Memory, incident jira:DEVOPS-1375).
		inputs: {
			query: "DEVOPS-1375: Capella port 18093: connections refused (NLB stale target)",
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name the Couchbase N1QL/query-service port (18093) connection-refused pattern and investigate the AWS network load balancer (NLB) target-group health as a candidate cause (stale/deregistered target). Response should report Couchbase cluster health as a separate check from the network path, and should not conflate a network-layer refusal with a Couchbase server-side fault if the cluster itself reports healthy.",
			referenceReport:
				"DEVOPS-1375 is a follow-up to DEVOPS-1353: the BaseEndpoint$2 failures are a chronic, multi-service, Capella-side fault, not the styles-v3 SG issue originally suspected. Live nc reproduction from the eu-shared-services-prd bastion on Query TLS port 18093 across all three AZs showed instant TCP RST refusals (~0.01s, not a timeout) at roughly 40-45% rate, while the KV control port (11207) was 100% clean (50/50 connected). VPC Flow Logs showed 18093 connections recorded ACCEPT through the endpoint ENIs, then reset -- confirming the RST originates on the Capella side of PrivateLink, not at the PVH SG/NACL/endpoint layer. Everything PVH-side (endpoint SG, NACLs, client SGs, CloudTrail, VPC endpoint, query-node health) is verified clean. APM showed 4.8M occurrences retained across 5 services (customer-assignments, pvh-services-styles-v3, prices-api-v2, brads, storytelling-api). Working hypothesis: a stale/unhealthy target in the Capella-side NLB target group for port 18093 (likely a former query node left registered after a node swap), with cross-zone load balancing enabled. Impact: customer-assignments POST /v1/fms-customers at ~35% failed-transaction rate.",
			referenceFindings: {
				couchbase:
					"Query-node health confirmed clean: svc-qi-node-133 and svc-qi-node-135 both healthy with 54-day uptime. Live nc reproduction on Query TLS port 18093 across all three AZs showed instant TCP RST refusals (~0.01s, not a timeout) at 40-45% rate, while the KV control port (11207) was 100% clean (50/50 connected) -- isolating the fault to the query-service port specifically, not the cluster generally.",
				aws: "VPC Flow Logs on the endpoint ENIs show 18093 connections recorded ACCEPT through the endpoint, then reset -- confirming the RST originates on the Capella side of PrivateLink, not at the PVH SG/NACL/endpoint layer. Everything PVH-side is verified clean (endpoint SG sg-0f1c7324d23745cae, NACLs, client SGs, CloudTrail, VPC endpoint vpce-045853bfc0d45e1e0), isolating the fault to the Capella-managed NLB behind endpoint service vpce-svc-0c99e50676723c96c, not remediable from the PVH AWS account.",
			},
		},
	},
	{
		// DEVOPS-1376 -- RECONSTRUCTED. Boomi Atom connection-pool exhaustion posting telemetry
		// to Boomi Cloud Container -- chronic, application-layer, burst-pattern outbound tracking
		// calls exhausting the atom's HTTP connection pool.
		inputs: {
			query:
				'Investigate the Boomi Atom molecule cluster -- seeing "Connection threshold has been reached" SEVERE/WARNING errors when posting telemetry and tracking data to the Boomi Cloud Container.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-ediservices-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name the outbound HTTP connection-pool exhaustion on the Boomi Atom molecule cluster as the failure and should confirm this is a chronic, application-layer condition rather than an AWS infrastructure failure by checking the receiving cloud container's ALB/health metrics separately (expected healthy). Response should identify which outbound endpoints (e.g. /track/execution) account for the majority of exhaustion events. Response should check whether the connection-pool threshold is configured anywhere in version control or is left at a vendor default. Response should check GitLab for recent deploys correlating with a burst in outbound calls, and note any timing correlation as circumstantial rather than confirmed causal. Response should include a Gaps section if the causal link to any specific deploy could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1376): The Boomi Atom molecule cluster (pvheurope-EV4TXV, 3-node) is exhausting its outbound HTTP connection pool when posting telemetry and tracking data to the Boomi Cloud Container. This is a chronic, application-layer condition, not an AWS infrastructure failure. The receiving cloud container (molecule-prd-local) is healthy: 3/3 ALB targets healthy, zero 5xx responses, P99 latency under 2ms throughout the window. The atom's EC2 hosts are also healthy: CPU 3-8%, no unhealthy ASG instances. The failure is driven by burst-pattern spikes in outbound tracking calls, with /track/execution accounting for over half of all exhaustion events. Elasticsearch logs confirm this is a 30-day chronic problem (1,256 errors since 2026-06-14), not a new regression. Contributing factors: the connection threshold is at Boomi default with no override in any version-controlled configuration, and an ASG scale-down alarm fired ~50 minutes before the first burst, potentially reducing available pool capacity before the load spike. A GitLab MR (Loqate integration) merged 66 minutes before the incident window introduces 60s-timeout retry calls -- circumstantial timing, causal link unconfirmed.",
			referenceFindings: {
				elastic:
					"1,256 total 'Connection threshold has been reached' SEVERE/WARNING events over 30 days (164 SEVERE with permanently dropped messages, 1,092 WARNING retries), confirming this is a chronic 30-day problem, not a new regression; /track/execution accounts for 663 of the 30-day total (52.8%), and all three molecule nodes are affected, not a single node.",
				aws: "molecule-prd-local ALB is healthy throughout (3/3 targets, zero 5xx, P99 latency 0.7-1.6ms) -- the cloud container is not the bottleneck. atom-as2-prd ASG CPU stayed at 3-8% (not compute-bound) with two confirmed network burst spikes (~40MB and ~68MB) between baseline periods, and a CPU-Utilization-Low-20 scale-down alarm fired at 09:56Z, roughly 50 minutes before the first burst, a candidate but unconfirmed capacity-reduction factor.",
				gitlab:
					"Group-wide blob search for connectionThreshold / com.boomi.container.maxConnections / container.properties returned zero results -- the connection threshold is managed exclusively via the Boomi AtomSphere UI, not version control. WCS MR !4384 (Loqate integration, EED-17253) merged 66 minutes before the incident window and introduces 60s-timeout retry calls, a circumstantial timing correlation with no confirmed causal link to the Boomi connection exhaustion.",
			},
		},
	},
	{
		// DEVOPS-1380 -- RECONSTRUCTED. prices-api-v2-service log flooding: 22.5-22.6M daily log
		// events, root-caused to a catch-all onErrorResume handler emitting a WARN per genuinely
		// missing Couchbase document during a recurring SapArticlePriceFetchJob batch run.
		inputs: {
			query:
				'Investigate "prices-api-v2-service" -- log flooding, 22.5-22.6 million daily log events. Need root cause.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "couchbase", "kafka"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should identify a catch-all error-handling pattern (e.g. onErrorResume) emitting one WARN/error log line per missing Couchbase document during a recurring batch job (e.g. a price-fetch job) as the root cause of the log volume, rather than treating it as an infrastructure incident. Response should confirm via Couchbase whether the referenced documents are genuinely absent (not a transient fault). Response should check the Kafka write pipeline's health as a separate, ruled-out contributor. Response should check AWS CloudWatch for the historical/burst pattern of the log volume. Response should include a Gaps section if the code location or exact commit introducing the catch-all handler could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1380): The prices-api-v2-service incident is a chronic, unresolved log flood caused by a single catch-all onErrorResume handler in CouchbaseRepository.java (commit f6b496fd, introduced 2026-04-21) that emits one WARN log line per missing Couchbase document during every SapArticlePriceFetchJob run. The job fires every two hours, performs bulk K/V lookups against the prices.prices collection, and generates 1.5-2M WARN events per burst -- 96-97% of all log volume for the service. No code fix has been deployed. The missing documents are genuine: direct K/V probes and N1QL queries confirm specific option codes do not exist in Couchbase. The INCK sales org has a disproportionately small catalogue (101K documents vs THE1's 5.2M), consistent with an incomplete initial load. The Kafka write pipeline is healthy and not the cause -- Couchbase sink connectors have committed ~122M offsets with zero lag and empty DLQs. A secondary Couchbase private-endpoint connectivity issue appears to have self-resolved (tracked under DEVOPS-1375, multi-service scope).",
			referenceFindings: {
				elastic:
					"The SapArticlePriceFetchJob WARN flood is confirmed active: ~1,606,062 'Document not found' WARNs in the investigation window (96% of all log volume), peaking at ~761K and ~636K WARNs in consecutive 10-minute buckets, with zero ERROR or FATAL events -- confirming the flood is a logging-verbosity defect, not a hard failure.",
				aws: "The prices-api-v2-service ECS service is healthy (3/3 tasks, no active deployment); the WARN flood is visible in CloudWatch Logs Insights (1,577,501 events matched) and task definition revision 20 is unchanged since 2026-05-26, confirming no fix has been deployed. Zero Connection refused or SSL errors in the current window and Couchbase KV P99 latency is 2.9-3.9ms, indicating the prior connectivity issue has self-resolved.",
				couchbase:
					"Direct K/V probes and N1QL queries confirm the referenced price documents (e.g. PRICE_THE1_01_55_EUR_XW0XW08458GUD, PRICE_INCK_01_09_CAD_LZ040EM819YAF) genuinely do not exist -- zero rows returned. The INCK sales org has a disproportionately small catalogue (101,292 documents vs THE1's 5,197,816), consistent with an incomplete initial load; KV ping latency is elevated at 24ms (normal <1ms) with 2 FFDC events on node 135, but cluster nodes are all status: healthy.",
				kafka:
					"The price pipeline is fully healthy: all consumer groups serving the prices domain report zero lag and STABLE state, the Couchbase sink connectors have ~122M committed offsets, and all 14 sampled DLQ topics are empty -- ruling out Kafka as the cause and indicating the WARNs are misclassified expected 'key not found' responses, not genuine write-pipeline failures.",
			},
		},
	},
	{
		// DEVOPS-1381 -- RECONSTRUCTED. matorder-worker Mendix pod readiness/liveness probe
		// failure on EKS: m2ee-sidecar becomes unresponsive, a later master-pod crash forces a
		// full JVM restart; underlying AWS node/network infra is healthy throughout.
		inputs: {
			query:
				"Investigate pod matorder-worker-6cf865d754-g77qp -- readiness and liveness probes failing against the m2ee-sidecar container on port 8800, namespace prd, EKS cluster mendix-platform-eks-prd.",
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-mendix-platform-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should identify the m2ee-sidecar (Mendix runtime health-check sidecar) becoming unresponsive as the proximate cause, distinguishing an initial HTTP 500 phase (sidecar reachable but unhealthy) from a later TCP-timeout phase (sidecar fully unresponsive). Response should check AWS node-level metrics (CPU, network, NAT gateway, security groups) to confirm the underlying infrastructure is healthy, ruling it out as a cause. Response should investigate whether a JVM thread exhaustion, GC pause, or database connectivity issue in the Mendix runtime is the plausible driver, and should note if the master pod also required a JVM restart. Response should include a Gaps section if the precise trigger for the sidecar's unresponsiveness could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1381): Pod matorder-worker-6cf865d754-g77qp (namespace prd, EKS cluster mendix-platform-eks-prd) has been failing readiness and liveness probes against the m2ee-sidecar container on port 8800 since 2026-07-11T10:07:05Z -- three days before the alert fired. The failure mode has two phases: an initial HTTP 500 from the sidecar (reachable but unhealthy) beginning at pod scheduling, and a later TCP timeout (sidecar completely unresponsive) beginning 2026-07-14T03:32:21Z. The master pod also entered an unrecoverable state at 08:35:18Z and required a full JVM restart. The underlying AWS infrastructure (node CPU, network, NAT gateway, security groups) is healthy. The root cause is application-side: the Mendix runtime (m2ee) on the worker pod became unresponsive to its sidecar's internal health ping, most likely due to JVM thread exhaustion, a GC pause, or a database connectivity failure. The mendix-operator is actively reconciling but has not resolved the issue autonomously.",
			referenceFindings: {
				elastic:
					"m2ee-sidecar ping failures on the worker began 2026-07-14T03:32:23Z ('Healthcheck failed ping: no response to ping'), recurring every 15-30 minutes; the mendix container continued emitting DOM namespace warnings during the failure (07:10Z, 07:17Z), indicating the JVM was partially alive but the m2ee admin port was unresponsive, consistent with thread starvation or an admin-port deadlock rather than a full JVM crash. The master pod separately entered an unrecoverable state at 08:35:18Z and required a full JVM restart, reconnecting to PostgreSQL at 08:41:32Z.",
				aws: "Liveness probes (context deadline exceeded, 151 failures) and readiness probes (HTTP 500, 34 failures) oscillated, with the HTTP 500 failures beginning 2026-07-11T10:07:05Z -- the same day the node was provisioned, three days before the alert fired. Node infrastructure was confirmed healthy throughout (CPU 11.4-11.8%, NetworkIn stable, NAT gateway available, security groups permissive), ruling out infrastructure exhaustion; mendix-operator was actively reconciling but had not resolved the issue autonomously.",
			},
		},
	},
	{
		// DEVOPS-1385 -- RECONSTRUCTED. prana-order-service / kong-eu_oit 504/503 on
		// /order/graphql, root-caused to a PostgreSQL deadlock storm from VariantEventConsumer,
		// compounded by a synchronous-conversion deploy and degraded Couchbase KV latency.
		inputs: {
			query:
				'Investigate "prana-order-service" -- kong-eu_oit is returning 504/503 on /order/graphql. Full functional outage for order operations.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["aws", "kafka", "couchbase", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name a PostgreSQL deadlock storm (e.g. SQLState 40P01) triggered by VariantEventConsumer's concurrent UPDATE statements as the primary root cause, driving ECS task-replacement cycling via failing health checks -- not merely restate the gateway-level 504/503 symptom. Response should check whether a recent deployment (converting an async endpoint to synchronous/blocking) is a compounding factor, and check GitLab for a correlating deploy. Response should check whether a Kong config sync step was skipped/stale after that deploy. Response should check Couchbase KV latency as a separate, concurrent contributing factor (not the primary cause) if elevated. Response should include a Gaps section if the exact trigger for the deadlock onset could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1385): The 504/503 errors on kong-eu_oit -> /order/graphql are caused by a PostgreSQL deadlock storm in orders-prd/orders-service (eu-oit-prd). VariantEventConsumer is processing Kafka variant notification events across a high-concurrency thread pool and issuing broad UPDATE b2b_order statements; when multiple threads target the same row simultaneously, PostgreSQL raises SQLState 40P01 (deadlock detected). This propagates to the service health endpoint, causing 503 responses and continuous ECS task replacement, active since at least 2026-07-15T07:34:59Z. A compounding factor is a production deployment (order-service-1.83.0) that converted the /catalog endpoint from async to synchronous, introducing a new blocking code path; the Kong deck sync for this deployment was never executed, leaving Kong's route config potentially stale. Couchbase KV latency is independently degraded at 23-25 seconds (normal: sub-millisecond), generating a separate KV read storm from high-fanout styles-scope queries -- a concurrent contributing factor, not the primary root cause.",
			referenceFindings: {
				aws: "Continuous ECS task replacement cycle active on orders-prd/orders-service since 2026-07-15T07:34:59Z: tasks fail ALB health checks with 503 and are replaced. An active PostgreSQL deadlock trace at 21:56:51Z shows PSQLException: ERROR: deadlock detected on b2b_order tuple (38170,8), triggered by VariantEventConsumer executor-thread-319, with 2,517 matching deadlock/error log records in the last hour. order-service in eu-oit-prd is ECS-healthy (3/3 tasks, CPU 0.07-0.18%) confirming the fault is data-layer, not container-layer.",
				kafka:
					"All consumer groups are at zero lag (orders-service-prd across 8 topics) with zero DLQ messages on DLQ_T_PRIVATE_SINK_SAP_DRAFT_ORDER -- Kafka consumption itself is healthy and not contributing to the incident; the deadlock is driven by the volume/concurrency of VariantEventConsumer's downstream UPDATE statements, not by message backlog.",
				couchbase:
					"KV ping latency is severely degraded at 23,000-25,000ms (normal: sub-millisecond) while N1QL ping stays at 609-617ms. A dominant styles-scope fanout query pattern (1,514 executions, 11,000-17,000 KV fetches per execution, 13-17MB avg result size, 57-73% of service time in stream/fetch phase) is generating a KV read storm because the index does not cover the SELECT v.* projection -- a concurrent contributing factor to upstream timeouts, not the primary root cause.",
				gitlab:
					"MR !903 (merged 2026-07-13, deployed as order-service-1.83.0 on 2026-07-16T12:06Z) converted DigitalShowroomOrderService.java from @Async (fire-and-forget) to @Transactional (synchronous), introducing a new blocking code path that can exceed Kong's 60-second read_timeout and return 504. The post-deployment Deck Sync PRD job was never executed (started_at: null), leaving Kong's route config potentially stale relative to the deployed revision.",
			},
		},
	},
	{
		// DEVOPS-1386 -- VERBATIM (Agent Memory, incident 8a2be3ff-...).
		inputs: {
			query:
				"Validate and investigate the root cause :-\n\nstyles-v3 / pvh-services-styles-v3 -- Biggest anomaly\nStatistically confirmed throughput spike (p_value = 0) triggered at 23:10 UTC (01:10 CEST)\nThroughput exploded from a baseline of ~10-30 tpm -> peak of ~5,000-7,000 tpm\nDriven almost entirely by GET /v3/styles/{styleCode} from a single source IP",
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should validate the statistically-confirmed throughput anomaly (not merely restate it) by checking Elasticsearch/APM request-rate data for GET /v3/styles/{styleCode} around 23:10 UTC. Response should identify the source IP driving the spike and assess whether it represents a single-caller scraping/retry pattern versus a broader traffic event. Response should check AWS ECS/ALB scaling and error-rate metrics during the spike window. Response should include a Gaps section if the source IP's owning system/service could not be identified.",
			referenceReport:
				"Executive Summary (DEVOPS-1386): A statistically confirmed (p_value = 0) throughput spike on GET /v3/styles/{styleCode} drove pvh-services-styles-v3 from a baseline of 10-30 tpm to a peak of ~5,000-7,000 tpm beginning at 23:10:00Z. The spike was sharp, concentrated on a single endpoint, and self-resolved within a few hours. The service absorbed the load without errors: zero application errors in ECS logs, zero fatal Couchbase requests, all HTTP 200 OK, no Kafka consumer lag or DLQ activity. No code deployment occurred within 10 days of the spike onset. The leading diagnosis is an internally-sourced bulk read workload (a batch job, data pipeline, or downstream consumer performing a full catalogue sweep), corroborated by the event-driven fan-out architecture documented in Confluence. Traffic originated from internal VPC addresses, ruling out external attack. The caller identity was unconfirmed pending Kong Konnect log analysis. Two AWS CloudWatch Logs Insights queries failed with MalformedQueryException in eu-oit-prd (query-construction failures, not data-absence findings). Sibling investigation DEVOPS-1387 (a pvh-services-images-v2 co-spike with the exact same 23:10:00Z onset) subsequently confirmed the specific mechanism: the Live: Price Indexing V2 Jenkins batch job (Confluence-documented, scheduled start 23:10 UTC), which performs a full-catalogue sweep calling both styles-v3 and images-v2 in parallel via OptionDataAggregator.",
			referenceFindings: {
				elastic:
					"Spike onset was exactly 2026-07-16T23:00:00Z (first request GET /v3/styles/0000001047); APM app document volume rose from ~140 docs/5min to a peak of 155,970 docs/5min, and Kong PRD traffic was 99.8% anonymous (116,080 of ~116,349 requests). Only 50 application errors were recorded across the entire spike window (0.04% error rate), all caller-side defects (malformed style codes), confirming the service absorbed the load without genuine failures.",
				aws: "ALB RequestCountPerTarget peaked at 11,171 per 5-min window (~4,468 tpm across 2 tasks) at 23:35Z; ECS CPU peaked at 41.8% and memory at 49.8%, both well short of autoscaling thresholds. Application logs confirmed zero errors and all-200 responses, with traffic originating from internal VPC addresses (ALB forwarding IPs), ruling out external attack; repeated requests for identical style codes within the same second indicate a fan-out batch job without deduplication.",
			},
		},
	},
	{
		// DEVOPS-1387 -- RECONSTRUCTED. pvh-services-images-v2 throughput spike co-occurring
		// exactly with the styles-v3 spike (DEVOPS-1386) -- traced to a nightly batch pipeline
		// (Price Indexing V2) performing a full-catalogue sweep via OptionDataAggregator.
		inputs: {
			query:
				'Investigate "pvh-services-images-v2" -- throughput spike from near-zero baseline to ~2,458 tpm, co-occurring exactly with a styles-v3 spike. Need root cause.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "gitlab", "atlassian"],
			minConfidence: 0.55,
			qualityRubric:
				"Response should identify a scheduled nightly batch pipeline (e.g. a price-indexing job performing a full-catalogue sweep) as the likely driver, corroborated by the exact-to-the-minute co-spike with a related service (styles-v3). Response should check Atlassian/Confluence for a documented batch schedule matching the spike onset time. Response should check GitLab for a recent code change widening the condition that triggers per-item unbatched calls to this service, as a contributing factor to spike severity. Response should confirm the service absorbed the load without errors (healthy Couchbase latency, no ECS autoscaling breach) rather than treating this purely as an incident. Response should include a Gaps section if the caller/batch job could not be conclusively confirmed as the trigger.",
			referenceReport:
				"Executive Summary (DEVOPS-1387): pvh-services-images-v2 experienced a confirmed throughput spike from a near-zero baseline (~0.01 tpm) to approximately 2,458 tpm beginning at 23:10:00Z, mirroring a simultaneous spike on pvh-services-styles-v3 (DEVOPS-1386). Both services are owned by the Blue Team, deployed on ECS Fargate in eu-shared-services-prd, and share the same Couchbase Capella cluster. The co-spike onset is exact to the minute, ruling out independent organic causes. The leading diagnosis is a nightly batch pipeline -- specifically the Live: Price Indexing V2 Jenkins job (Confluence-documented, scheduled start 23:10 UTC) that performs a full-catalogue sweep calling both services in parallel via OptionDataAggregator. Corroborated by an order-service MR (merged just before) that widened the condition triggering per-item unbatched calls to images-v2. No errors were recorded on images-v2 itself; Couchbase query latency remained healthy (P99 ~5ms); ECS tasks reached 53-62% CPU reservation at peak but did not breach the autoscaling threshold.",
			referenceFindings: {
				elastic:
					"Kong PRD logs show images-v2 throughput rising from ~0.01 tpm to a peak of 3,370 tpm, with all traffic targeting GET /v2/images?options=<SKU> exclusively; 30% of the ~111,414 requests returned HTTP 404 (SKU lookups with no image data), characteristic of a batch job iterating a full catalogue. Latency was unaffected throughout (P99 10.9ms) and 99.999% of traffic was anonymous.",
				aws: "images-v2-service ECS was healthy throughout (3/3 tasks, no failures, no deployment events); per-task CPU peaked at 53-62% of reservation at 23:41Z without breaching the autoscaling threshold, and Couchbase query volume reached ~32 N1QL qps at peak with P99 5.1ms, confirming the service absorbed the load within SLO.",
				gitlab:
					"MR !927 (merged 2026-07-17T11:47Z, deployed as order-service-1.86.0, ~11 hours before the spike) widened the condition triggering per-item unbatched calls to images-v2 from isBuyerDirectOrder() to isDirectOrder, and OptionDataAggregator.findOptionsByCodes() runs StyleAggregator (styles-v3) and ImagesServiceV2 (images-v2) in parallel virtual threads -- explaining the exact-to-the-minute co-spike with styles-v3.",
				atlassian:
					"Confluence PVHEU/468026370 documents the Live: Price Indexing V2 Jenkins job scheduled daily at 23:10 UTC performing a full-catalogue MQT Refresh and FredHopper indexing -- an exact match to the spike onset time -- while no Jira incident ticket exists for images-v2 (the related styles-v3 spike is tracked separately as DEVOPS-1386).",
			},
		},
	},
	{
		// DEVOPS-1388 -- VERBATIM (Agent Memory, incident 9ed68499-...).
		inputs: {
			query:
				"Can we identify the source of this persistent high volume in material-order_Mdx?\n\nmaterial-order_Mdx -- Persistent high-volume contributor\nNot a one-off spike -- this service runs at consistently high throughput\nThe raw time series shows peaks of ~28,000-47,000 tpm at various points",
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-mendix-platform-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "kafka"],
			minConfidence: 0.55,
			qualityRubric:
				"Response should investigate whether the persistent high throughput on material-order_Mdx represents expected steady-state load versus an anomalous sustained pattern, rather than assuming it is a problem by default. Response should check Kafka topic/consumer throughput for the material-order_Mdx pipeline if one exists. Response should include a Gaps section if a definitive baseline for 'normal' throughput on this service could not be established from available evidence.",
			referenceReport:
				"Executive Summary (DEVOPS-1388): material-order_Mdx is a Mendix low-code application on the mendix-platform-eks-prd EKS cluster, serving as integration middleware between Mendix, SAP FMS, and downstream logistics (Yusen). Its persistent high-volume signal is not a single fault -- it is the sum of four structurally independent contributors operating simultaneously: (1) Couchbase -- two pathological query patterns (a 660K-document primary scan and a 3,082-execution non-covering pagination query) generating sustained query-seconds and queue pressure; (2) Kafka -- a structurally high-throughput SAP Draft Order pipeline (~780M cumulative messages) running at zero lag, by design not a fault; (3) AWS/EKS -- a CloudNativePG PostgreSQL cluster with 9+ replicas generating ~1,950 Kubernetes API calls/hour as a structural baseline; (4) Elasticsearch APM -- the OpenTelemetry Java agent mis-reports every Mendix microflow loop break as an APM error, inflating the error stream with ~3,539 non-error events in the 24h window. None of these is a transient anomaly; all four are steady-state structural issues that will persist until addressed.",
			referenceFindings: {
				elastic:
					"Every one of the 3,539 APM error documents for material-order_Mdx in the 24h window carries error.exception.type: com.mendix.modules.microflowengine.actions.loops.LoopAction.BreakException$ with error.exception.handled: true -- the Mendix runtime's internal control-flow mechanism for loop termination, mis-reported as an APM error by the OTel Java agent on every loop break. Volume tracks business-hours activity (peaks of 471 and 482 events); this is a monitoring fidelity problem, not real errors.",
				kafka:
					"The SAP Draft Order pipeline (T_PRIVATE_SOURCE_SAP_DRAFT_ORDER / T_PRIVATE_SINK_SAP_DRAFT_ORDER) shows ~780M cumulative messages each, 3 partitions, 7-day retention, with the ksqlDB stream running 12 stream threads across 3 nodes all caught up at zero consumer lag -- a structurally high-throughput pipeline that is healthy by design, not a fault; near-identical source/sink offset totals confirm ksqlDB is passing through essentially every message.",
			},
		},
	},
	{
		// DEVOPS-1389 -- VERBATIM (Agent Memory, incident b7a637de-...).
		inputs: {
			query:
				"Please look at the localcore-service and these errors and error exceptions :-\n\nError during nightly variant stock sync -> HTTP 500 Internal Server Error\n\nError occurred while executing task for trigger CronTrigger [id=1_com.pvh.localcoreservice.service.VariantServiceImpl#nightlySync...]",
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name the nightly variant stock sync cron job (VariantServiceImpl) and the HTTP 500 it produces as the failure, and should investigate whether this is a chronic/recurring nightly pattern rather than a one-off. Response should check AWS CloudWatch logs for the specific exception chain behind the 500. Response should check Atlassian for related prior incidents on this same nightly sync job. Response should include a Gaps section if the exact upstream call producing the 500 could not be isolated.",
			referenceReport:
				"Executive Summary (DEVOPS-1389): The localcore-service nightly variant stock sync (nightlySyncVariantStock) has been failing every night since at least 2026-07-17. The failure manifests as CatalogException: Failed to load stock data wrapping a jakarta.ws.rs.InternalServerErrorException: HTTP 500. Two concurrent failure modes operate in the same cron window, with a third contributing structural factor: Failure Mode A (dominant): the corrected-delivery-dates service returns HTTP 500 for every request involving season 2027WISPWI, brand TH, sales orgs THE1/INLC, division 10 -- a data availability gap in the upstream service, not a crash. Failure Mode B: localcore-service accumulates large in-memory data structures during the sync, causing heap exhaustion; three container tasks were OOM-killed (exit code 137). Structural factor: the cron fires at 03:10 UTC but the upstream stock data run does not complete until 06:10 UTC -- a 3-hour timing mismatch; additionally the ARTICLE_variantNo Couchbase index does not cover the 30-field projection used, forcing a mandatory KV fetch per matched article at 4-6x normal latency. Kafka infrastructure is fully healthy and not a factor.",
			referenceFindings: {
				elastic:
					"30 matching error events over 30 days confirm the failure has occurred on 2026-07-17, 2026-07-18, and 2026-07-19, showing two distinct failure modes: Mode A (jakarta.ws.rs.InternalServerErrorException: HTTP 500 at StyleV3RestClient.customSearch(), dominant, seen 07-17/07-18) and Mode B (org.apache.http.ConnectionClosedException: Premature end of chunk coded message body, seen 07-19). Multiple production nodes fire the cron simultaneously, indicating no distributed lock on the cron execution.",
				aws: "corrected-delivery-dates returns HTTP 500 for every request involving season 2027WISPWI/brand TH/sales orgs THE1/INLC/division 10, confirmed via continuous ERROR logs from WebApplicationExceptionHandler every ~2 seconds across all 3 task instances -- a data availability gap, not a crash. Separately, localcore-service accumulated large in-memory batches (288-380 items per custom search batch) causing heap exhaustion, with three container tasks OOM-killed (exit code 137) between 03:39Z and 04:09Z; two tasks did complete the sync successfully before being killed.",
				atlassian:
					"No prior Jira incident ticket was found specifically for localcore-service nightlySyncVariantStock failures over the last 90 days -- this failure pattern has not been formally tracked, despite related open incidents (DEVOPS-1356, DEVOPS-1375, DEVOPS-1385) sharing the same deployment chain.",
			},
		},
	},
	{
		// DEVOPS-1390 -- RECONSTRUCTED. AssignmentServiceImpl EntityNotFoundException on stale
		// Assignment UUIDs during nightly sync, related family to DEVOPS-1389/1391/1410.
		inputs: {
			query:
				'Investigate the "localcore-service" -- AssignmentServiceImpl is throwing EntityNotFoundException for stale Assignment UUIDs during initialLoad(), aborting the sold-to load for affected users.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-mendix-platform-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "couchbase"],
			minConfidence: 0.55,
			qualityRubric:
				"Response should name EntityNotFoundException from AssignmentServiceImpl.initialLoad() as the failure and investigate whether the referenced Assignment UUIDs are genuinely missing/stale in the backing PostgreSQL or Couchbase-backed data rather than assuming a code defect. Response should check whether this correlates with the nightly sync job and report how many distinct users/UUIDs are affected if that data is available. Response should include a Gaps section if the source of the stale UUIDs (upstream event vs local data drift) could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1390): The localcore-service AssignmentServiceImpl#nightlySyncAssignments cron job (fires daily at 10:45 UTC) has been failing every day since at least 2026-06-22 -- 27+ consecutive daily failures. The same failure also aborts interactive initial loads for end users. Root cause confirmed across four datasources: the localcore-service JPA persistence layer holds references to Assignment entity UUIDs that no longer exist in the backing PostgreSQL database. When Hibernate attempts to resolve these stale references during the sold-to loading loop, it throws jakarta.persistence.EntityNotFoundException, which propagates through three layers of CatalogException wrapping and terminates the entire sync. At least 13 distinct Assignment UUIDs are confirmed missing. Not caused by infrastructure degradation -- all three ECS replicas are healthy. A parallel data-consistency issue exists upstream: customer-assignments-service (eu-shared-services-prd) is publishing unassign events via Kafka with id: null, producing 519,414 dead-lettered messages. Both failure modes share a common upstream cause: assignment records deleted or never committed in the source-of-truth store without downstream references being cleaned up.",
			referenceFindings: {
				elastic:
					"105 occurrences of 'Scheduled nightly sync for SoldTo assignments failed' over 30 days, and 8 occurrences of 'Unable to find com.pvh.localcoreservice.model.Assignment with id fe7c08d1-4bd4-46f9-9e02-88dd6e000656'. A shutdown race condition is confirmed at 2026-07-16T11:18:00Z: org.hibernate.exception.GenericJDBCException (pool closed) and jakarta.transaction.RollbackException: ARJUNA016053 -- the connection pool was torn down during an active sync run.",
				aws: "ECS service is ACTIVE, 3/3 tasks running, rollout COMPLETED -- no infrastructure failure. 13 distinct Assignment UUIDs are confirmed missing over the 30-day window; all 3 running replicas hit UUID fe7c08d1 simultaneously at 2026-07-17T11:03:18Z, confirming the missing record is absent from the shared PostgreSQL database (not a per-instance state issue). Interactive initial-load failures affect at least 8 distinct users with elapsed times from 5,072s to 12,756s.",
				couchbase:
					"UUID fe7c08d1-4bd4-46f9-9e02-88dd6e000656 is absent from customer.assignments, customer.customers, new_model.seasonal_assignment, and _default.archived (scope limited to what was actually queried, not a full-namespace guarantee). The customer.assignments collection stores documents of a different class (com.pvh.customerassignmentsservice.assignment.Assignment) than the failing entity (com.pvh.localcoreservice.model.Assignment), confirming the EntityNotFoundException is thrown by JPA/Hibernate against localcore-service's own PostgreSQL, not against Couchbase; SBAUDO's own 15,664 assignments in Couchbase are intact and healthy.",
			},
		},
	},
	{
		// DEVOPS-1391 -- VERBATIM-adjacent (ticket content directly available, no Agent Memory
		// match found). 503 from customer-assignments-service surfacing as a user-visible error in
		// localcore-service; multi-layer upstream dependency chain through api-europe.pvhcorp.com.
		inputs: {
			query:
				'Investigate the "localcore-service" -- user TMADDICK is seeing "503 Service Temporarily Unavailable" when loading sold-tos. Seems to be coming from customer-assignments-service upstream.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should trace the 503 through the full call chain -- localcore-service -> customer-assignments-service -> its own upstream dependency -- rather than attributing the failure to localcore-service itself, and should identify the raw 503 as an nginx/load-balancer error page propagating verbatim with no circuit breaker at any layer. Response should confirm both localcore-service and customer-assignments-service are infrastructure-healthy (ECS task counts, CPU/memory) to support the application-layer/upstream-dependency conclusion. Response should note this as a chronic, multi-day pattern if the historical volume supports it. Response should include a Gaps section if the ultimate upstream root cause (behind customer-assignments-service) could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1391): The 503 Service Temporarily Unavailable error seen by user TMADDICK is the user-visible surface of a chronic, multi-layer upstream dependency failure occurring every day for at least 27 consecutive days (since 2026-06-22). localcore-service is functioning correctly and is not the source of the error. Confirmed call chain: User -> localcore-service (ECS, eu-oit-prd) -> AssignmentServiceImpl.getByUsernameGroupedBySoldTo() -> OrdersGraphQLClient / customer-assignments GraphQL -> gateway.prd.shared-services.eu.pvh.cloud -> customer-assignments-service (ECS, shared-services-prd) -> CORE_API_URL: api-europe.pvhcorp.com -> HTTP 503 (nginx/load-balancer response). The raw HTML 503 body is a standard nginx/load-balancer error page originating from api-europe.pvhcorp.com, propagating verbatim through customer-assignments-service and back to localcore-service with no circuit breaker or fallback at any layer. A secondary, compounding failure exists: localcore-service's AssignmentServiceImpl.initialLoad() throws an unhandled EntityNotFoundException on stale Assignment UUIDs (tracked in DEVOPS-1390). Both services are infrastructure-healthy (3/3 tasks, low CPU/memory); all failures are application-layer.",
			referenceFindings: {
				elastic:
					"Every failure produces two correlated log entries sharing the same trace.id: an ERROR from AssignmentServiceImpl.java:L342 ('Error while getting assignments grouped by sold to') and a WARN propagating the failure to callers as code 400. TMADDICK-specific hits total 1,465 over 30 days; error spikes concentrate in the 22:00-06:00 UTC window, consistent with off-peak upstream degradation. The pattern is cross-brand and cross-user, not isolated to one account.",
				aws: "The confirmed call chain traces the 503 through localcore-service -> AssignmentServiceImpl.getByUsernameGroupedBySoldTo() -> customer-assignments-service -> CORE_API_URL: api-europe.pvhcorp.com, which returns the raw 503 (io.smallrye.graphql.client.InvalidResponseException: Unexpected response. Code=503). Both localcore-service (3/3 tasks, CPU 0.85%, memory 2.64%) and customer-assignments-service (3/3 tasks, CPU ~2%) are infrastructure-healthy, confirming the service is idle waiting on the upstream rather than resource-constrained.",
			},
		},
	},
	{
		// DEVOPS-1395 -- RECONSTRUCTED. prana-order-service SAP order submission 500 -- traced to
		// the SAP CPI/Blackbox middleware layer (transient iFlow failure resolved on resubmit,
		// per a later confirmation callback), not a defect in prana-order-service itself.
		inputs: {
			query:
				'Investigate "prana-order-service" -- getting error "500 - An internal server error occured: The MPL ID for the failed message is: AGpfxH3CYxvdt-SteWAZtXKJnHnn" for order 0003307461.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "kafka"],
			minConfidence: 0.55,
			qualityRubric:
				"Response should identify the MPL ID as a SAP Cloud Integration (CPI) Message Processing Log identifier, and conclude the failure originates in the SAP CPI/Blackbox middleware layer rather than in prana-order-service's own code, since the service only called the intake endpoint and propagated the 500 it received. Response should check AWS CloudWatch for a later SAP confirmation callback indicating the order was ultimately accepted (a transient iFlow failure resolved on retry), rather than treating the 500 as a persistent unresolved failure. Response should confirm Kafka and Couchbase were healthy throughout, ruling them out as contributors. Response should include a Gaps section if the exact SAP CPI-side cause could not be determined from available evidence (since the authoritative diagnosis lives in the SAP Operations Monitor, outside this platform's datasources).",
			referenceReport:
				"Executive Summary (DEVOPS-1395): The error '500 - An internal server error occured: The MPL ID for the failed message is: AGpfxH3CYxvdt-SteWAZtXKJnHnn' originates entirely within the SAP Cloud Integration (CPI) / Blackbox API middleware layer, not inside prana-order-service. The service correctly called the SAP intake endpoint, received a 500, and propagated it. The MPL ID is a SAP CPI Message Processing Log identifier -- the authoritative artifact for diagnosing the failure is the SAP CPI Operations Monitor entry for that ID. AWS CloudWatch logs confirm the order was subsequently accepted by SAP: a confirmation callback arrived shortly after with statusFlag=53 (saved) and a SAP order number, meaning the initial 500 was a transient iFlow failure that resolved on retry or resubmission. The Kafka pipeline was fully healthy throughout (zero lag, zero DLQ messages). Couchbase cluster was healthy. The GitLab CI pipeline for the release deployed earlier completed successfully with no SAP-path regressions. A secondary, ongoing issue: SAP confirmation statusFlag=51 is unhandled in SAPOrdersService, silently dropping state updates for at least 6 orders.",
			referenceFindings: {
				elastic:
					"The exception chain traces through RetryOperationsInterceptor (Spring Retry, all attempts exhausted) to HttpServerErrorException$InternalServerError wrapped as SapClientException -- the error body is verbatim from the SAP CPI response, not generated by prana-order-service. The current burst of 16 events is the largest in the 30-day window (prior bursts of 2-6 events on 06-25, 07-03, 07-08, 07-12).",
				aws: "A SAP confirmation callback arrived at 2026-07-21T19:23:17Z with statusFlag=53 (saved) and SAP order number 516411125, confirming the order was ultimately accepted and the initial 500 was a transient iFlow failure resolved on retry. A separate, ongoing issue was found: statusFlag=51 is unhandled in SAPOrdersService, silently dropping state updates for at least 6 orders between 2026-07-18 and 2026-07-21 with SAP message 'partner blocked'.",
				kafka:
					"The Kafka pipeline for SAP draft orders is fully healthy: DLQ_T_PRIVATE_SINK_SAP_DRAFT_ORDER has 0 messages, the connect-C_SINK_SAP_DRAFT_ORDER connector is STABLE with 3 active members, and consumer lag is 0 across all 3 partitions and all 8 orders-service-prd subscribed topics -- ruling out the pipeline as a contributing factor.",
			},
		},
	},
	{
		// DEVOPS-1392 -- RECONSTRUCTED. Earlier pass identifying the S3 bucket via env var but
		// not yet querying it -- later resolved with the actual IAM gap confirmed in DEVOPS-1398.
		inputs: {
			query:
				'Investigate the "prana-import-export-service" -- failing to retrieve a failed-import Excel file from S3, getting a 403. The bucket env var is FAILED_IMPORT_DATA_S3_BUCKET=failed-import-excel-data-prd.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["aws", "elastic"],
			minConfidence: 0.5,
			qualityRubric:
				"Response should investigate the S3 bucket named in the environment variable directly (not just note its existence) -- checking the ECS task role's IAM policy against the bucket for missing permissions (e.g. s3:ListBucket or s3:GetObject). Response should check Elasticsearch/APM for the volume and history of this 403 pattern. Response should include an explicit Gaps section if the bucket's actual IAM policy could not be queried or if CloudTrail history is unavailable to confirm when the permission gap was introduced -- an incomplete investigation here (identifying the bucket without querying its access policy) should be marked as a limitation, not presented as a completed root cause.",
			referenceReport:
				"Executive Summary (DEVOPS-1392): This ticket covers Excel Import Failures for prana-import-export-service (a distinct issue from the S3 IAM failure later confirmed in DEVOPS-1398). Two distinct NullPointerException defects in ImportService.java are causing Excel order imports to fail silently for a subset of orders, present since at least 2026-06-22, chronic not a new regression. (1) The identifier variable, sourced from the Excel file's OOXML Core Properties metadata, is not null-guarded before .equals() is called -- files not generated by the service itself return null. (2) XSSFWorkbook.getSheet('EANs') returns null when the named sheet is absent from the uploaded workbook, and the code calls .rowIterator() on the null reference without a guard -- files missing the EANs sheet tab (including the new PFB/Buyer Excel format) trigger this path. Service infrastructure is healthy (3/3 ECS tasks, no deployment in progress). Kafka consumer groups are healthy with zero lag. Couchbase confirms 7,227 articles with ean=null (legacy seasons), a contributing data-quality factor. Total confirmed error volume over 30 days: 287 occurrences of defect 1, 103 of defect 2.",
			referenceFindings: {
				aws: "Service infrastructure is healthy: 3/3 ECS tasks running in eu-oit-prd, no task failures, no deployment in progress since 2026-06-16. The service is not deployed in eu-shared-services-prd. Two NullPointerException defects were traced to commits: identifier read from OOXML Core Properties with no null guard (2023-03-15) and workbook.getSheet('EANs') returning null with no guard before .rowIterator() (2022-07-25).",
				elastic:
					"287 occurrences of defect 1 (identifier null NPE) and 103 occurrences of defect 2 (eansSheet null NPE) confirmed over 30 days via APM, both present since at least 2026-06-22 -- chronic, not a new regression. Both call chains resolve to ImportService.java (buildEanSheetLines at line 171 and getOptionsToUpdate at line 139 respectively).",
			},
		},
	},
	{
		// DEVOPS-1393 -- VERBATIM (Agent Memory, incident 798c2e24-...).
		inputs: {
			query:
				'in our "corrected-delivery-dates-service" service, identify the root cause :-\n\nSRMSG00200: The method pvh.services.delivery.dates.variant.event.VariantConsumer#consume has thrown an exception',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "kafka", "aws", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name SRMSG00200 / VariantConsumer#consume as the SmallRye Reactive Messaging failure signature on corrected-delivery-dates-service specifically (distinct from the similarly-named orders-service consumer failures elsewhere in this ticket family) and investigate the underlying exception rather than stopping at the wrapper message. Response should check Kafka consumer/DLQ health for this service's variant-event topic. Response should check Atlassian for related tickets given this service shares infrastructure/patterns with orders-service's VariantEventConsumer issues. Response should include a Gaps section if the specific underlying exception could not be resolved beyond the SRMSG00200 wrapper.",
			referenceReport:
				"Executive Summary (DEVOPS-1393): SRMSG00200 is a SmallRye Reactive Messaging wrapper. The underlying root cause is that VariantConsumer#consume calls SeasonsClient#getSeasons -- a MicroProfile REST client -- which returns HTTP 404 Not Found for specific season/division/salesOrganization combinations. Because the consumer has no 404 fallback, the ClientWebApplicationException propagates unhandled, causing SmallRye to dead-letter the message and emit SRMSG00200. Confirmed by three independent datasources: Kafka DLQ headers (verbatim exception class and reason), Elasticsearch APM error traces (full call stack), and Kong gateway access logs (1,360 upstream 404s in a 20-minute window, 31% error rate on the seasons endpoint). The ECS service itself is healthy -- no task crashes, no infrastructure failures. A secondary, lower-frequency root cause: a NullPointerException in DataLoaderServiceImpl.lambda$loadVariant$0 when division or dropDate is null on the incoming variant message. 113,715 variant messages have been dead-lettered to DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS; live consumer group lag is currently 0.",
			referenceFindings: {
				elastic:
					"52 occurrences of error group bf741f1573851845 in the incident window, peaking in a 5-minute burst at 17:05-17:10Z across ECS nodes ip-10-34-51-210, ip-10-34-51-7, ip-10-34-50-239. Kong access logs for the seasons-v3 upstream show 1,360 of 4,421 requests returning 404 (31% error rate) with 404 responses cached by Kong, amplifying the impact.",
				kafka:
					"Every sampled DLQ message on DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS carries the verbatim dead-letter header org.jboss.resteasy.reactive.ClientWebApplicationException with reason 'Not Found, status code 404' from SeasonsClient#getSeasons; total DLQ depth is 113,715 messages. The live consumer group is STABLE with 21 members and zero lag, meaning the consumer routes failures to the DLQ rather than blocking.",
				aws: "ECS service corrected-delivery-dates in cluster shared-services-prd: desiredCount=3, runningCount=3, pendingCount=0, failedTasks=0, last steady state 2026-07-21T13:38:19Z -- no infrastructure failure. The CPU-Utilization-Low-20 alarm fired at 16:49:50Z (CPU 12.47%), consistent with the consumer failing fast on 404s rather than performing real computation. The service is not deployed in eu-oit-prd.",
				atlassian:
					"Jira DSDW-1274 (2024-01-16) documents an NPE in DataLoaderServiceImpl.lambda$loadVariant$0 when dropDate is null, marked Done after Dev/Stage verification, but DSDW-1599 weekly monitoring shows the identical NPE reappeared in production on 2024-10-07 -- the fix was incomplete or a new code path re-exposed the same unguarded dereference. DSDW-1629 corroborates that a null division field in the variant cache causes missing delivery dates.",
			},
		},
	},
	{
		// DEVOPS-1396 -- VERBATIM (Agent Memory, incident 169f6dde-...). Initial triage pass;
		// kept as a distinct entry from DEVOPS-1397's deeper forensic pass on the same signature
		// (different investigation depth/framing is itself a useful eval distinction).
		inputs: {
			query:
				'Investigate the "orders-service" service to determine the root cause of these errors and exception messages :-\n\nSRMSG00200: The method com.pvh.orders.feature.rich.notifications.styles.event.consumer.VariantEventConsumer#consume has thrown an exception -- Error invoking subclass method',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "kafka", "couchbase", "aws"],
			minConfidence: 0.55,
			qualityRubric:
				"Response should name SRMSG00200 / VariantEventConsumer#consume as the failure and should investigate rather than assume a single cause, since this signature is known to mask multiple concurrent failure modes at the SmallRye layer. Response should check for database-level issues (e.g. deadlocks) and downstream service 404s (e.g. a seasons/styles lookup) as candidate contributors. Response should check Kafka DLQ accumulation for the affected topic. Response should include a Gaps section reflecting the appropriately provisional nature of a first-pass triage.",
			referenceReport:
				"Executive Summary (DEVOPS-1396): SRMSG00200/SRMSG00201 errors from VariantEventConsumer#consume in orders-service-legacy (eu-oit-prd) are produced by three concurrent, independent failure modes -- all surfacing identically at the SmallRye Reactive Messaging layer as 'Error invoking subclass method', masking their distinct origins. Primary root cause: a chronic PostgreSQL deadlock on the b2b_order table, active since 2026-06-21, 200,075 log-matched events over 30 days, peaking at 14,226/day. Multiple concurrent Kafka consumer threads issue a 43-column UPDATE b2b_order in non-deterministic lock order; PostgreSQL kills one transaction, the unhandled PessimisticLockException propagates, flipping the channel to KO and triggering ECS health-check 503s and task replacement. Secondary: SeasonsClient#getSeasons returns 404 for 2027-season codes, dead-lettering 1,427 Kafka messages. Tertiary (eu-shared-services-prd): styles-v3-service returns 500 on a ConstraintViolationException path and a NoResourceFoundException routing fallthrough. Couchbase full-table scans amplify consumer failures under load.",
			referenceFindings: {
				elastic:
					"369 SRMSG00200/SRMSG00201 events over 30 days share error group key 1280e1a657a41bde -- an identical exception fingerprint throughout. The full chain resolves through io.quarkus.arc.ArcUndeclaredThrowableException -> jakarta.transaction.RollbackException: ARJUNA016053 -> jakarta.persistence.PessimisticLockException -> org.postgresql.util.PSQLException: ERROR: deadlock detected on b2b_order, with deadlock tuples varying per event (not a single hot row).",
				kafka:
					"The DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS DLQ carries 1,427 messages, 9 of 10 sampled with dead-letter-reason 'Not Found, status code 404' from SeasonsClient#getSeasons for season codes 2027SUFASU and 2027WISPWI; 1 of 10 carries a distinct VariantValidationException for a null marketSellIn field. Consumer group orders-service-prd is STABLE with 24 active members and zero lag across all 3 partitions.",
				couchbase:
					"The VariantEventConsumer query queued for 24.9 seconds (87% of total elapsed) before executing, per capella_get_completed_requests. Four fatal full-table-scan queries against styles_stibo.article timed out at 74.5s each, consuming 1.74GB memory apiece, at 06:06-06:18Z -- these saturated both query nodes and are a documented amplifier of consumer failures under concurrent load, not the primary root cause.",
				aws: "ECS service orders-service in cluster orders-prd: task def :342, desired/running/pending 3/3/0, deployment COMPLETED. The SmallRye liveness probe reports the variant-in channel as [KO] - 'Error invoking subclass method' while all other channels (prepack-in, prices-in, stock-in, etc.) report [OK], isolating the fault entirely to the variant consumer path. 200,075 deadlock-matched log records were confirmed over 30 days, peaking at 14,226 on 2026-06-24.",
			},
		},
	},
	{
		// DEVOPS-1397 -- VERBATIM (Agent Memory, incident 88234432-...). Deeper forensic pass on
		// the same signature as DEVOPS-1396, confirming three concurrent causes.
		inputs: {
			query:
				'Investigate the "orders-service" service to determine the root cause of these errors and exception messages :-\n\nSRMSG00200: The method com.pvh.orders.feature.rich.notifications.styles.event.consumer.VariantEventConsumer#consume has thrown an exception -- Error invoking subclass method. This has been happening chronically since about a month ago -- please do a deep root-cause pass, not just the top-level exception.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should identify multiple concurrent, independent failure modes behind the shared SRMSG00200/VariantEventConsumer wrapper rather than collapsing them into one root cause -- specifically should investigate a PostgreSQL/database-deadlock signal, a downstream 404 (seasons or styles lookup) causing dead-lettered Kafka messages, and any styles-v3 routing contribution as separate contributing threads. Response should report Kafka DLQ accumulation with approximate counts if available. Response should check GitLab for a recent deploy correlating with any of the threads and Atlassian for related open tickets on the same services. Response should include a Gaps section distinguishing confirmed root causes from correlated-but-unconfirmed contributors.",
			referenceReport:
				"Executive Summary (DEVOPS-1397, deeper forensic pass on the same DEVOPS-1396 signature): The SRMSG00200/SRMSG00201 errors from VariantEventConsumer#consume in orders-service-legacy are produced by three concurrent, independent failure modes, not a single root cause. The primary and most severe: a PostgreSQL deadlock on the b2b_order table, 200,075 occurrences over 30 days, peaking at 14,226/day, poisoning the SmallRye channel liveness state and triggering a continuous ECS task-replacement loop. Secondary: SeasonsClient#getSeasons returning HTTP 404 for unregistered 2027 season codes, silently dead-lettering 1,427 Kafka messages to DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS. Tertiary (eu-shared-services-prd): styles-v3-service contributes additional consumer failures via HTTP 500 responses introduced in a 2026-07-06 deployment. Couchbase full-table scans (missing secondary indexes, 1.74GB per query, 74.5s timeouts) act as an amplifier under concurrent load. corrected-delivery-dates-service (DEVOPS-1393) shares the same DLQ and the same SeasonsClient 404 pattern, confirming the 2027 season code registration gap is platform-wide.",
			referenceFindings: {
				elastic:
					"369 SRMSG00200 and 369 SRMSG00201 errors recorded over 30 days, always firing as a pair on the same trace.id, distributed across 10 distinct ECS nodes confirming an application-level concurrency failure rather than a single-node fault. Kong logs independently confirm seasons-v3 returning 404 on 1,360 of 4,421 requests (31%) in the 17:00-17:20Z window, with 404 responses cached by Kong amplifying the failure rate.",
				kafka:
					"DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS holds 1,427 dead-lettered messages, all 10 sampled carrying identical dead-letter headers for the SeasonsClient 404 on season codes 2027SUFASU and 2027WISPWI. Consumer group orders-service-prd is STABLE with lag 0 across 24 active members -- the consumer is alive and routing failures to the DLQ, not stalled.",
				couchbase:
					"The VariantEventConsumer's core CTE query executes a PrimaryScan3 scanning all 658,516 variant documents on every Kafka message consumed (existing VARIANT_variantNo index does not cover the predicate), running 1,615+ times/day at 1.15-1.47s average service time. Four fatal queries on styles.article at 06:06-06:18Z each consumed 1.3-1.74GB session memory and timed out at 74.5s, saturating both query nodes during that window.",
				gitlab:
					"Three structural defects confirmed in VariantProcessor.java/VariantEventConsumer.java: determineSalesStatus() throws an unguarded NotFoundException when a variant's optionStatusCodes map lacks the sales org key (uncaught in updateOrderItem() and hasVariantOptionStatusChanged()); the @Transactional annotation on both the consumer and processor causes the JTA transaction manager to re-throw past the catch(Exception) block via the CDI proxy; and optionStatusCodes has no null guard, risking an NPE before the NotFoundException path is even reached.",
				atlassian:
					"DEVOPS-1396 and DEVOPS-1393 share the same DLQ (DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS) and the same SeasonsClient 404 root cause, confirming the 2027 season code registration gap is platform-wide rather than isolated to a single service.",
				aws: "Deadlock evidence extracted verbatim from CloudWatch shows a full 43-column UPDATE b2b_order statement; when multiple consumer threads process variant events for the same order concurrently, they acquire row locks in non-deterministic order, producing a circular dependency PostgreSQL resolves by killing one transaction. 200,075 total matched deadlock events over 30 days, peaking at 2,303 in a single 5-minute window on 2026-07-01.",
			},
		},
	},
	{
		// DEVOPS-1398 -- VERBATIM (Agent Memory, incident cc8d872f-...).
		inputs: {
			query:
				'Investigate the "prana-import-export-service" service errors and error exceptions below :-\n\nError while getting file 0003308153.json from s3 bucket -> User: arn:aws:sts::000000000000:assumed-role/import-export-service-ecs-task-role/0000000000000000000000000000000f is not authorized to perform: s3:ListBucket',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["aws", "elastic", "atlassian"],
			minConfidence: 0.65,
			qualityRubric:
				"Response should name the missing s3:ListBucket IAM permission on the import-export-service-ecs-task-role as the direct, confirmed root cause (not merely a candidate), since the error message itself names the exact denied action and role. Response should check Elasticsearch/APM for the historical volume and onset date of this 403 pattern. Response should check Atlassian for a prior related ticket that identified the bucket without confirming the IAM gap, and note the relationship if found. Response should include a Gaps section only for genuinely unresolved items (e.g. why the policy regression occurred, if CloudTrail history is unavailable) -- it should not hedge on the IAM permission gap itself, which is directly evidenced.",
			referenceReport:
				"Executive Summary (DEVOPS-1398): The prana-import-export-service ECS task role (import-export-service-ecs-task-role, eu-oit-prd) is missing the s3:ListBucket IAM permission on the S3 bucket failed-import-excel-data-prd. Every attempt by the service to retrieve a failed-import Excel file from that bucket results in an HTTP 403 denial. Not a transient fault: Elasticsearch logs show 62 APM error events across 23 days, affecting at least 31 distinct orders across all 8 ECS task instances. Service is operationally stable (3/3 tasks, no compute alarms), but the failed-import retrieval path is completely broken for every order that reaches it. A prior incident ticket (DEVOPS-1392) identified the bucket via the task definition environment variable but did not query it. The bucket was provisioned in August 2024 with an instruction to 'set access policies in the same way as other documents'; the task role policy was evidently never updated. An OIT S3 hardening exercise (DEVOPS-954, completed 2025-03-13) is a candidate contributing factor, but cannot be confirmed because the regional CloudTrail trail has been stopped since 2026-04-13. The S3 IAM gap is the sole root cause of the reported errors.",
			referenceFindings: {
				aws: "Task definition revision 116 confirms the task role arn:aws:iam::762715229080:role/import-export-service-ecs-task-role and env var FAILED_IMPORT_DATA_S3_BUCKET=failed-import-excel-data-prd. Service is operationally stable (3/3 tasks, no compute alarms). CloudTrail trail infra-log-prd-ae1-cloudtrail-org-trail has been stopped since 2026-04-13, so the exact timeline of the permission regression cannot be confirmed from audit logs.",
				elastic:
					"62 APM error events over 30 days (31 paired 'Error while getting file' / 'Failed to get excel data' occurrences), exception type software.amazon.awssdk.services.s3.model.S3Exception with HTTP 403, error grouping key 49d019bbb084754f. The error is cluster-wide across all 8 ECS task instances, confirming the task role policy (shared by all tasks) is the source, not a per-instance issue. The failure is silently handled -- the service logs it and returns null to the caller.",
				atlassian:
					"DEVOPS-1392 (filed 2026-07-21, Backlog, unassigned) identified the bucket via the task definition environment variable but explicitly listed it as an uninvestigated gap without querying it. DSP-9446 (2024-08-27) provisioned the bucket with an access-policy instruction to match 'other documents' but the task role policy was evidently never updated; DEVOPS-954 (S3 hardening, completed 2025-03-13) is a candidate contributing factor, unconfirmed without CloudTrail evidence.",
			},
		},
	},
	{
		// DEVOPS-1399 -- VERBATIM (Agent Memory, incident ea7e6a48-...).
		inputs: {
			query:
				'In the "prana-import-export-service" service can you investigate this error and error exception\n\nError generating new document for message Message(MessageId=1ab75b9a-7815-45ea-a692-48439f5a4f69, ...), exception "Index 1 out of bounds for length 1"',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name ArrayIndexOutOfBoundsException ('Index 1 out of bounds for length 1') as the failure and identify the document-generation/Excel-export code path as the throwing area. Response should investigate the GitLab source to identify the specific method/call chain constructing the out-of-bounds array access rather than only quoting the exception message. Response should check AWS SQS/DLQ for the affected queue's accumulated failed-message count. Response should include a Gaps section if a secondary or co-occurring failure mode (e.g. a separate NullPointerException) is present but not fully investigated.",
			referenceReport:
				"Executive Summary (DEVOPS-1399): The error 'Error generating new document' with exception 'Index 1 out of bounds for length 1' is a Java application-level bug in the SIMPLE_EXCEL/OVERVIEW document generation pipeline of prana-import-export-service. The service consumed a valid SQS message and threw an ArrayIndexOutOfBoundsException when accessing index 1 of a single-element array during Excel construction. Confirmed by Elasticsearch APM (15 occurrences with full stack trace, 120 with stripped exception message) and corroborated by CloudWatch logs (7 errors in one day alone, 33 messages currently in the document-dlq). Service infrastructure is healthy: 3/3 ECS tasks running, CPU 0.07%, memory 12.8%. The specific crash site is ExcelExportService.java in the getSizeIndexComparatorForTwoDimensionalOptions / getEanSheetData call chain. A secondary, dominant failure mode (NullPointerException on SoldToSalesArea.getShipTo()) is also active and accounts for the majority of the 33 DLQ messages. No existing Jira ticket tracks either defect; DEVOPS-1398 covers an unrelated S3 IAM failure on the same service.",
			referenceFindings: {
				elastic:
					"135 occurrences over 30 days across two error groupings (15 with full stack trace, 120 with stripped exception message), all on affected nodes ip-10-35-12-150/155/13-92. The full stack trace resolves the crash site to ExcelExportService.java:1484 (lambda$getSizeIndexComparatorForTwoDimensionalOptions) via getEanSheetData() -> exportExcel() -> DocumentGenerationService -- a comparator accessing index [1] of a size-options array that has only one element.",
				aws: "SQS document-dlq holds 33 messages, document-queue is empty -- all failed exports are undelivered. ECS service is healthy (3/3 tasks, revision 116, CPU 0.07%, memory 12.8%). CloudWatch logs identify a second, dominant failure mode: NullPointerException on SoldToSalesArea.getShipTo() returning null, affecting orders from LOCOBRANDS S.L.U and AMAZON TURKEY PERAKENDE across multiple users, with 7 errors on 2026-07-22 alone.",
				gitlab:
					"The crash site is confirmed in ExcelExportService.createEanSheetLine(): articleCode.split('_')[1] is called after only a contains('_') guard, but Java's default split() trims trailing empty strings, so an articleCode like 'MW0MW35263_' (trailing underscore) passes the guard but produces a length-1 array, causing the out-of-bounds access at index 1. MR !354 (2026-07-17) exercised this code path more broadly but the split bug itself is pre-existing.",
			},
		},
	},
	{
		// DEVOPS-1400 -- VERBATIM (Agent Memory, incident 0bfdd3dd-...).
		inputs: {
			query:
				'Please verify this information and look into the cause of this volume of error in the "stock-service" service ?\n\nDocumentNotFoundException dominates error-log volume (aggregated by error.grouping_key), overwhelmingly on Couchbase KV GetRequest against default.inventory.b2b.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "elastic", "kafka"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should verify (not merely accept) the claimed error volume by independently querying Elasticsearch, and should investigate whether DocumentNotFoundException represents genuine data-availability problems versus an expected 'key not found' KV response being propagated and logged as an unhandled exception (a code-level logging/error-handling issue rather than an infrastructure fault). Response should check Couchbase cluster health as a separate finding from the error volume itself. Response should check Kafka consumer/DLQ health for any pipeline feeding this collection. Response should include a Gaps section if a secondary, lower-volume issue (e.g. a distinct connection-refused pattern) is present but not the primary focus.",
			referenceReport:
				"Executive Summary (DEVOPS-1400): stock-service accounts for approximately 66.5% of the cluster's total error-log volume -- approximately 10.92M errors over 30 days -- of which 99.85% are a single exception type: DocumentNotFoundException on KV GetRequest against the default.inventory.b2b Couchbase collection. Every datasource queried independently corroborates the same conclusion: this is not an infrastructure failure. The Couchbase cluster is healthy, the AWS network path is unobstructed, the Kafka pipeline is fully caught up, and the service itself is running within normal CPU and memory bounds. The root cause is a code-level logging misconfiguration: the application propagates an expected 'key not found' KV response as an unhandled exception, which the Spring WebFlux default error handler captures and emits at ERROR level. GitLab source inspection confirms no DocumentNotFoundException handler exists anywhere in the codebase. A one-line reactive error-handling fix would eliminate ~99.85% of the error volume with no change to observable API behaviour. A secondary, unrelated issue -- 16,809 connection-refused errors on the Couchbase N1QL/query endpoint -- is a genuine but low-severity connectivity event (0.15% of errors), isolated to a single historical burst around 2026-07-13T03:13Z, not ongoing.",
			referenceFindings: {
				couchbase:
					"The cluster is fully healthy across all 12 nodes with zero fatal N1QL queries in the last 24 hours. The inventory.b2b collection holds 322,557 documents keyed by bare EAN-13 barcodes -- a subset of the full product catalogue -- so any lookup for an EAN without an inventory record correctly returns KEY_ENOENT; the cluster is not malfunctioning, it is correctly reporting the requested keys do not exist.",
				elastic:
					"6,528,123 of 6,834,368 total documents (95.5%) are java.util.concurrent.CompletionException wrapping DocumentNotFoundException with dispatchMicros 2,000-3,000 (sub-3ms round-trip), confirming Couchbase responded immediately with KEY_ENOENT rather than timing out. A nightly 03:00-04:00 UTC spike (400K-440K events/hour every night since 2026-07-14) is the primary volume driver, consistent with a scheduled batch job iterating EANs absent from inventory.b2b.",
				kafka:
					"All 22 Couchbase-sink consumer groups are at zero lag and all four Couchbase-specific DLQs are empty -- the DocumentNotFoundException errors occur on read-side KV GetRequest operations by stock-service itself, not on write-side Kafka connector operations, ruling out the pipeline as a contributing factor.",
			},
		},
	},
	{
		// DEVOPS-1402 -- RECONSTRUCTED. Same routing-fallthrough family as DEVOPS-1385/1396/1397,
		// with a concrete invalid-path example.
		inputs: {
			query:
				'Investigate the "pvh-services-styles-v3" service -- getting a 404 NoResourceFoundException: "No static resource v3/styles/TH1037/S61." Not sure if this is a bad request or a real gap.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "gitlab", "aws"],
			minConfidence: 0.55,
			qualityRubric:
				"Response should determine whether the 404 is a routing miss (path shape does not match any registered controller route) versus a genuine missing-resource case, by checking the GitLab controller source for the actual route pattern. Response should check whether the specific path segments in the request (style code length, season code validity) are well-formed for this service's API contract. Response should check AWS for any concurrent infrastructure event (e.g. a traffic drop or ECS rollout) in the same window as a possible confounding factor. Response should include a Gaps section if the caller constructing the malformed request could not be identified.",
			referenceReport:
				"Executive Summary (DEVOPS-1402): pvh-services-styles-v3 is returning '404 NOT_FOUND No static resource v3/styles/TH1037/S61.' because the request path /v3/styles/TH1037/S61 matches no registered Spring WebFlux controller route. Spring falls through to its static resource handler, which throws NoResourceFoundException. This is a routing miss, not a missing database record. Two compounding causes confirmed across multiple datasources: (1) the path /v3/styles/{x}/{y} (two segments) is not defined in the controller -- no such mapping exists in StyleController.java; and (2) the caller is constructing an invalid path -- TH1037 is 6 characters where the /{styleCode} endpoint requires exactly 10, and S61 is not a valid AFS season code for the Tommy Hilfiger EU sales organisation. Chronic since at least 2026-07-10, tracked as an open, unresolved finding in DEVOPS-1396 and DEVOPS-1397. A separate but concurrent infrastructure event occurred at approximately 00:00Z in eu-shared-services-prd: a 15-minute window of 97% traffic drop, CPU spike to 45%, and P99 latency reaching 3.1 seconds on the ALB target group, consistent with an ECS rolling task replacement.",
			referenceFindings: {
				elastic:
					"236 occurrences of NoResourceFoundException with message '404 NOT_FOUND No static resource v3/styles/TH1037/S61.' across the 30-day window, all sharing APM grouping key f368422fcf449b8a, affecting both production (v1.0.24) and staging (v1.0.21). The error is marked handled: true, and the stack trace root at ResourceWebHandler.java:431 confirms the request reached the static-resource fallback handler, meaning no controller route matched.",
				gitlab:
					"StyleController.java confirms no two-segment route /v3/styles/{x}/{y} exists -- registered routes are single-segment /{styleCode} (@Size(min=10,max=10)) or 5-6 segment brand/org/season/division paths. TH1037 is 6 characters (fails the 10-character size constraint even if a route existed) and S61 does not match any registered AFS season pattern. The Kong proxy-cache plugin caches 404 responses for 300 seconds, amplifying the impact of each routing miss.",
				aws: "A separate, concurrent infrastructure event at approximately 2026-07-24T00:00Z in eu-shared-services-prd showed a 97% traffic drop, CPU spike to 44.9%, and P99 latency reaching 3,121ms on the styles-v3-service ALB target group, with zero 4xx/5xx counts during the spike -- consistent with an ECS rolling task replacement rather than application errors. Traffic had not fully recovered to pre-event levels by the time of the report.",
			},
		},
	},
	{
		// DEVOPS-1403 -- VERBATIM (Agent Memory, incident ec3a109f-...).
		inputs: {
			query:
				'Investigate the "pvh-services-styles-v3" service as it is generating the error and error exception message below\n\nerror -> styles-v3-service exception: pvh.services.styles.exception.NotFoundWithDetailsException: ARTICLE_9999NOS00_LV04LC239GUB1007 is removed/archived. Detail data not found.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "elastic", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should determine whether NotFoundWithDetailsException for an archived/removed article represents correct, by-design behavior (the entity was legitimately archived upstream) rather than assuming it is a service defect. Response should check Couchbase for the article/variant's archival state and timestamp. Response should check whether callers of this endpoint (e.g. a connectors service) handle the 404 gracefully, and should not recommend a fix if the current behavior is already correct-by-design. Response should include a Gaps section if the full caller chain could not be traced.",
			referenceReport:
				"Executive Summary (DEVOPS-1403): pvh-services-styles-v3 is correctly throwing NotFoundWithDetailsException for article ARTICLE_9999NOS00_LV04LC239GUB1007 and variant VARIANT_9999NOS00_LV04LC239GUB1. These entities were permanently archived in the upstream PIM system (pim360/Stibo), propagated via Kafka to Couchbase, and are no longer present in the active styles.article and styles.variant collections. The service is functioning as designed. The incident is not a service defect or infrastructure failure. The root cause is a data-state mismatch: connectors-service (and potentially other callers) continued requesting these archived entities after archival, triggering the expected 404 response path. connectors-service handled the 404 gracefully (WARN-level log, fallback to Digital Showroom upsert with isActive=false). The error is logged at ERROR level inside styles-v3, inflating alert noise. A secondary concern: a growing error trend (4 occurrences a month prior, rising to 12 on the day of this ticket), all concentrated on the 9999NOS00 NOS season and the LV04LC239GUB1 variant family.",
			referenceFindings: {
				couchbase:
					"VARIANT_9999NOS00_LV04LC239GUB1 and all 10 child articles are confirmed archived with isDeletedPermanently=true: the eventing function moved articles to styles.archived_styles at 14:47:50Z, and a Kafka event from pim360 set the flag on the variant in styles_stibo.variant at 21:45:18Z. Neither entity is present in the live styles.article or styles.variant collections -- the expected post-archival state per DSDW-1986. Nine other active seasonal products remain for the parent style, confirming only the NOS variant was archived.",
				elastic:
					"15 total archived-entity errors over 30 days (2 article-level, 7 variant-level), with 12 of those occurring on 2026-07-23 alone -- a 4x jump over the preceding 13-day total of 3. Both error sub-types terminate in Couchbase KV operations, confirming the document was successfully retrieved before the exception was thrown by application logic detecting the archived state, not by a connectivity failure.",
				aws: "CloudWatch confirms connectors-service (eu-oit-prd) received the HTTP 404 at 22:15:12.890Z, logged it at WARN, and fell back to a Digital Showroom upsert with isActive=false, completing processing successfully -- the caller handles the archived-entity 404 gracefully. styles-v3-service itself is operationally healthy (2/2 ECS tasks, stable since the 2026-07-06 deployment), ruling out an infrastructure or deployment cause.",
			},
		},
	},
	{
		// DEVOPS-1404 -- VERBATIM (Agent Memory, incident 9d4818e5-...).
		inputs: {
			query:
				'Investigate the "prana-order-service" service error below\n\nerror -> "Error getting images for season C71 and division 02"\n\nerror exception message -> "404 Not Found: {\\"messages\\":[\\"Images for provided styleSeasonCode: C71, divisionCode: 02 and style/option code: DM0DM247711DA...\\"',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["aws", "couchbase", "elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should determine whether the 404 from the Images API represents a genuine missing-image-record data gap (upstream image catalog never onboarded this article) rather than assuming an infrastructure or code fault, and should check whether the Images service itself is healthy for other articles/divisions as corroborating evidence. Response should check whether the corresponding price document for the same article is also absent in Couchbase, as a signal of a broader onboarding gap rather than an image-specific bug. Response should include a Gaps section if the root timing of the onboarding gap could not be established.",
			referenceReport:
				"Executive Summary (DEVOPS-1404): prana-order-service is receiving HTTP 404 responses from the upstream Images v2 API when requesting image assets for styleSeasonCode C71, divisionCode 02, optionCode DM0DM247711DA. The Images v2 service is operating correctly and returning a well-formed, by-design 404 response. The root cause is a missing image record in the upstream image catalog for this specific article. Corroborating evidence: the price document for the same article (PRICE_THE1_01_58_EUR_DM0DM247711DA) is also absent from Couchbase, indicating the article was introduced into the order system before its supporting assets (images, prices) were fully onboarded. This is a chronic, multi-division data gap generating errors since at least 2026-06-25, with peak daily volumes exceeding 1,400 errors. No infrastructure failure, no code defect in prana-order-service, and no Kafka pipeline involvement were identified.",
			referenceFindings: {
				aws: "images-service (eu-shared-services-prd) returned HTTP 200, 994,596 bytes for GET /images/seasons/C71/divisions/02/products, confirming division 02 is populated and healthy for other articles -- the gap is article-specific. prices-api-v2-service separately logged a WARN 'Document not found for id: PRICE_THE1_01_58_EUR_DM0DM247711DA' 17 seconds before the image error, corroborating that the same article is missing from both the image and price asset pipelines.",
				couchbase:
					"Direct key lookup for IMAGE_02_C71_DM0DM247711DA returns DocumentNotFoundError, and index scans on IMAGES_optionCode and IMAGES_styleSeasonCode_divisionCode_id both return 0 rows for this option. Style DM0DM24771 is absent from all style and PIM collections (styles.product2g, styles.variant, styles.article, styles_stibo.*), while season C71/division 02 is otherwise populated with 30+ image records for other articles -- confirming the gap is specific to this one article, not the season/division combination.",
				elastic:
					"189 occurrences of org.springframework.web.client.HttpClientErrorException$NotFound over at least 3 days, marked error.exception.handled: true, affecting multiple ECS nodes cluster-wide. The Spring Retry interceptor is actively retrying the 404 responses before surfacing the error, adding unnecessary upstream load since a 404 here indicates data absence, not a transient failure.",
			},
		},
	},
	{
		// DEVOPS-1405 -- VERBATIM (Agent Memory, incident daf6d33d-...).
		inputs: {
			query:
				'Investigate the "prana-order-service" service for the error and error exception message below :-\n\n"Couldn\'t fetch seasons by company code: CK and season types: [DIVISIONAL, OUTLET]"\n\n"I/O error on GET request for \\"https://gateway.prd.shared-services.eu.pvh.cloud/v3/seasons/CK/seasons\\": ... 180000ms"',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["aws", "elastic", "atlassian"],
			minConfidence: 0.65,
			qualityRubric:
				"Response should name the 180-second (180000ms) client-deadline exhaustion as the failure and investigate the downstream corrected-delivery-dates service (behind the Kong gateway) as the likely bottleneck rather than the gateway itself. Response should check for a high-volume error loop in the downstream service (e.g. repeated 'no delivery dates' errors for an unregistered season code) as the plausible cause of thread-pool or data-layer saturation starving this request. Response should check Atlassian for related, previously-reported season-data-gap tickets and cite at least one if the pattern matches. Response should distinguish this timeout from any separate database-deadlock issue on the same service if one is also found. Response should include a Gaps section if the exact saturation mechanism could not be directly confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1405): prana-order-service is failing to fetch seasons for company code CK with season types [DIVISIONAL, OUTLET] because its HTTP GET to gateway.prd.shared-services.eu.pvh.cloud/v3/seasons/CK/seasons exhausts the full 180,000ms (3-minute) client deadline without receiving a response. The Kong gateway and its ALB are healthy (3/3 tasks, all targets healthy). The failure originates downstream of the gateway in the corrected-delivery-dates service, which is emitting approximately one 'No delivery dates' error every two seconds for season code 2027WISPWI/brand TH across all three of its task replicas. This high-volume error loop is the most likely cause of thread pool saturation or data-layer contention starving CK season requests. The underlying data gap -- season codes not registered in the delivery-dates data store -- is a recurring, unresolved platform-wide issue documented in five prior Jira tickets (DEVOPS-1385, 1389, 1395, 1396, 1397), all in Backlog. A secondary, independent issue -- PostgreSQL deadlocks on the b2b_order table (up to 969 events/hour) -- causes periodic ECS task cycling, a distinct failure mode from the season fetch timeout.",
			referenceFindings: {
				aws: "Kong gateway and ALB are healthy (3/3 tasks, all targets healthy). corrected-delivery-dates (which serves the /v3/seasons/ route -- no dedicated seasons-service exists in the estate) emits a 'No delivery dates' error approximately every 2 seconds for season 2027WISPWI/brand TH across all 3 task replicas, the most likely cause of thread-pool or data-layer contention starving CK season requests until the 180-second client deadline exhausts.",
				elastic:
					"3,077 occurrences of 'Couldn't fetch seasons by company code: CK and season types: [DIVISIONAL, OUTLET]' over 30 days, with 130 occurrences of the underlying I/O timeout exception at the 180,000ms deadline. The exception type org.apache.hc.core5.http.ConnectionRequestTimeoutException at acquireEndpoint() confirms the HTTP connection pool is exhausted waiting for a slot, not a network-level timeout -- Spring Retry on the client compounds this by holding pool slots across retries.",
				atlassian:
					"Five prior Jira tickets (DEVOPS-1385, 1389, 1395, 1396, 1397), all in Backlog and unassigned, document the same recurring, unresolved platform-wide season-data gap where season codes are not registered in the delivery-dates data store -- confirming this is a known systemic issue rather than a novel one-off failure.",
			},
		},
	},
	{
		// DEVOPS-1407 -- VERBATIM (Agent Memory, incident 277ad174-...).
		inputs: {
			query:
				'Investigate the "pvh-services-styles-v3" service for the error and error exception message below :-\n\n"styles-v3-service exception: com.couchbase.client.core.error.RequestCanceledException: QueryRequest, Reason: NO_MORE_RETRIES (CHANNEL_CLOSED_WHILE_IN_FLIGHT) {\\"cancelled\\":true...}"',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "aws", "kafka", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name RequestCanceledException / CHANNEL_CLOSED_WHILE_IN_FLIGHT as a Couchbase Capella query-service connectivity disruption and should investigate whether the TLS/TCP channel was closed by the remote (Capella) side rather than assuming a client-side timeout. Response should check Couchbase cluster/query-service telemetry (ping latency, node health) as corroborating evidence. Response should check whether Kafka Couchbase-sink connectors show correlated lag or stalls in the same window. Response should check Atlassian for prior related incidents on the same endpoint (this is a documented recurring pattern) and cite at least one if found. Response should rule out AWS network/security-group causes explicitly if route tables and security groups are confirmed healthy. Response should include a Gaps section if the exact remote-side cause of the channel closure could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1407): The leading diagnosis is a Couchbase Capella query-service connectivity disruption -- the TLS/TCP channel from styles-v3-service to the Capella private endpoint was closed by the remote side while a QueryRequest was in flight, producing RequestCanceledException: NO_MORE_RETRIES (CHANNEL_CLOSED_WHILE_IN_FLIGHT) with retry reason ENDPOINT_NOT_WRITABLE. Corroborated independently by Couchbase-side cluster telemetry (query-service ping latency 264,000-280,000ms, 2 FFDC entries on a node) and by AWS-side application stack traces showing SslHandler.channelInactive -- the TLS layer closed by the remote endpoint, not a client timeout. Not an AWS network/security-group problem (route tables, NAT gateway, and security group egress all confirmed healthy/permissive), and not a query-design problem (Couchbase EXPLAIN confirms fully covering index scans). Secondary contributing signal: Kafka Couchbase-sink connectors show small active lag consistent with intermittent write stalls, with zero DLQ accumulation. This is a recurring, chronic pattern -- DEVOPS-1353 documented the same endpoint and same source IP in a prior incident resolved 2026-07-15, recurring roughly every 1-3 days since 2026-07-01.",
			referenceFindings: {
				couchbase:
					"Query-service ping latency reads 264,000-280,000ms (vs. a normal single-digit-ms baseline) with 2 FFDC (fault) records logged on node svc-qi-node-135 -- direct evidence of query-service-side instability. EXPLAIN confirms the failing query itself uses fully covering index scans with no Fetch phase, ruling out query design as a contributing cause.",
				aws: "Application stack traces in eu-shared-services-prd show SslHandler.channelInactive -- the TLS layer was closed by the remote (Capella) side, not a client-side timeout (elapsed ~5.1-5.9s vs. a configured 75,000ms timeout). Network path (route tables, Transit Gateway, NAT gateway, security group sg-0ac93a0b035d94b63 egress) is confirmed healthy and permissive, ruling out AWS-side infrastructure.",
				kafka:
					"Couchbase-sink connectors show small active lag (connect-C_SINK_COUCHBASE_PRICES_DOCUMENTS: 103, ...PRICES_SUB_DOCUMENTS: 168, ...VARIANTS_V3: 76) consistent with intermittent write stalls against the same endpoint, with zero DLQ accumulation on the corresponding DLQ topics -- a secondary symptom of the same connectivity instability, not an independent cause.",
				atlassian:
					"DEVOPS-1353 documented the same Capella endpoint and the same source IP (10.34.51.61) in a prior incident resolved 2026-07-15 with a recorded root cause of an ECS security-group allowlist gap; incident volume for this service has risen from 1/month in April to 23/month in July, confirming this is a chronic, recurring, unresolved pattern rather than an isolated event.",
			},
		},
	},
	{
		// DEVOPS-1408 -- RECONSTRUCTED.
		inputs: {
			query:
				'Investigate the "prana-order-service" service for this error: java.lang.IllegalArgumentException: "The chosen brand and customer has no active seasons", thrown from OrderDivisionSeasonSetupService.findPossibleSeasons() during a nightly batch job (InBasketOrderSetupRecomputeBatchProcessor).',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "couchbase", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name IllegalArgumentException / 'no active seasons' as a caught, non-fatal application/data-layer failure (not an infrastructure fault) and identify OrderDivisionSeasonSetupService / InBasketOrderSetupRecomputeBatchProcessor as the throwing component. Response should check Couchbase for the referenced season records' active/expiry status as the underlying data cause. Response should check Atlassian for related, previously-reported season-data-gap tickets given this is a chronic platform-wide pattern, and cite at least one if found. Response should confirm via AWS/Kafka that infrastructure and messaging are healthy, ruling them out as contributors. Response should include a Gaps section naming anything not fully confirmed (e.g. why this specific batch run triggered more occurrences than usual).",
			referenceReport:
				"Executive Summary (DEVOPS-1408): prana-order-service (ECS service order-service, eu-oit-prd) is throwing java.lang.IllegalArgumentException: 'The chosen brand and customer has no active seasons' from OrderDivisionSeasonSetupService.findPossibleSeasons()/computeOrderSetup(), caught and logged by InBasketOrderSetupRecomputeBatchProcessor. This is a caught, non-fatal, application/data-layer failure, not an infrastructure or messaging failure. Evidence confirms a single nightly batch run produced 62+ occurrences across distinct order IDs, all sharing one trace ID. Couchbase Capella confirms the underlying season data is stale/expired. Atlassian confirms this is a chronic, previously reported, and currently unresolved platform-wide season-data gap (6 related Jira tickets, all in Backlog). Kafka and ECS/service-health checks rule out messaging backpressure or infrastructure instability as contributing causes. The service is not deployed in the eu-shared-services-prd AWS estate.",
			referenceFindings: {
				elastic:
					"184-194 occurrences of the paired error/exception over 30 days under a single error-grouping key, marked handled: true, with the stack trace confirming the call chain InBasketOrderSetupRecomputeScheduler -> BatchProcessor.processBatch() -> OrderDivisionSeasonSetupService.recomputeAndApplyOrderSetup() -> computeOrderSetup() -> findPossibleSeasons(). Errors fire in tight batch bursts sharing a single trace ID per run, consistent with a scheduled job rather than continuous request traffic.",
				aws: "ECS service order-service is ACTIVE (3/3 tasks, last steady state confirmed) -- infrastructure is healthy. CloudWatch Logs confirm the exact exception and timestamp for order 0003253972 and 22+ other orders in the same 2026-07-28T00:00Z batch run (62 occurrences in the first hour), all sharing trace ID 0d966e10cab01c15c35c0b8fbfd2f10b.",
				couchbase:
					"Sampled seasons.delivery_dates documents are both isActive: false with expired activeTo dates (2026-03-23 and 2025-12-16), directly confirming the underlying season data is stale. The collection has no queryable index on isActive, forcing a non-covering scan-and-fetch for the active-season lookup -- SEASONAL_ASSIGNMENT_C71_CKEU (the next season's assignment record) does not exist in new_model.seasonal_assignment.",
				atlassian:
					"Five prior linked Jira tickets (DEVOPS-1385, 1389, 1395, 1396, 1397) document the same failure class since 2026-07-09, all unassigned/Backlog; incident count for season-related errors has spiked from 16/week to 31/week in the week before this ticket, confirming a chronic, worsening, platform-wide season-data gap.",
			},
		},
	},
	{
		// DEVOPS-1410 -- VERBATIM (Agent Memory, incident 67d8ec99-...).
		inputs: {
			query:
				'Investigate the "localcore-service" service for the error and error exception message below :-\n\nError -> Initial load failed. currentUser=NASSCH currentPage=17 totalElapsedMs=56177\n\nError exception message -> Error while initial loading sold tos',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-shared-services-prd", "eu-oit-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "couchbase", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should resolve the surface-level 'Error while initial loading sold tos' message down to its underlying cause by checking Elasticsearch APM's deeper stack trace, and should name a PostgreSQL-layer constraint violation if that is what the trace reveals rather than stopping at the generic wrapper message. Response should check whether this correlates with a scheduled/nightly job (e.g. an assignment-sync cron trigger). Response should check Couchbase for load/latency on any backing collection queried during this operation as a contributing factor to elapsed time. Response should check Atlassian for related prior incidents on stale-assignment patterns in this same service family. Response should include a Gaps section if the exact constraint-violation record could not be directly tied to this specific occurrence.",
			referenceReport:
				"Executive Summary (DEVOPS-1410): The error 'Initial load failed. currentUser=NASSCH currentPage=17 totalElapsedMs=56177' and exception 'Error while initial loading sold tos' originate from localcore-service (eu-oit-prd, ECS cluster catalog-prd). Not deployed in eu-shared-services-prd. Confirmed by two independent datasources (Elasticsearch APM and AWS CloudWatch) agreeing on timestamp and host. Elasticsearch's deeper APM stack trace resolves the inner cause as a PostgreSQL unique-constraint violation on the assignment_division table during the nightlySyncAssignments scheduled job. Atlassian records document a separate, longer-running related pattern (EntityNotFoundException from stale Assignment UUIDs, tracked in DEVOPS-1390/1391/1389, all unresolved). Couchbase Capella shows the backing customer.assignments collection under heavy load from inefficient deep-pagination queries, a plausible contributing factor to elapsed time, though not directly traced to this specific request. Kafka is ruled out as a contributor: the customer-assignment-related consumer groups show zero lag.",
			referenceFindings: {
				elastic:
					"The exact incident document (host ip-10-35-13-213, trace id 9d37438744db5b79951b4531871850f4) resolves the full nested exception chain: ArcUndeclaredThrowableException -> RollbackException (ARJUNA016053) -> Hibernate ConstraintViolationException -> PSQLException: duplicate key value violates unique constraint 'pk_adiv' on table assignment_division. 114 occurrences of 'Initial load failed' and 340 of 'Error while initial loading sold tos' over 30 days.",
				aws: "The same log line was confirmed on ECS task 33d86d60 at 2026-07-28T10:45:57Z, triggered by CronTrigger nightlySyncAssignments, corroborating the timestamp and outer mechanism (though the raw CloudWatch capture was truncated before the inner PSQLException detail). 126 total matching records were found across 30 days. The ECS service itself is healthy (3/3 tasks).",
				couchbase:
					"The SoldToNumbers-joined assignments query executed 2,481 times in one day with a scan-to-return ratio of roughly 1,588:1 (avg_indexScanResults 31,751 vs avg_resultCount 20), and individual deep-OFFSET executions show wait times of 22.4-25.1 seconds against service times of only 3.9-4.4 seconds -- a plausible but not directly traced contributing factor to the 56-second elapsed time observed for this specific request (no shared trace ID links a specific Couchbase execution to this incident).",
				atlassian:
					"Three related, unresolved, Backlog-status tickets exist for localcore-service (DEVOPS-1390: EntityNotFoundException from stale Assignment UUIDs; DEVOPS-1391: 503 from customer-assignments-service; DEVOPS-1389: nightly variant stock sync failure), all unassigned with MTTR null -- confirming this is part of a longer-running, untriaged pattern rather than a first occurrence.",
			},
		},
	},
	{
		// DEVOPS-1411 -- RECONSTRUCTED.
		inputs: {
			query:
				'Investigate the "prana-order-service" service -- getting "Order item MW0MW37267BDS in order 0003312010 does not have active season and is invalid for update" from OrderItemQuantityService.updateQuantities(). Is this related to the other season-validation failures we\'ve been seeing?',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-shared-services-prd", "eu-oit-prd"],
		},
		outputs: {
			expectedDatasources: ["elastic", "aws", "couchbase", "atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name this as a deliberate, non-fatal business-logic rejection from OrderItemQuantityService.updateQuantities() rather than an infrastructure or code defect, and should directly address whether it relates to other season-validation failures by checking for a shared root cause (stale/expired season reference data). Response should check Couchbase for the specific season document's active/expiry status. Response should check Atlassian for the related prior tickets on this same failure class and explicitly confirm or refute the connection rather than leaving it unaddressed. Response should confirm via Kafka/Couchbase infrastructure health that this is not a messaging or connectivity issue. Response should include a Gaps section for anything not directly confirmed for this specific order item.",
			referenceReport:
				"Executive Summary (DEVOPS-1411): The error is a deliberate, non-fatal business-logic rejection thrown by OrderItemQuantityService.updateQuantities() in prana-order-service: the service calls SeasonV3Service.findActiveSeasonBySalesOrganizationCodeFmsSeasonCodeAndDivisionCode(...), which returned Optional.empty() for order item MW0MW37267BDS, so an IllegalArgumentException was thrown and the update was rejected. Independently confirmed with matching timestamps and trace IDs in both Elasticsearch and AWS CloudWatch Logs, a burst of 4 client calls within a 14-second window. Kafka and Couchbase infrastructure are healthy and show no fatal queries, consumer lag, or DLQ accumulation tied to this order. Atlassian evidence (DEVOPS-1408) shows the identical 'no active season' failure mode occurring 62+ times in a nightly batch the day before, with Couchbase season documents confirmed isActive:false in that ticket's own investigation -- corroborating (but not directly confirming for this specific item) that stale/expired season reference data is the systemic driver. prana-order-service is confirmed not deployed in eu-shared-services-prd; deployed and healthy (3/3 ECS tasks) in eu-oit-prd.",
			referenceFindings: {
				elastic:
					"4 ERROR-level records within a 14-second window (2026-07-29T09:33:12.604Z-09:33:27.099Z) across 2 hosts and 4 distinct trace IDs, with the full stack trace tracing OrderItemQuantityService.lambda$updateQuantities$0:184 -> updateQuantities:176 -> GraphQL mutation entry. The failure is authenticated and transactional (wrapped in TransactionInterceptor with full rollback).",
				aws: "The identical 8-entry log match (4 ERROR + 4 paired IllegalArgumentException stack traces) was independently confirmed in /ecs/fargate/eu-oit-prd-log-group with trace IDs matching Elasticsearch exactly. A 30-day frequency count found 404 total occurrences of 'Unable to update quantities' variants with spikes on 2026-07-06, 2026-07-15, and 2026-07-24, alongside related reason strings pointing to the same season/delivery-date data domain.",
				couchbase:
					"Cluster health confirms all 12 nodes healthy, 0% queue depth, 0 fatal N1QL requests in the past day -- ruling out a database or infrastructure fault. An index plan for order.archived-order-items resolves for orderId=0003312010 AND optionCode=MW0MW37267BDS, confirming the item exists in this collection.",
				atlassian:
					"DEVOPS-1408 (created the prior day) documents the identical 'no active season' failure mode occurring 62+ times in a nightly batch across 23+ order IDs, with that ticket's own Couchbase investigation confirming season documents with isActive:false and expired activeTo dates -- corroborating, though not directly confirming for this specific item, that stale/expired season reference data is the systemic driver.",
			},
		},
	},
	{
		// DEVOPS-1412 -- RECONSTRUCTED.
		inputs: {
			query:
				'Investigate the "pvh-services-styles-v3" service for this error: com.couchbase.client.core.error.UnambiguousTimeoutException on GetRequest against default.styles.product2g/variant/article -- error volume spiked roughly 33x over a 30-minute window.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "elastic", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should investigate whether the timeout spike is network/dispatch-layer (client-side saturation) versus Couchbase server-side, by checking Couchbase SDK orphan-request telemetry (server duration vs dispatch duration) if available, rather than assuming a database-side fault. Response should report Couchbase cluster health as a separate check from the timeout volume itself. Response should check AWS ECS CPU/resource utilization for the service during the spike window as a candidate cause of I/O-thread starvation. Response should check whether this matches a previously documented chronic pattern on the same Capella cluster and cite a related ticket if found. Response should include a Gaps section if the precise trigger for the spike could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1412): pvh-services-styles-v3 (eu-shared-services-prd) is throwing com.couchbase.client.core.error.UnambiguousTimeoutException on KV GetRequest operations against Couchbase Capella collections product2g/variant/article. Errors burst from a baseline of single digits to 5,375 events in a 30-minute window -- a 33x spike over the prior window. AWS CloudWatch Logs show the Couchbase SDK's own orphan-request telemetry indicates the delay is network/dispatch-layer, not server-side: total_server_duration_us of 3-27 microseconds against dispatch_duration_us of 1.1-3.3 seconds, with 628-2,730 orphaned KV requests per 10-second window. This matches a chronic, previously documented pattern on the same Capella cluster per DEVOPS-1407, which is unassigned and unresolved. Two GitLab MRs merged shortly before (adding then removing an FTS default_analyzer, triggering FTS index rebuilds) are candidate, unconfirmed contributing factors. Sibling investigation DEVOPS-1413 (a single-event deep-dive within the same multi-hour error-burst window) subsequently identified the specific burst mechanism: sustained 100% CPU saturation on the service's ECS Fargate tasks starving the Couchbase SDK's I/O threads -- consistent with the orphan-telemetry dispatch-layer signature -- with error volume dropping sharply after an ECS deployment/task restart.",
			referenceFindings: {
				couchbase:
					"The target document (PRODUCT_2027WISPSP_LV04F3853G) exists and is fully populated, ruling out a missing-data cause. All 6 KV nodes are healthy, but bucket.IO.stats.default.retries reads 405,373/385,831 across two query nodes with large cumulative background-fetch time -- consistent with storage/network-side pressure. A concurrent UNION ALL query shows waitTime 24.46s against elapsedTime 4.915s, indicating query-node saturation cascading into KV thread-pool pressure.",
				elastic:
					"5,972 UnambiguousTimeoutException records in 24h split evenly across two hosts (2,998 and 2,974), ruling out a single-node/pod issue. The apm-errors-rare-grouping-by-service ML job fired 22 records for novel error-grouping keys during the burst, consistent with a newly-emerged failure mode.",
				aws: "The Couchbase SDK's own orphan-request telemetry (via CloudWatch) shows total_server_duration_us of 3-27 microseconds against dispatch_duration_us of 1.1-3.3 seconds, with 628-2,730 orphaned KV requests per 10-second window -- direct evidence the server answers almost instantly and the delay is network/dispatch-layer, not server-side. The network path (security groups, NACLs, Transit Gateway) to the Couchbase private endpoint is confirmed fully permissive and healthy.",
			},
		},
	},
	{
		// DEVOPS-1413 -- RECONSTRUCTED. Same signature family as DEVOPS-1412, single-document
		// instance during the same multi-hour burst.
		inputs: {
			query:
				'Investigate the "pvh-services-styles-v3" service -- Couchbase KV GetRequest UnambiguousTimeoutException on document ARTICLE_2025SUFAFA_MW0MW26619YCF013 (bucket default, scope styles, collection article), timeout budget 2500ms, actual elapsed just over that.',
			uiSelectedDataSources: ["elastic", "kafka", "couchbase", "gitlab", "atlassian", "aws"],
			uiSelectedElasticDeployments: ["eu-b2b"],
			uiSelectedAwsEstates: ["eu-oit-prd", "eu-shared-services-prd"],
		},
		outputs: {
			expectedDatasources: ["couchbase", "elastic", "aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should treat this single-document timeout as part of a broader multi-hour error-burst pattern rather than an isolated one-off, and should check Elasticsearch/AWS logs for the surrounding burst window. Response should investigate whether ECS CPU saturation on the service's own tasks (starving the Couchbase SDK's I/O threads) is the more likely cause than a Couchbase server-side or Kafka-pipeline fault. Response should check whether an ECS deployment/restart during or after the burst correlates with recovery. Response should reference a related prior/chronic ticket on the same error signature if one is found. Response should include a Gaps section if the precise CPU-saturation trigger could not be confirmed.",
			referenceReport:
				"Executive Summary (DEVOPS-1413): The service emitted com.couchbase.client.core.error.UnambiguousTimeoutException on a Couchbase KV GetRequest for document ARTICLE_2025SUFAFA_MW0MW26619YCF013 (bucket default, scope styles, collection article), timeout budget 2500ms, actual elapsed 2515.094ms, retried:0. This single event is part of a documented multi-hour error-burst pattern that peaked with 3,720 errors in a 5-minute bucket. Evidence from AWS, Elasticsearch, and Couchbase agrees that the burst mechanism was CPU saturation on the service's ECS Fargate tasks (sustained at 100%) starving the Couchbase SDK's I/O threads -- not a Couchbase server-side or Kafka-pipeline failure. The service is not deployed in eu-oit-prd (confirmed by full ECS/log-group enumeration); deployed and running in eu-shared-services-prd. An active Jira incident (DEVOPS-1412) and a chronic predecessor (DEVOPS-1407) corroborate the pattern as recurring roughly every 1-3 days since 2026-07-01. Error volume dropped sharply after an ECS deployment/task restart.",
			referenceFindings: {
				couchbase:
					"The target document exists and is fully populated. All 12 cluster nodes are healthy with KV ping latency 24-34ms and zero fatal N1QL requests in the trailing day, but node svc-qi-node-135 shows 2 FFDC (crash-dump) entries despite reporting healthy status. N1QL queries from S_APP_STYLES show wait times of 21.3-24.5 seconds against elapsed times of 4.3-4.9 seconds, indicating a severe query-node queue backlog from non-covering-index fetches of 2,750-8,089 article documents per execution.",
				elastic:
					"8,112 total error-type events in the 24h window, of which 6,377 are UnambiguousTimeoutException; secondary co-occurring error types (StacklessClosedChannelException: 1,198, NativeIoException: 269) are consistent with forcibly closed TCP connections during the burst windows. ML jobs for high mean response time and high error rate both fired at the 14:30-14:35 UTC window with 5-31x deviation from baseline.",
				aws: "ECS task CPU was sustained at 100 percent during the burst windows (14:30-15:00 and 16:30-17:30 UTC), confirmed via CloudWatch metrics -- this starved the Couchbase SDK's Netty I/O and timer threads, preventing KV GetRequest responses from being processed within the 2500ms budget. Many error records show totalServerMicros: 0, indicating the server response never arrived within the client's timeout window from the client's own perspective. No CPU-high alarm exists for this service, only scale-down alarms.",
			},
		},
	},
];
