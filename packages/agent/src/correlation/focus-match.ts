// packages/agent/src/correlation/focus-match.ts
// SIO-1103: the matcher moved to @devops-agent/shared (so non-agent consumers -- the
// knowledge-graph confirm-binding CLI, staleness -- key graph identity on the SAME
// normalization the correlation rules use). This re-export keeps every existing agent
// import site (`./focus-match` / `../focus-match`) unchanged.
export { matchesFocus, normalize, tokenize } from "@devops-agent/shared";
