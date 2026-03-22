/* src/tools/queryAnalysis/index.ts */

import analyzeDocumentStructure from "./analyzeDocumentStructure";
import getCompletedRequests from "./getCompletedRequests";
import getDetailedIndexes from "./getDetailedIndexes";
import getDetailedPreparedStatements from "./getDetailedPreparedStatements";
import getDocumentTypeExamples from "./getDocumentTypeExamples";
import getFatalRequests from "./getFatalRequests";
import getIndexesToDrop from "./getIndexesToDrop";
import getLargestResultCountQueries from "./getLargestResultCountQueries";
import getLargestResultSizeQueries from "./getLargestResultSizeQueries";
import getLongestRunningQueries from "./getLongestRunningQueries";
import getMostExpensiveQueries from "./getMostExpensiveQueries";
import getMostFrequentQueries from "./getMostFrequentQueries";
import getPreparedStatements from "./getPreparedStatements";
import getPrimaryIndexQueries from "./getPrimaryIndexQueries";
import getSystemIndexes from "./getSystemIndexes";
import getSystemNodes from "./getSystemNodes";
import getSystemVitals from "./getSystemVitals";
import suggestQueryOptimizations from "./suggestQueryOptimizations";

export {
	analyzeDocumentStructure,
	getCompletedRequests,
	getDetailedIndexes,
	getDetailedPreparedStatements,
	getDocumentTypeExamples,
	getFatalRequests,
	getIndexesToDrop,
	getLargestResultCountQueries,
	getLargestResultSizeQueries,
	getLongestRunningQueries,
	getMostExpensiveQueries,
	getMostFrequentQueries,
	getPreparedStatements,
	getPrimaryIndexQueries,
	getSystemIndexes,
	getSystemNodes,
	getSystemVitals,
	suggestQueryOptimizations,
};

// Export all tools as a single object
export const queryAnalysisTools = {
	getFatalRequests,
	getLongestRunningQueries,
	getMostFrequentQueries,
	getLargestResultSizeQueries,
	getLargestResultCountQueries,
	getPrimaryIndexQueries,
	getSystemIndexes,
	getCompletedRequests,
	getIndexesToDrop,
	getMostExpensiveQueries,
	getPreparedStatements,
	getDocumentTypeExamples,
	analyzeDocumentStructure,
	suggestQueryOptimizations,
	getSystemNodes,
	getSystemVitals,
	getDetailedPreparedStatements,
	getDetailedIndexes,
};

export default queryAnalysisTools;
