// skillflow/src/template.ts
//
// SkillsFlow template resolution (EPIC 4 / SIO-848). Resolves ${{ ... }} tokens
// in a step's `with` inputs against the accumulating step outputs and the
// trigger payload. Strict: an unknown reference throws rather than silently
// producing an empty string, so a misspelled output surfaces immediately.

export interface TemplateContext {
	// stepName -> { outputName -> value }
	steps: Map<string, Record<string, string>>;
	// trigger payload (e.g. ${{ trigger.changed_files }})
	trigger?: Record<string, string>;
}

export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateError";
	}
}

const TOKEN_RE = /\$\{\{\s*([^}]+?)\s*\}\}/g;

function resolveReference(ref: string, ctx: TemplateContext): string {
	const parts = ref.split(".");
	if (parts[0] === "trigger") {
		const key = parts[1];
		if (!key || !ctx.trigger || !(key in ctx.trigger)) {
			throw new TemplateError(`unknown trigger reference: ${ref}`);
		}
		return ctx.trigger[key] ?? "";
	}
	// steps.<stepName>.outputs.<outputName>
	if (parts[0] === "steps" && parts[2] === "outputs") {
		const stepName = parts[1];
		const outputName = parts[3];
		if (!stepName || !outputName) throw new TemplateError(`malformed step reference: ${ref}`);
		const outputs = ctx.steps.get(stepName);
		if (!outputs)
			throw new TemplateError(`reference to step "${stepName}" which has not run or does not exist: ${ref}`);
		if (!(outputName in outputs)) {
			throw new TemplateError(`step "${stepName}" did not expose output "${outputName}": ${ref}`);
		}
		return outputs[outputName] ?? "";
	}
	throw new TemplateError(`unsupported template reference: ${ref}`);
}

// Resolves all ${{ ... }} tokens in a single string.
export function resolveTemplate(input: string, ctx: TemplateContext): string {
	return input.replace(TOKEN_RE, (_match, ref: string) => resolveReference(ref.trim(), ctx));
}

// Resolves every value in a step's `with` map.
export function resolveInputs(
	withMap: Record<string, string> | undefined,
	ctx: TemplateContext,
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(withMap ?? {})) {
		resolved[key] = resolveTemplate(value, ctx);
	}
	return resolved;
}
