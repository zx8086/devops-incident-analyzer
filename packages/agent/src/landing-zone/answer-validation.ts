// packages/agent/src/landing-zone/answer-validation.ts

import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import {
	type LandingZoneAnswer,
	type LandingZoneAnswerValidation,
	LandingZoneAnswerValidationSchema,
	type LandingZoneRequestResolution,
} from "./types.ts";

export interface LandingZoneAnswerValidationInput {
	answer: LandingZoneAnswer;
	resolution: LandingZoneRequestResolution;
	evidence: EvidenceItem[];
	unavailableSources: EvidenceSource[];
	requestText: string;
}

const STATUS_ONLY =
	/^(?:current pvh, repository, terraform, and aws evidence is aligned|evidence is unavailable or unverified|available evidence supports an explanation)/i;
const PROHIBITED_RECOMMENDATION =
	/\b(?:run|execute|perform|do|use)\s+(?:terraform\s+)?(?:apply|destroy|state\s+(?:rm|mv|push)|force-unlock)\b|\bpush directly to (?:main|master)\b/i;

function groundedText(input: LandingZoneAnswerValidationInput): string {
	return [
		input.requestText,
		...input.evidence.map((item) => `${item.summary} ${JSON.stringify(item.provenance)}`),
	].join(" ");
}

export function validateLandingZoneAnswer(input: LandingZoneAnswerValidationInput): LandingZoneAnswerValidation {
	const issues: string[] = [];
	const body = input.answer.answerMarkdown.trim();
	const lower = body.toLowerCase();
	if (body.length < 100 || STATUS_ONLY.test(body)) {
		issues.push("Answer is reconciliation boilerplate rather than a substantive response.");
	}

	const evidenceIds = new Set(input.evidence.map((item) => item.id));
	for (const citation of input.answer.citations) {
		for (const evidenceId of citation.evidenceIds) {
			if (!evidenceIds.has(evidenceId)) {
				issues.push(`Citation ${citation.id} references unknown evidence ${evidenceId}.`);
			}
		}
	}

	const currentAuthoritative = new Set(
		input.evidence
			.filter(
				(item) =>
					item.status === "observed" &&
					item.freshness.status === "current" &&
					item.source !== "memory" &&
					item.source !== "knowledge-graph",
			)
			.map((item) => item.id),
	);
	if (
		currentAuthoritative.size > 0 &&
		!input.answer.citations.some((citation) => citation.evidenceIds.some((id) => currentAuthoritative.has(id)))
	) {
		issues.push("Answer does not cite current authoritative evidence available for this turn.");
	}

	if (
		input.unavailableSources.some((source) => {
			const label = source === "terraform-docs" ? "terraform" : source === "aws-docs" ? "aws" : source;
			return new RegExp(`\\b${label}\\b.{0,60}\\b(?:aligned|consulted|confirmed|verified)\\b`, "i").test(body);
		})
	) {
		issues.push("An unavailable source is described as aligned or consulted.");
	}

	if (input.resolution.subject === "account-vending") {
		const yamlIndex = lower.indexOf("accounts/<application>.yml");
		const terraformIndex = lower.indexOf("terraform");
		if (yamlIndex === -1 || !lower.includes("generator") || (terraformIndex !== -1 && terraformIndex < yamlIndex)) {
			issues.push("Account-vending answer must lead with accounts/<application>.yml and the generator workflow.");
		}
	}
	if (input.resolution.repositories.length > 0 && !input.resolution.repositories.some((repo) => lower.includes(repo))) {
		issues.push("Answer does not name the resolved Landing Zone repository subject.");
	}
	if (PROHIBITED_RECOMMENDATION.test(body)) {
		issues.push("Answer recommends a prohibited operation.");
	}

	const sourceText = groundedText(input);
	for (const accountId of new Set(body.match(/\b\d{12}\b/g) ?? [])) {
		if (!sourceText.includes(accountId)) {
			issues.push("Answer contains an account ID that was not present in the request or evidence.");
			break;
		}
	}

	return LandingZoneAnswerValidationSchema.parse({ valid: issues.length === 0, issues });
}
