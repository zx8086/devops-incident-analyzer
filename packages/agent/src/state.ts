// agent/src/state.ts
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { DataSourceResult, ExtractedEntities, ToolPlanStep, DataSourceContext } from "@devops-agent/shared";

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,

  queryComplexity: Annotation<"simple" | "complex">({
    reducer: (_, next) => next,
    default: () => "complex",
  }),

  targetDataSources: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // SIO-559: append reducer -- appends new results, empty array resets
  dataSourceResults: Annotation<DataSourceResult[]>({
    reducer: (prev, next) => {
      if (next.length === 0) return [];
      return [...prev, ...next];
    },
    default: () => [],
  }),

  currentDataSource: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  extractedEntities: Annotation<ExtractedEntities>({
    reducer: (_, next) => next,
    default: () => ({ dataSources: [] }),
  }),

  previousEntities: Annotation<ExtractedEntities>({
    reducer: (_, next) => next,
    default: () => ({ dataSources: [] }),
  }),

  toolPlanMode: Annotation<"planned" | "autonomous">({
    reducer: (_, next) => next,
    default: () => "autonomous",
  }),

  toolPlan: Annotation<ToolPlanStep[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  validationResult: Annotation<"pass" | "fail" | "pass_with_warnings">({
    reducer: (_, next) => next,
    default: () => "pass",
  }),

  retryCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  alignmentRetries: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  alignmentHints: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  isFollowUp: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),

  finalAnswer: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  dataSourceContext: Annotation<DataSourceContext | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),

  requestId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => crypto.randomUUID(),
  }),
});

export type AgentStateType = typeof AgentState.State;
