// src/utils/env.ts
export interface RuntimeInfo {
	runtime: "bun" | "node";
	version: string;
	envSource: "bun" | "process";
}

export function getRuntimeInfo(): RuntimeInfo {
	const isBun = typeof Bun !== "undefined";
	return {
		runtime: isBun ? "bun" : "node",
		version: isBun ? Bun.version : process.version,
		envSource: isBun ? "bun" : "process",
	};
}
