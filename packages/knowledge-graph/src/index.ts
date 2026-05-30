// knowledge-graph/src/index.ts

export {
	buildGraphContext,
	priorRelationshipsForServices,
	type ServiceDependency,
	type SimilarIncident,
	similarIncidents,
	type TopologyEdge,
	topology,
} from "./reader.ts";
export {
	EMBEDDING_DIM,
	type FindingNode,
	type IncidentNode,
	MIGRATIONS,
	NODE_LABELS,
	type NodeLabel,
	REL_TYPES,
	type RelType,
	type ServiceNode,
	VECTOR_INDEX_SETUP,
} from "./schema.ts";
export {
	_setGraphStoreForTesting,
	type GraphRow,
	type GraphStore,
	getGraphStore,
	graphPath,
	InMemoryGraphStore,
	isKnowledgeGraphEnabled,
	LadybugStore,
} from "./store.ts";
export {
	type CorrelationLink,
	type EntityGraph,
	type IncidentRecord,
	linkCorrelation,
	linkResolution,
	recordIncident,
	upsertEntities,
} from "./writer.ts";
