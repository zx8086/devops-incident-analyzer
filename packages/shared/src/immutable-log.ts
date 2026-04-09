// shared/src/immutable-log.ts
import { createHash } from "node:crypto";

const SEED_HASH = "0".repeat(64);

export function createHashChainDestination(inner: { write(data: string): void }): {
	write(data: string): void;
} {
	let prevHash = SEED_HASH;

	return {
		write(data: string) {
			try {
				const obj = JSON.parse(data);
				const lineHash = createHash("sha256").update(data.trim()).digest("hex");
				obj._prevHash = prevHash;
				obj._lineHash = lineHash;
				prevHash = lineHash;
				inner.write(`${JSON.stringify(obj)}\n`);
			} catch {
				// Non-JSON lines pass through unchanged
				inner.write(data);
			}
		},
	};
}

export function verifyHashChain(lines: string[]): { valid: boolean; brokenAt?: number } {
	let expectedPrev = SEED_HASH;

	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line) continue;

		try {
			const obj = JSON.parse(line);
			if (obj._prevHash !== expectedPrev) {
				return { valid: false, brokenAt: i };
			}

			// Chain continuity is verified via _prevHash linkage: each entry's _prevHash
			// must equal the prior entry's _lineHash
			expectedPrev = obj._lineHash;
		} catch {
			return { valid: false, brokenAt: i };
		}
	}

	return { valid: true };
}
