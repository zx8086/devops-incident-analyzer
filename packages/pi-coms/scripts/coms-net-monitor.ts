// scripts/coms-net-monitor.ts

import * as os from "node:os";
import * as path from "node:path";
import { ACMClient } from "@aws-sdk/client-acm";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EKSClient } from "@aws-sdk/client-eks";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { GuardDutyClient } from "@aws-sdk/client-guardduty";
import { HealthClient } from "@aws-sdk/client-health";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { RDSClient } from "@aws-sdk/client-rds";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { SupportClient } from "@aws-sdk/client-support";
import { fromInstanceMetadata } from "@aws-sdk/credential-providers";
import { isBlankReply } from "../contracts/reply.ts";
import {
	type BudgetLimits,
	type InvestigationOutcome as BudgetOutcome,
	type InvestigationRecord,
	investigationUsage,
	planInvestigation,
	REFUSED_PREFIX,
} from "./monitor/budget.ts";
import { s3Store, saveCheckpoint, statePrefix } from "./monitor/checkpoint.ts";
import { checkAlarms } from "./monitor/checks/alarms.ts";
import { certRegions, checkCerts, checkListenerCerts } from "./monitor/checks/certs.ts";
import { checkCompliance } from "./monitor/checks/compliance.ts";
import { COST_DEFAULTS, checkCost } from "./monitor/checks/cost.ts";
import { checkDbEvents } from "./monitor/checks/db-events.ts";
import { checkDrift } from "./monitor/checks/drift.ts";
import { checkGuardDuty } from "./monitor/checks/guardduty.ts";
import { checkHealth } from "./monitor/checks/health.ts";
import { checkIdentity, type GateResult } from "./monitor/checks/identity.ts";
import { checkIngestion } from "./monitor/checks/ingestion.ts";
import { checkLogs } from "./monitor/checks/logs.ts";
import { checkNodegroups } from "./monitor/checks/nodegroups.ts";
import { checkQueues } from "./monitor/checks/queues.ts";
import { checkQuotas } from "./monitor/checks/quotas.ts";
import { checkResourceDrift } from "./monitor/checks/resource-drift.ts";
import { checkScaling } from "./monitor/checks/scaling.ts";
import { checkStacks } from "./monitor/checks/stacks.ts";
import { checkTargets } from "./monitor/checks/targets.ts";
import { checkTasks } from "./monitor/checks/tasks.ts";
import { checkTrail } from "./monitor/checks/trail.ts";
import { checkWatchlist } from "./monitor/checks/watchlist.ts";
import { MonitorComs } from "./monitor/coms.ts";
import {
	applyControl,
	describeControls,
	envInvestigateDefault,
	investigationDisabledFailure,
	parseControlCommand,
	readControls,
} from "./monitor/controls.ts";
import { errorMessage } from "./monitor/errors.ts";
import { formatHistory, parseHistoryArgs } from "./monitor/history.ts";
import {
	checkErrorCountsFromJournal,
	DIAGNOSIS_RESPONSE_SCHEMA,
	type Diagnosis,
	DiagnosisSchema,
	type Finding,
	findingCountsFromJournal,
	formatDigest,
	formatIncidentReport,
	formatSuppressionReview,
	notablesFromJournal,
	parseDiagnoses,
	suppressionReviewFromJournal,
} from "./monitor/report.ts";
import { MonitorState } from "./monitor/state.ts";

