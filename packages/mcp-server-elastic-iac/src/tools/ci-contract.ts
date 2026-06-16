// src/tools/ci-contract.ts
// SIO-925: single source of truth for the on-demand CI job names + report artifacts the
// elastic-iac tools trigger against the observability-elastic-iac repo. Previously these
// were 7 inline `process.env.X ?? "literal"` reads scattered through gitlab.ts; centralising
// them lets ci-contract.test.ts assert the defaults against the live .gitlab-ci.yml so a
// repo-side rename trips a red test instead of silently breaking the agent at runtime.
//
// Each default is still overridable by its env var so the repo contract can diverge without
// a code change. Defaults verified live 2026-06-16 against the repo's .gitlab-ci.yml.
export const CI_CONTRACT = {
	driftJobName: process.env.ELASTIC_IAC_DRIFT_JOB_NAME ?? "drift-check-on-demand",
	synthDriftJobName: process.env.ELASTIC_IAC_SYNTH_DRIFT_JOB_NAME ?? "drift-check-synthetics-on-demand",
	synthPushJobName: process.env.ELASTIC_IAC_SYNTH_PUSH_JOB_NAME ?? "synthetics-push-on-demand",
	fleetPreviewJobName: process.env.ELASTIC_IAC_FLEET_PREVIEW_JOB_NAME ?? "fleet-upgrade-preview-on-demand",
	fleetApplyJobName: process.env.ELASTIC_IAC_FLEET_APPLY_JOB_NAME ?? "fleet-upgrade-apply-on-demand",
	synthDriftArtifact: process.env.ELASTIC_IAC_SYNTH_DRIFT_ARTIFACT ?? "synthetics-drift-report.json",
	fleetReportArtifact: process.env.ELASTIC_IAC_FLEET_REPORT_ARTIFACT ?? "fleet-upgrade-report.json",
} as const;
