// agent/src/learn/detect.ts
//
// SIO-1126: pure detector for the HIL learning chat command. Deliberately strict:
// the whole message must be "learn from <TICKET-KEY>" (any case, surrounding
// whitespace tolerated) so an incident description that merely mentions learning
// never routes into the lane.

const LEARN_COMMAND = /^\s*learn\s+from\s+((?:[A-Za-z][A-Za-z0-9]*)-\d+)\s*$/i;

export function detectLearnCommand(text: string): string | null {
	const match = LEARN_COMMAND.exec(text);
	return match?.[1] ? match[1].toUpperCase() : null;
}