const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "unknown";
const MONITOR_NAME = process.env.PI_MONITOR_NAME ?? `monitor-aws-${ACCOUNT_ID}`;
const REPORT_TO = process.env.PI_MONITOR_REPORT_TO ?? "laptop";
const REPORT_TTL_MS = Number(process.env.PI_MONITOR_REPORT_TTL_MS ?? 1_209_600_000);
const CHECK_CRON = process.env.PI_MONITOR_CHECK_CRON ?? "*/15 * * * *";
// Minute 7 deliberately: never a */15 boundary, so the hourly guard cannot
// collide with the check guard (see the midnight-collision note below).
const HOURLY_CRON = process.env.PI_MONITOR_HOURLY_CRON ?? "7 * * * *";
const DAILY_CRON = process.env.PI_MONITOR_DAILY_CRON ?? "@daily";
// Anti-masking cadence: the ledger hides findings by design, so what it ate
// gets re-surfaced on a schedule. Monthly cadence: cron "0 0 1 * *", window 31.
const REVIEW_CRON = process.env.PI_MONITOR_REVIEW_CRON ?? "@weekly";
// Bun.cron reads a schedule in the HOST's zone, and nothing in the bootstrap or
// the agent module ever sets TZ -- so a spoke interprets every cron above in UTC.
// An operator wanting a wall-clock local digest had to hand-convert, and the
// result drifted by an hour at each DST boundary. Naming a zone here pins the
// schedules to wall-clock time instead; unset keeps the host zone, so deployed
// behaviour is unchanged until someone sets it. The option key is `tz`: Bun
// accepts and silently IGNORES an unknown key, so a typo would read as a working
// config while the schedule quietly stayed on host time.
const MONITOR_TZ = process.env.PI_MONITOR_TZ;
const cronOpts = MONITOR_TZ ? { tz: MONITOR_TZ } : undefined;
// bun-types 1.3.12 declares only the 2-arg callback overload; the `tz` option is
// a 1.4 runtime feature (hosts run 1.4.2, verified 3-arg accepted). Typed narrowly
// here rather than cast at each call site, so the shim disappears by deleting this
// one line once @types/bun catches up.
const cronTz = Bun.cron as unknown as (schedule: string, handler: () => unknown, options?: { tz: string }) => unknown;
const REVIEW_WINDOW_DAYS = Number(process.env.PI_MONITOR_REVIEW_WINDOW_DAYS ?? 7);
const INVESTIGATE_TARGET = process.env.PI_MONITOR_INVESTIGATE_TARGET ?? `aws-${ACCOUNT_ID}`;
const INVESTIGATE_TIMEOUT_MS = Number(process.env.PI_MONITOR_INVESTIGATE_TIMEOUT_MS ?? 300_000);
const INVESTIGATE_PER_FINDING_MS = Number(process.env.PI_MONITOR_INVESTIGATE_PER_FINDING_MS ?? 60_000);
const INVESTIGATE_MAX_MS = Number(process.env.PI_MONITOR_INVESTIGATE_MAX_MS ?? 1_800_000);
// Boot default only; the persisted `investigate on|off` control wins (SIO-1673).
const INVESTIGATE_DEFAULT = envInvestigateDefault(process.env.PI_MONITOR_INVESTIGATE);
// Every investigation is a full model turn on the account agent: cap prompts
// per rolling day, and per resource, so one noisy source cannot buy unbounded
// turns (72 warn findings on one log group in a day was observed, SIO-1673).
// A malformed value must not switch the rail off (NaN compares false) or
// jam it shut (empty string is 0): anything but a non-negative integer keeps
// the default.
export function envCount(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}
const INVESTIGATE_BUDGET: BudgetLimits = {
	perDay: envCount(process.env.PI_MONITOR_INVESTIGATE_BUDGET_PER_DAY, 24),
	perResourcePerDay: envCount(process.env.PI_MONITOR_INVESTIGATE_PER_RESOURCE_PER_DAY, 3),
};
const DAY_MS = 86_400_000;
// SIO-1739: a dedup_key diagnosed inside the cooldown reuses that diagnosis
// instead of spending a turn; one the budget holds back reuses a diagnosis up
// to a day old. Cooldown 0 turns the hold-back off (reuse then only fills in
// for budget-skipped findings).
const INVESTIGATE_REUSE = {
	cooldownMs: envCount(process.env.PI_MONITOR_INVESTIGATE_COOLDOWN_MINUTES, 360) * 60_000,
	windowMs: DAY_MS,
};

// A flat await discards an agent's completed work whenever the batch is big
// enough to outrun it (observed: 19 findings vs the 5-min default). Scale the
// budget with the batch, capped so one huge batch cannot stall cycles all day.
export function investigateBudgetMs(
	findingCount: number,
	baseMs = INVESTIGATE_TIMEOUT_MS,
	perFindingMs = INVESTIGATE_PER_FINDING_MS,
	maxMs = INVESTIGATE_MAX_MS,
): number {
	return Math.min(baseMs + perFindingMs * findingCount, maxMs);
}
// SIO-1680: an absolute gate. A day-over-baseline rise under $100 is noise for
// this fleet; anything over is one warn finding. PCT 0 disables the percentage
// filter so a $100 rise on a large baseline is not hidden by a small ratio.
// An unparseable override falls back to the default instead of becoming NaN,
// which would silence the check without a trace.
function envNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}
const COST_PCT = envNumber(process.env.PI_MONITOR_COST_PCT, COST_DEFAULTS.pct);
const COST_ABS = envNumber(process.env.PI_MONITOR_COST_ABS, COST_DEFAULTS.abs);
const LOGS_FILTER = process.env.PI_MONITOR_LOGS_FILTER; // check default applies when unset
const LOGS_MAX_GROUPS = process.env.PI_MONITOR_LOGS_MAX_GROUPS
	? Number(process.env.PI_MONITOR_LOGS_MAX_GROUPS)
	: undefined;
