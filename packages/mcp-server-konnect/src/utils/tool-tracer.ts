// src/utils/tool-tracer.ts
export class ToolPerformanceCollector {
	private metrics = new Map<
		string,
		{
			callCount: number;
			totalDuration: number;
			errorCount: number;
			lastCalled: string;
		}
	>();

	recordToolExecution(toolName: string, duration: number, success: boolean) {
		const existing = this.metrics.get(toolName) || {
			callCount: 0,
			totalDuration: 0,
			errorCount: 0,
			lastCalled: "",
		};
		existing.callCount++;
		existing.totalDuration += duration;
		existing.lastCalled = new Date().toISOString();
		if (!success) existing.errorCount++;
		this.metrics.set(toolName, existing);
	}

	getToolStats(toolName: string) {
		const stats = this.metrics.get(toolName);
		if (!stats) return null;
		return {
			...stats,
			averageDuration: stats.totalDuration / stats.callCount,
			successRate: (stats.callCount - stats.errorCount) / stats.callCount,
			errorRate: stats.errorCount / stats.callCount,
		};
	}

	getAllStats() {
		const result: Record<string, unknown> = {};
		for (const [toolName, stats] of this.metrics) {
			result[toolName] = {
				...stats,
				averageDuration: stats.totalDuration / stats.callCount,
				successRate: (stats.callCount - stats.errorCount) / stats.callCount,
				errorRate: stats.errorCount / stats.callCount,
			};
		}
		return result;
	}

	reset() {
		this.metrics.clear();
	}
}
