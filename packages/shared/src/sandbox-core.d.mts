// shared/src/sandbox-core.d.mts
export interface SandboxLimits {
	memoryBytes: number;
	stackBytes: number;
	wallMs: number;
	stdoutBytes: number;
}

export interface SandboxGuestResult {
	stdout: string;
	truncated: boolean;
	error?: string;
	interrupted?: boolean;
	outOfMemory?: boolean;
}

export function evalGuest(input: {
	code: string;
	evidenceJson: string;
	limits: SandboxLimits;
}): Promise<SandboxGuestResult>;
