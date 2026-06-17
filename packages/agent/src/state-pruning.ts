// agent/src/state-pruning.ts
//
// SIO-476: bound the LangGraph checkpointer's message array. Pure functions:
// needsPruning is a cheap gate; pruneState returns the message ids to drop
// (last-N non-system kept, system preserved, orphaned tool messages removed so
// a dangling ToolMessage never breaks Bedrock tool-call/result pairing). The
// caller turns removeIds into RemoveMessage entries for graph.updateState.

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

export interface PruningConfig {
	maxMessages: number;
	preserveSystemMessages: boolean;
}

export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
	maxMessages: 20,
	preserveSystemMessages: true,
};

function isSystem(m: BaseMessage): boolean {
	return m instanceof SystemMessage;
}

// Non-system message count drives the threshold (system messages are always kept).
export function needsPruning(messages: BaseMessage[], config: PruningConfig = DEFAULT_PRUNING_CONFIG): boolean {
	const nonSystem = messages.filter((m) => !isSystem(m)).length;
	return nonSystem > config.maxMessages;
}

export function pruneState(
	messages: BaseMessage[],
	config: PruningConfig = DEFAULT_PRUNING_CONFIG,
): { removeIds: string[] } {
	if (!needsPruning(messages, config)) return { removeIds: [] };

	// Walk from the end keeping the last maxMessages non-system messages; everything
	// else (non-system, beyond the window) is a removal candidate. System messages
	// are kept when preserveSystemMessages.
	const keep = new Set<BaseMessage>();
	let kept = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (!m) continue;
		if (isSystem(m)) {
			if (config.preserveSystemMessages) keep.add(m);
			continue;
		}
		if (kept < config.maxMessages) {
			keep.add(m);
			kept += 1;
		}
	}

	// tool_call ids present on kept AIMessages -> a kept ToolMessage whose
	// tool_call_id is not among them is orphaned and must also be removed.
	const keptToolCallIds = new Set<string>();
	for (const m of keep) {
		if (m instanceof AIMessage) {
			for (const tc of m.tool_calls ?? []) {
				if (tc.id) keptToolCallIds.add(tc.id);
			}
		}
	}

	const removeIds: string[] = [];
	for (const m of messages) {
		const id = m.id;
		if (!id) continue; // cannot target an id-less message with RemoveMessage
		if (!keep.has(m)) {
			removeIds.push(id);
			continue;
		}
		if (m instanceof ToolMessage && !keptToolCallIds.has(m.tool_call_id)) {
			removeIds.push(id); // orphaned tool result inside the kept window
			keep.delete(m);
		}
	}
	return { removeIds };
}
