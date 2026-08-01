// agent/src/close-detect.ts
//
// SIO-1357: pure detector for the incident-closure chat command, mirroring
// learn/detect.ts's whole-message-strict shape. Deliberately strict: the whole
// message must be "close incident" (any case, surrounding whitespace
// tolerated) so an ordinary message that merely mentions closing an incident
// never triggers the closure workflow.

const CLOSE_COMMAND = /^\s*close\s+incident\s*$/i;

export function detectCloseCommand(text: string): boolean {
	return CLOSE_COMMAND.test(text);
}