const LOGS_EXCLUDE = (process.env.PI_MONITOR_LOGS_EXCLUDE ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const JOURNAL_RETAIN_MS = Number(process.env.PI_MONITOR_JOURNAL_RETAIN_DAYS ?? 90) * 86_400_000;
// envNumber, not Number(): a bare Number("") is 0 and Number("ten") is NaN, and
// `baseline >= NaN` is always false, which would silence the check with no trace.
const INGEST_MIN_EVENTS = envNumber(process.env.PI_MONITOR_INGEST_MIN_EVENTS, 10);
const INGEST_ZERO_HOURS = envNumber(process.env.PI_MONITOR_INGEST_ZERO_HOURS, 3);
const WATCHLIST = (process.env.PI_MONITOR_WATCHLIST ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const CERT_WARN_DAYS = Number(process.env.PI_MONITOR_CERT_WARN_DAYS ?? 30);
const CERT_CRIT_DAYS = Number(process.env.PI_MONITOR_CERT_CRIT_DAYS ?? 7);
const STATE_DB = process.env.PI_MONITOR_STATE_DB ?? path.join(os.homedir(), ".pi", "monitor", "state.db");
// SIO-1745: the root volume dies with the instance, and a userdata-affecting
// change (pi_model among them) replaces it. Derived from the bundle uri the
// host already has, so enabling this adds no userdata variable -- which would
// itself replace every spoke.
const BUNDLE_S3_URI = process.env.BUNDLE_S3_URI ?? "";
const CHECKPOINT_ENABLED = process.env.PI_MONITOR_CHECKPOINT_ENABLED !== "false" && BUNDLE_S3_URI !== "";
const CHECKPOINT_CRON = process.env.PI_MONITOR_CHECKPOINT_CRON ?? "23 */6 * * *";

export type InvestigationOutcome = {
	diagnoses: Map<string, Diagnosis> | null;
	failure: string | null;
};

export type CycleDeps = {
	// T0: runs before everything; unhealthy skips the checks for this cycle
	// (a broken identity turns every check into correlated noise).
	gate?: { name: string; run: () => Promise<{ findings: Finding[]; healthy: boolean }> };
	checks: { name: string; run: () => Promise<Finding[]> }[];
	state: MonitorState;
	investigate: ((findings: Finding[], priorContext: string) => Promise<InvestigationOutcome>) | null;
	// Absent: no caps (unit tests); main() always sets it.
	budget?: BudgetLimits;
	// SIO-1739: a dedup_key the agent diagnosed within cooldownMs is not sent
	// again, it reuses that diagnosis; one held back by the budget reuses a
	// diagnosis up to windowMs old. Absent: every warn+ finding is sent.
	reuse?: { cooldownMs: number; windowMs: number };
	report: (text: string) => Promise<void>;
	log: (line: string) => void;
};

export async function runCycle(deps: CycleDeps): Promise<{ findings: Finding[]; suppressed: number }> {
	const collected: Finding[] = [];
	let gated = false;
	if (deps.gate) {
		try {
			const g = await deps.gate.run();
			collected.push(...g.findings);
			gated = !g.healthy;
			if (gated) deps.log(`gate ${deps.gate.name} unhealthy: skipping checks this cycle`);
		} catch (e) {
			// A throwing gate is an unknown, not a proven failure: journal it and
			// let the checks report reality.
			deps.state.journal("check_error", { check: deps.gate.name, error: errorMessage(e) });
			deps.log(`gate ${deps.gate.name} threw: ${errorMessage(e)}`);
		}
	}
	if (!gated) {
		for (const c of deps.checks) {
			try {
				collected.push(...(await c.run()));
			} catch (e) {
				deps.state.journal("check_error", { check: c.name, error: errorMessage(e) });
				deps.log(`check ${c.name} failed: ${errorMessage(e)}`);
			}
		}
	}

	// Ledger pass: operator-accepted findings are history, not alerts. This is
	// also the noise control for a new or noisy check family: `suppress
	// <family>:% | reason` holds a whole family back per account, reversibly,
	// with a mandatory reason and a weekly review. SIO-1752 removed the separate
	// default-on shadow mechanism in its favour -- measured against production,
	// shadow delayed real incidents and caught one noise source, which was a
	// severity bug rather than an inherent rate.
	const findings: Finding[] = [];
	let suppressed = 0;
	for (const f of collected) {
		const m = deps.state.matchSuppression(f.dedup_key);
		if (m) {
			suppressed++;
			deps.state.journal("suppressed_finding", { ...f, suppressed_by: m.pattern, reason: m.reason });
		} else {
			findings.push(f);
		}
	}

	if (findings.length > 0) {
		const toInvestigate = findings.filter((f) => f.severity !== "info");
		let diagnoses: Map<string, Diagnosis> | null = null;
		let investigationFailure: string | null = null;
		// Reuse pass (SIO-1739): the same dedup_key diagnosed within the cooldown
		// is the same incident still flapping; re-asking spent a turn per flap
		// and burned the per-resource cap, after which the finding shipped
		// "uninvestigated" while its diagnosis sat in the journal.
		const skipped = new Map<string, string>();
		const reused = new Map<string, { ts: string; diagnosis: Diagnosis }>();
		let batch = toInvestigate;
		if (deps.reuse) {
			const { cooldownMs, windowMs } = deps.reuse;
			batch = [];
			for (const f of toInvestigate) {
				const prior = deps.state.priorDiagnosis(f.dedup_key, Math.max(cooldownMs, windowMs));
				const parsed = prior ? DiagnosisSchema.safeParse(prior.diagnosis) : null;
				const ageMs = prior ? Date.now() - Date.parse(prior.ts) : Number.POSITIVE_INFINITY;
				if (prior && parsed?.success) reused.set(f.dedup_key, { ts: prior.ts, diagnosis: parsed.data });
				if (prior && parsed?.success && cooldownMs > 0 && ageMs <= cooldownMs) {
					skipped.set(f.dedup_key, `diagnosed ${Math.round(ageMs / 60_000)} min ago, within cooldown`);
				} else {
					batch.push(f);
				}
			}
		}
		// Budget pass: findings over the daily or per-resource cap still ship,
		// each with its own reason, but never reach the agent.
		if (deps.budget && batch.length > 0) {
			const usage = investigationUsage(deps.state.journalRows(DAY_MS, "investigation"));
			const plan = planInvestigation(batch, usage, deps.budget);
			batch = plan.send;
			for (const s of plan.skipped) skipped.set(s.finding.dedup_key, s.reason);
			if (plan.skipped.length > 0) {
				deps.log(`investigation budget: ${plan.skipped.length} finding(s) held back, ${batch.length} sent`);
			}
		}
		// A reused diagnosis only stands in for a finding that was not sent;
		// a fresh answer always wins.
		for (const key of reused.keys()) if (!skipped.has(key)) reused.delete(key);
		if (batch.length > 0 && deps.investigate) {
			const prior = batch
				.flatMap((f) => deps.state.priorIncidents(f.resource, 3))
				.map((r) => `${r.ts}: ${r.payload}`)
				.join("\n");
			try {
				const outcome = await deps.investigate(batch, prior);
				diagnoses = outcome.diagnoses;
				investigationFailure = outcome.failure;
			} catch (e) {
				diagnoses = null;
				investigationFailure = `investigate threw: ${errorMessage(e)}`;
			}
			if (investigationFailure) deps.log(`investigation failed: ${investigationFailure}`);
		}
		for (const f of findings) {
			const r = reused.get(f.dedup_key);
			deps.state.journal("finding", {
				...f,
				diagnosis: diagnoses?.get(f.dedup_key) ?? r?.diagnosis ?? null,
				...(r ? { reused_from: r.ts } : {}),
			});
		}
		const text = formatIncidentReport(
			ACCOUNT_ID,
			findings.map((f) => ({
				finding: f,
				diagnosis: diagnoses?.get(f.dedup_key) ?? reused.get(f.dedup_key)?.diagnosis ?? null,
				skipped: skipped.get(f.dedup_key),
				reusedFrom: reused.get(f.dedup_key)?.ts,
			})),
			investigationFailure,
			suppressed,
		);
		try {
			await deps.report(text);
		} catch (e) {
			deps.state.queueUnsent(REPORT_TO, text, REPORT_TTL_MS);
			deps.log(`report failed, queued locally: ${errorMessage(e)}`);
		}
	}

	for (const u of deps.state.unsent()) {
		try {
			await deps.report(u.prompt);
			deps.state.deleteUnsent(u.id);
		} catch {
			break; // hub still unreachable; keep order, try next cycle
		}
	}

	deps.state.journal("run", { findings: findings.length, suppressed });
	return { findings, suppressed };
}

// Serializes runs across trigger sources (cron tick, run-checks command).
// Bun.cron already guarantees no overlap per job; this covers cross-source
// overlap by skipping, not queueing.
export function makeGuard(): (fn: () => Promise<void>) => Promise<void> {
	let running = false;
	return async (fn) => {
		if (running) return;
		running = true;
		try {
			await fn();
		} finally {
			running = false;
		}
	};
}

function main(): void {
	const region = process.env.AWS_REGION;
	const state = new MonitorState(STATE_DB);
	const cw = new CloudWatchClient({ region });
	const logs = new CloudWatchLogsClient({ region });
	const ec2 = new EC2Client({ region });
	const ce = new CostExplorerClient({ region: "us-east-1" }); // Cost Explorer is us-east-1 only
	const sts = new STSClient({ region });
	const cloudtrail = new CloudTrailClient({ region });
	const certScanRegions = certRegions(region, process.env.PI_MONITOR_CERT_REGIONS);
	const acmClients = certScanRegions.map((r) => ({
		region: r,
		client: new ACMClient({ region: r }),
	}));
	// Same regions, different service: SNI certificates hang off ELBv2 listeners,
	// which ACM never reports.
	const elbClients = certScanRegions.map((r) => ({
		region: r,
		client: new ElasticLoadBalancingV2Client({ region: r }),
	}));
	const rds = new RDSClient({ region });
	const lambda = new LambdaClient({ region });
	// SIO-1740: the Health API is a global endpoint served from us-east-1.
	const health = new HealthClient({ region: "us-east-1" });
	const config = new ConfigServiceClient({ region });
	const guardduty = new GuardDutyClient({ region });
	// SIO-1748 workload-state clients. The ELBv2 client above is region-keyed
	// for the cert scan; the targets check wants the host region only, since a
	// target group is reachable from the account it lives in.
	const elbv2 = new ElasticLoadBalancingV2Client({ region });
	const ecs = new ECSClient({ region });
	const sqs = new SQSClient({ region });
	const autoscaling = new AutoScalingClient({ region });
	const cloudformation = new CloudFormationClient({ region });
	const eks = new EKSClient({ region });
	// Trusted Advisor is a us-east-1-only API regardless of where the account
	// operates, the same way Cost Explorer is.
	const support = new SupportClient({ region: "us-east-1" });
	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

	// Best-effort by design: a checkpoint failure is logged and the monitor
	// carries on. Losing a backup must never cost us the monitor itself.
	const checkpoint = async (trigger: string): Promise<void> => {
		if (!CHECKPOINT_ENABLED) return;
		try {
			const prefix = statePrefix(BUNDLE_S3_URI, ACCOUNT_ID, MONITOR_NAME);
			// Instance role, NOT the ambient AWS_PROFILE=devops-readonly: the
			// workload role carries an explicit Deny on s3:GetObject (Sid
			// SecretAndDataPlaneDeny), so a default client would fail the restore
			// and, worse, pass the write while never being able to read it back.
			const store = s3Store(new S3Client({ region, credentials: fromInstanceMetadata() }));
			const res = await state.withDb((db) =>
				saveCheckpoint(db, store, prefix, { accountId: ACCOUNT_ID, agent: MONITOR_NAME }),
			);
			if (res.ok) {
				log(
					`checkpoint (${trigger}): ${res.bytes} bytes, ${res.rows.suppressions} suppressions, ${res.rows.journal} journal rows`,
				);
			} else {
				log(`checkpoint (${trigger}) FAILED: ${res.reason}`);
			}
		} catch (e) {
			log(`checkpoint (${trigger}) FAILED: ${errorMessage(e)}`);
		}
	};

	const gate = {
		name: "identity",
		run: (): Promise<GateResult> => checkIdentity(sts, state, { expectedAccountId: ACCOUNT_ID }),
	};

	// Deploy canary for the digest: the bundle version this monitor is running.
	const bundleFile = path.resolve(import.meta.dir, "..", ".bundle-version");
	const bundleVersion = async (): Promise<string | null> => {
		try {
			const v = (await Bun.file(bundleFile).text()).trim();
			return v || null;
		} catch {
			return null; // dev checkout: no bundle file
		}
	};

	// Assigned after construction; the onPrompt closure runs only once the SSE
	// stream is open, well after assignment.
	let handleCommand: (prompt: string) => Promise<string> = async () => "monitor still starting";

	const coms = new MonitorComs({
		serverUrl: process.env.PI_COMS_NET_SERVER_URL ?? "http://127.0.0.1:8787",
		token: process.env.PI_COMS_NET_AUTH_TOKEN ?? "",
		project: process.env.PI_COMS_NET_PROJECT ?? process.env.COMS_PROJECT ?? "default",
		name: MONITOR_NAME,
		purpose: `Deterministic AWS monitor for account ${ACCOUNT_ID}`,
		onPrompt: async (p) => handleCommand(p.prompt),
	});

	// Persisted operator controls; the env value only seeds a fresh state db.
	let controls = readControls(state, { investigate: INVESTIGATE_DEFAULT });

	const investigate = async (findings: Finding[], prior: string): Promise<InvestigationOutcome> => {
		if (!controls.investigate) return { diagnoses: null, failure: investigationDisabledFailure(controls) };
		// Journaled with its outcome once the reply is in: the budget counts
		// turns the agent spent (failed and timed-out ones included), never a
		// refusal it answered without a turn.
		const record = (outcome: BudgetOutcome): void => {
			const row: InvestigationRecord = {
				resources: [...new Set(findings.map((f) => f.resource))],
				dedup_keys: findings.map((f) => f.dedup_key),
				count: findings.length,
				target: INVESTIGATE_TARGET,
				outcome,
			};
			state.journal("investigation", row);
		};
		const prompt = [
			`You are the read-only devops agent for AWS account ${ACCOUNT_ID}. The account monitor detected these findings; investigate with your AWS tools and diagnose each one.`,
			'Reply ONLY with JSON matching the response schema: an object {"diagnoses": [...]} with one entry per dedup_key. Each diagnosis cites at least one command you actually ran and the line of its output that decides the cause (evidence), and scores its own confidence 0-1. Diagnose from the numbers the finding evidence carries; never state a baseline or a count the prompt did not give you without citing the command that produced it.',
			"",
			"Findings:",
			JSON.stringify(findings, null, 2),
			prior ? `\nPrior incidents from the monitor journal:\n${prior}` : "",
		].join("\n");
		try {
			const sent = await coms.send(INVESTIGATE_TARGET, prompt, {
				response_schema: DIAGNOSIS_RESPONSE_SCHEMA,
			});
			const reply = await coms.awaitReply(sent.msg_id, investigateBudgetMs(findings.length));
			if (reply.error) {
				const refused = reply.error.startsWith(REFUSED_PREFIX);
				record(refused ? "refused" : reply.error === "timeout" ? "timeout" : "failed");
				return { diagnoses: null, failure: `agent reply error: ${reply.error}` };
			}
			// SIO-1678: a blank string is as empty as null (a run with no assistant
			// text). A current hub already answers such a turn with error empty_reply;
			// this guard covers a hub that has not been updated yet.
			if (isBlankReply(reply.response)) {
				record("failed");
				return { diagnoses: null, failure: "agent reply empty" };
			}
			const diagnoses = parseDiagnoses(reply.response);
			if (!diagnoses) {
				record("failed");
				return { diagnoses: null, failure: "agent reply did not match the diagnosis schema" };
			}
			record("diagnosed");
			return { diagnoses, failure: null };
		} catch (e) {
			return { diagnoses: null, failure: `send to ${INVESTIGATE_TARGET} failed: ${errorMessage(e)}` };
		}
	};

	const report = async (text: string): Promise<void> => {
		await coms.send(REPORT_TO, text, { ttl_ms: REPORT_TTL_MS, expectReply: false });
	};

	const fifteenDeps: CycleDeps = {
		gate,
		checks: [
			{ name: "alarms", run: () => checkAlarms(cw, state) },
			{
				name: "logs",
				run: () =>
					checkLogs(logs, state, {
						filterPattern: LOGS_FILTER,
						maxGroups: LOGS_MAX_GROUPS,
						// Empty env means "use the check's default excludes", not
						// "exclude nothing".
						excludePrefixes: LOGS_EXCLUDE.length > 0 ? LOGS_EXCLUDE : undefined,
					}),
			},
			{ name: "drift", run: () => checkDrift(ec2, state) },
			{ name: "resource-drift", run: () => checkResourceDrift(ec2, rds, lambda, state) },
			{ name: "health", run: () => checkHealth(health, state, { regions: region ? [region, "global"] : undefined }) },
			{ name: "targets", run: () => checkTargets(elbv2, state) },
			{ name: "tasks", run: () => checkTasks(ecs, state) },
			{ name: "queues", run: () => checkQueues(sqs, state) },
			{ name: "scaling", run: () => checkScaling(autoscaling, state) },
		],
		state,
		investigate,
		budget: INVESTIGATE_BUDGET,
		reuse: INVESTIGATE_REUSE,
		report,
		log,
	};

	const hourlyDeps: CycleDeps = {
		gate,
		checks: [
			{
				name: "ingestion",
				run: () =>
					checkIngestion(cw, state, {
						minEvents: INGEST_MIN_EVENTS,
						zeroHours: INGEST_ZERO_HOURS,
						excludePrefixes: LOGS_EXCLUDE.length > 0 ? LOGS_EXCLUDE : undefined,
					}),
			},
			{ name: "compliance", run: () => checkCompliance(config, state) },
			{ name: "guardduty", run: () => checkGuardDuty(guardduty, state) },
			{ name: "db-events", run: () => checkDbEvents(rds, state) },
			{ name: "nodegroups", run: () => checkNodegroups(eks, state) },
		],
		state,
		investigate,
		budget: INVESTIGATE_BUDGET,
		reuse: INVESTIGATE_REUSE,
		report,
		log,
	};

	const buildDigest = async (): Promise<string> => {
		const day = 86_400_000;
		// SIO-1698 follow-up: a journal row that does not parse -- or parses but is
		// not a Finding -- is skipped, never thrown. The digest is the daily report
		// of record: one malformed row must not take the whole thing down, the same
		// way the alarm fetch below is allowed to fail and still ship. The counting
		// lives in report.ts beside notablesFromJournal, which already reads these
		// same rows this way.
		const findingRows = state.journalRows(day, "finding");
		const errorRows = state.journalRows(day, "check_error");
		const findings = findingCountsFromJournal(findingRows);
		const checkErrors = checkErrorCountsFromJournal(errorRows);
		const counts = findings.counts;
		const errsByCheck = checkErrors.counts;
		// Silence would make a partial digest look complete.
		const skippedRows = findings.skipped + checkErrors.skipped;
		if (skippedRows > 0) log(`digest: skipped ${skippedRows} unreadable journal row(s)`);
		let activeAlarms: string[] = [];
		try {
			const resp = await cw.send(new DescribeAlarmsCommand({ StateValue: "ALARM" }));
			activeAlarms = (resp.MetricAlarms ?? []).map((a) => a.AlarmName ?? "");
		} catch {
			// digest still ships
		}
		const latest = state.latestCost();
		return formatDigest({
			accountId: ACCOUNT_ID,
			since: new Date(Date.now() - day).toISOString(),
			findingCounts: counts,
			checkErrors: errorRows.length,
			checkErrorsByCheck: errsByCheck,
			activeAlarms,
			yesterdayUsd: latest?.usd ?? null,
			baselineUsd: latest ? state.costBaseline(latest.date, 14) : null,
			bundleVersion: await bundleVersion(),
			suppressedCount: state.journalRows(day, "suppressed_finding").length,
			notables: notablesFromJournal(findingRows),
			paused: controls.paused ? { reason: controls.pausedReason, since: controls.pausedSince } : null,
		});
	};

	const buildSuppressionReview = (): string =>
		formatSuppressionReview({
			accountId: ACCOUNT_ID,
			windowDays: REVIEW_WINDOW_DAYS,
			entries: suppressionReviewFromJournal(
				state.listSuppressions(),
				state.journalRows(REVIEW_WINDOW_DAYS * 86_400_000, "suppressed_finding"),
			),
		});

	const suppressionReview = async (): Promise<void> => {
		const text = buildSuppressionReview();
		try {
			await report(text);
		} catch (e) {
			state.queueUnsent(REPORT_TO, text, REPORT_TTL_MS);
			log(`suppression review send failed, queued: ${errorMessage(e)}`);
		}
	};

	const dailyDigest = async (): Promise<void> => {
		const dailyDeps: CycleDeps = {
			gate,
			checks: [
				{ name: "cost", run: () => checkCost(ce, state, { pct: COST_PCT, abs: COST_ABS }) },
				{ name: "trail", run: () => checkTrail(cloudtrail, state) },
				{
					name: "certs",
					run: () => checkCerts(acmClients, state, { warnDays: CERT_WARN_DAYS, critDays: CERT_CRIT_DAYS }),
				},
				{ name: "listener-certs", run: () => checkListenerCerts(elbClients, state) },
				{
					name: "watchlist",
					run: () => checkWatchlist(cloudtrail, state, WATCHLIST.length > 0 ? { events: WATCHLIST } : {}),
				},
				{ name: "stacks", run: () => checkStacks(cloudformation, state) },
				{ name: "quotas", run: () => checkQuotas(support, state) },
			],
			state,
			investigate,
			budget: INVESTIGATE_BUDGET,
			reuse: INVESTIGATE_REUSE,
			report,
			log,
		};
		if (controls.paused) log("paused: skipping the daily checks");
		else await runCycle(dailyDeps);
		const pruned = state.pruneJournal(JOURNAL_RETAIN_MS);
		if (pruned > 0) log(`journal pruned: ${pruned} row(s) past retention`);
		// The digest ships even when quiet; a missing digest is the dead-man signal.
		const text = await buildDigest();
		try {
			await report(text);
		} catch (e) {
			state.queueUnsent(REPORT_TO, text, REPORT_TTL_MS);
			log(`digest send failed, queued: ${errorMessage(e)}`);
		}
	};

	// Two guards, deliberately separate: @daily fires at midnight, which is
	// always also a */15 boundary. A single shared guard makes the collision a
	// silent skip -- whichever job wins the race suppresses the other, and the
	// digest never ships. Each guard still serializes its own job against the
	// run-checks command.
	const checkGuard = makeGuard();
	const hourlyGuard = makeGuard();
	const dailyGuard = makeGuard();
	const runChecksNow = () => checkGuard(async () => void (await runCycle(fifteenDeps)));
	const runHourlyNow = () => hourlyGuard(async () => void (await runCycle(hourlyDeps)));
	// Pause gates the scheduled ticks only; an explicit run-checks command is an
	// operator action and runs regardless.
	const unlessPaused = (what: string, run: () => Promise<void>) => (): Promise<void> => {
		if (controls.paused) {
			log(`paused: skipping ${what}`);
			return Promise.resolve();
		}
		return run();
	};

	handleCommand = async (prompt: string): Promise<string> => {
		const raw = prompt.trim();
		const cmd = raw.toLowerCase();
		const control = parseControlCommand(raw);
		if (control) {
			controls = applyControl(state, controls, control);
			log(`control ${control.kind}: ${describeControls(controls)}`);
			return `ok. ${describeControls(controls)}`;
		}
		if (cmd === "run-checks") {
			const bypass = controls.paused ? " (monitor is paused; explicit run-checks still ran)" : "";
			await runChecksNow();
			const last = state.journalRows(60_000, "run").at(-1);
			return `checks complete: ${last?.payload ?? "no run recorded"}${bypass}`;
		}
		if (cmd === "status") {
			const lastRun = state.journalRows(7 * 86_400_000, "run").at(-1);
			// 24h totals ride along: the last run alone reads as "all quiet"
			// while findings from earlier cycles sit in the inbox.
			const day = 86_400_000;
			const day24 = state.journalRows(day, "finding").length;
			const sup24 = state.journalRows(day, "suppressed_finding").length;
			const err24 = state.journalRows(day, "check_error").length;
			const usage = investigationUsage(state.journalRows(day, "investigation"));
			return `monitor ${MONITOR_NAME} online. last run: ${lastRun ? `${lastRun.ts} ${lastRun.payload}` : "never"}. last 24h: ${day24} finding(s), ${sup24} suppressed, ${err24} check error(s), ${usage.used}/${INVESTIGATE_BUDGET.perDay} investigation prompt(s) used. unsent reports: ${state.unsent().length}. ${describeControls(controls)}`;
		}
		if (cmd === "digest") return buildDigest();
		if (cmd === "review") return buildSuppressionReview();
		if (cmd === "history" || cmd.startsWith("history ")) {
			const query = parseHistoryArgs(raw.slice("history".length));
			if ("error" in query) return query.error;
			return formatHistory(state.journalRows(7 * 86_400_000, "finding"), query);
		}
		if (cmd === "suppressions") {
			const rows = state.listSuppressions();
			return rows.length === 0
				? "suppression ledger is empty"
				: rows.map((r) => `${r.created_at} ${r.pattern} -- ${r.reason}`).join("\n");
		}
		if (cmd.startsWith("unsuppress ")) {
			const pattern = raw.slice("unsuppress ".length).trim();
			return state.removeSuppression(pattern)
				? `removed suppression: ${pattern}`
				: `no suppression matches: ${pattern}`;
		}
		if (cmd.startsWith("suppress ")) {
			// Pattern keeps its case (dedup keys carry alarm and group names);
			// SQL LIKE with % wildcards, e.g.: suppress alarm:%-Utilization-Low-20% | accepted dev rightsizing noise
			const rest = raw.slice("suppress ".length);
			const sep = rest.indexOf("|");
			const pattern = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
			const reason = sep >= 0 ? rest.slice(sep + 1).trim() : "";
			if (!pattern || !reason) {
				return "usage: suppress <dedup-key LIKE pattern> | <reason>";
			}
			state.addSuppression(pattern, reason);
			return `suppressed: ${pattern} (${reason})`;
		}
		if (cmd === "checkpoint") {
			if (!CHECKPOINT_ENABLED) return "checkpoint disabled (no BUNDLE_S3_URI, or PI_MONITOR_CHECKPOINT_ENABLED=false)";
			await checkpoint("manual");
			return "checkpoint attempted; see monitor log for the outcome";
		}
		return "unknown command. available: run-checks, status, digest, review, history, suppressions, suppress <pattern> | <reason>, unsuppress <pattern>, investigate on|off [reason], pause [reason], resume, checkpoint. history takes [count<=200] [info|warn|critical] [family]";
	};

	void (async () => {
		await coms.start();
		log(
			`registered as ${coms.name}; checks ${CHECK_CRON}; hourly ${HOURLY_CRON}; daily ${DAILY_CRON}; review ${REVIEW_CRON}; tz ${MONITOR_TZ ?? "host"}; reporting to ${REPORT_TO}; budget ${INVESTIGATE_BUDGET.perDay}/day, ${INVESTIGATE_BUDGET.perResourcePerDay}/resource/day; ${describeControls(controls)}`,
		);
		cronTz(CHECK_CRON, unlessPaused("15-minute checks", runChecksNow), cronOpts);
		cronTz(HOURLY_CRON, unlessPaused("hourly checks", runHourlyNow), cronOpts);
		cronTz(DAILY_CRON, () => dailyGuard(dailyDigest), cronOpts);
		// No journal writes and no checks: needs no guard against the others.
		cronTz(REVIEW_CRON, () => void suppressionReview(), cronOpts);
		// Runs regardless of pause: a paused monitor still holds the suppressions
		// and controls that a replacement would otherwise lose.
		if (CHECKPOINT_ENABLED) cronTz(CHECKPOINT_CRON, () => void checkpoint("scheduled"), cronOpts);
	})();

	// Terminal checkpoint: systemd stops the unit before the instance goes, so
	// this is the last chance to capture the final minutes of state. Bounded --
	// a hung S3 call must not stop the host from shutting down.
	const shutdown = () => {
		const bounded = Promise.race([checkpoint("shutdown"), new Promise<void>((r) => setTimeout(r, 10_000))]);
		void bounded.finally(() => void coms.stop().finally(() => process.exit(0)));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
	main();
}
