// agent/src/learn/schema.ts
//
// SIO-1126: the LearningProposal contract lives in @devops-agent/shared (the web
// app renders the review card from the same shape); re-exported here so the
// learn lane's modules import it locally.

export {
	type BindingCorrection,
	BindingCorrectionSchema,
	type Heuristic,
	HeuristicSchema,
	HIL_EDITABLE_FIELDS,
	type HilDecision,
	type HilDecisions,
	type HilItemEdits,
	HilItemEditsSchema,
	type LearningProposal,
	LearningProposalSchema,
	type MemoryFact,
	MemoryFactSchema,
	type RootCauseCorrection,
	RootCauseCorrectionSchema,
} from "@devops-agent/shared";
