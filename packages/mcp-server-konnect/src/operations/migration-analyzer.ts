import { z } from "zod";
import type { ElicitationManager, ElicitationRequest, KongElicitationPatterns } from "../utils/elicitation.js";

/**
 * Migration Analysis with Confidence Scoring
 *
 * Analyzes Kong deck configurations and determines what information needs to be elicited
 * from users based on confidence levels and missing mandatory data.
 */

export interface MigrationContext {
	userMessage?: string;
	deckFiles?: string[];
	deckConfigs?: DeckConfiguration[];
	filePaths?: string[];
	gitContext?: {
		branch?: string;
		repoName?: string;
		teamMembers?: string[];
	};
}

export interface DeckConfiguration {
	services?: any[];
	routes?: any[];
	consumers?: any[];
	plugins?: any[];
	upstreams?: any[];
	certificates?: any[];
	_konnect?: {
		control_plane_name?: string;
	};
}

export interface ExtractedInfo {
	value: string;
	confidence: number; // 0-1 scale
	source: "explicit" | "implicit" | "inferred" | "default";
	sources: string[];
}

export interface MigrationAnalysis {
	domain: ExtractedInfo | null;
	environment: ExtractedInfo | null;
	team: ExtractedInfo | null;
	controlPlane: ExtractedInfo | null;
	entityCounts: {
		services: number;
		routes: number;
		consumers: number;
		plugins: number;
		total: number;
	};
	missingInfo: {
		domain: boolean;
		environment: boolean;
		team: boolean;
	};
	elicitationRequired: boolean;
	confidence: {
		overall: number;
		breakdown: {
			domain: number;
			environment: number;
			team: number;
		};
	};
	riskAssessment: "low" | "medium" | "high";
	recommendations: string[];
}

export class MigrationAnalyzer {
	private elicitationManager: ElicitationManager;
	private elicitationPatterns: KongElicitationPatterns;

	// Confidence thresholds
	private static readonly CONFIDENCE_THRESHOLDS = {
		HIGH: 0.8,
		MEDIUM: 0.5,
		MINIMUM_ACCEPTABLE: 0.7,
	};

	constructor(elicitationManager: ElicitationManager, elicitationPatterns: KongElicitationPatterns) {
		this.elicitationManager = elicitationManager;
		this.elicitationPatterns = elicitationPatterns;
	}

	/**
	 * Parse direct information from user message (Claude Desktop style)
	 */
	private parseDirectInformation(userMessage: string): Partial<MigrationAnalysis> {
		const result: Partial<MigrationAnalysis> = {};

		// Parse domain=value, environment=value, team=value patterns
		const domainMatch = userMessage.match(/\bdomain\s*=\s*([^,\s]+)/i);
		const environmentMatch = userMessage.match(/\b(?:environment|env)\s*=\s*([^,\s]+)/i);
		const teamMatch = userMessage.match(/\bteam\s*=\s*([^,\s]+)/i);

		if (domainMatch) {
			result.domain = {
				value: domainMatch[1].toLowerCase().trim(),
				confidence: 1.0,
				source: "explicit",
				sources: ["user-message-direct"],
			};
		}

		if (environmentMatch) {
			result.environment = {
				value: environmentMatch[1].toLowerCase().trim(),
				confidence: 1.0,
				source: "explicit",
				sources: ["user-message-direct"],
			};
		}

		if (teamMatch) {
			result.team = {
				value: teamMatch[1].toLowerCase().trim(),
				confidence: 1.0,
				source: "explicit",
				sources: ["user-message-direct"],
			};
		}

		return result;
	}

	/**
	 * Analyze migration context and determine elicitation requirements
	 */
	async analyzeMigration(context: MigrationContext): Promise<MigrationAnalysis> {
		const analysis: MigrationAnalysis = {
			domain: null,
			environment: null,
			team: null,
			controlPlane: null,
			entityCounts: {
				services: 0,
				routes: 0,
				consumers: 0,
				plugins: 0,
				total: 0,
			},
			missingInfo: { domain: true, environment: true, team: true },
			elicitationRequired: false,
			confidence: {
				overall: 0,
				breakdown: { domain: 0, environment: 0, team: 0 },
			},
			riskAssessment: "medium",
			recommendations: [],
		};

		// First, check for direct information provision (Claude Desktop style)
		if (context.userMessage) {
			const directInfo = this.parseDirectInformation(context.userMessage);
			if (directInfo.domain) analysis.domain = directInfo.domain;
			if (directInfo.environment) analysis.environment = directInfo.environment;
			if (directInfo.team) analysis.team = directInfo.team;
		}

		// Then extract information from various sources (if not already provided directly)
		if (!analysis.domain) analysis.domain = this.extractDomainInfo(context);
		if (!analysis.environment) analysis.environment = this.extractEnvironmentInfo(context);
		if (!analysis.team) analysis.team = this.extractTeamInfo(context);
		analysis.controlPlane = this.extractControlPlaneInfo(context);

		// Count entities
		analysis.entityCounts = this.countEntities(context.deckConfigs || []);

		// Determine missing information
		analysis.missingInfo = {
			domain:
				!analysis.domain || analysis.domain.confidence < MigrationAnalyzer.CONFIDENCE_THRESHOLDS.MINIMUM_ACCEPTABLE,
			environment:
				!analysis.environment ||
				analysis.environment.confidence < MigrationAnalyzer.CONFIDENCE_THRESHOLDS.MINIMUM_ACCEPTABLE,
			team: !analysis.team || analysis.team.confidence < MigrationAnalyzer.CONFIDENCE_THRESHOLDS.MINIMUM_ACCEPTABLE,
		};

		// Calculate confidence scores
		analysis.confidence = {
			breakdown: {
				domain: analysis.domain?.confidence || 0,
				environment: analysis.environment?.confidence || 0,
				team: analysis.team?.confidence || 0,
			},
			overall: 0,
		};

		analysis.confidence.overall =
			(analysis.confidence.breakdown.domain +
				analysis.confidence.breakdown.environment +
				analysis.confidence.breakdown.team) /
			3;

		// Determine if elicitation is required
		analysis.elicitationRequired = Object.values(analysis.missingInfo).some((missing) => missing);

		// Risk assessment
		analysis.riskAssessment = this.calculateRiskAssessment(analysis);

		// Generate recommendations
		analysis.recommendations = this.generateRecommendations(analysis, context);

		return analysis;
	}

	/**
	 * Create elicitation session based on analysis
	 */
	async createElicitationSession(
		analysis: MigrationAnalysis,
		context: MigrationContext,
	): Promise<{
		sessionId: string;
		requests: ElicitationRequest[];
		summary: string;
	}> {
		const session = this.elicitationManager.createSession({
			analysis,
			context,
			timestamp: new Date().toISOString(),
		});

		const requests: ElicitationRequest[] = [];

		// Domain elicitation
		if (analysis.missingInfo.domain) {
			const domainRequest = this.elicitationPatterns.requestDomain(session.sessionId, {
				detectedDomains: analysis.domain ? [analysis.domain.value] : undefined,
				serviceNames: this.extractServiceNames(context.deckConfigs || []),
				userMessage: context.userMessage,
			});
			requests.push(domainRequest);
		}

		// Environment elicitation
		if (analysis.missingInfo.environment) {
			const envRequest = this.elicitationPatterns.requestEnvironment(session.sessionId, {
				detectedEnv: analysis.environment?.value,
				filepath: context.filePaths?.[0],
			});
			requests.push(envRequest);
		}

		// Team elicitation
		if (analysis.missingInfo.team) {
			const teamRequest = this.elicitationPatterns.requestTeam(session.sessionId, {
				suggestedTeams: this.generateTeamSuggestions(context),
				domain: analysis.domain?.value,
			});
			requests.push(teamRequest);
		}

		const summary = this.generateElicitationSummary(requests, analysis);

		return {
			sessionId: session.sessionId,
			requests,
			summary,
		};
	}

	// Private helper methods
	private extractDomainInfo(context: MigrationContext): ExtractedInfo | null {
		const candidates: {
			value: string;
			confidence: number;
			source: ExtractedInfo["source"];
			sources: string[];
		}[] = [];

		// Check user message for explicit domain mentions
		if (context.userMessage) {
			const domainPatterns = [
				/(?:for the|using the|migrate to|in the)\s+([a-z0-9-]{3,20})\s+domain/gi,
				/domain[:\s]*([a-z0-9-]{3,20})/gi,
			];

			domainPatterns.forEach((pattern) => {
				const matches = context.userMessage!.matchAll(pattern);
				for (const match of matches) {
					candidates.push({
						value: match[1].toLowerCase(),
						confidence: 0.95,
						source: "explicit",
						sources: ["user-message"],
					});
				}
			});
		}

		// Extract from file paths
		if (context.filePaths?.length) {
			context.filePaths.forEach((path) => {
				const pathParts = path.split("/").filter((part) => part.length > 0);
				pathParts.forEach((part) => {
					if (part.match(/^[a-z0-9-]{3,20}$/)) {
						candidates.push({
							value: part.toLowerCase(),
							confidence: 0.4,
							source: "inferred",
							sources: ["file-path"],
						});
					}
				});
			});
		}

		// Extract from service names
		const serviceNames = this.extractServiceNames(context.deckConfigs || []);
		serviceNames.forEach((name) => {
			const parts = name.toLowerCase().split(/[-_]/);
			parts.forEach((part) => {
				if (part.length >= 3 && part.length <= 15 && !["api", "service", "app", "web"].includes(part)) {
					candidates.push({
						value: part,
						confidence: 0.3,
						source: "inferred",
						sources: ["service-names"],
					});
				}
			});
		});

		// Extract from control plane name
		const controlPlaneName = context.deckConfigs?.[0]?._konnect?.control_plane_name;
		if (controlPlaneName) {
			const parts = controlPlaneName.toLowerCase().split(/[-_\s]/);
			parts.forEach((part) => {
				if (part.length >= 3 && part.length <= 15) {
					candidates.push({
						value: part,
						confidence: 0.6,
						source: "implicit",
						sources: ["control-plane-name"],
					});
				}
			});
		}

		// Return the highest confidence candidate
		if (candidates.length === 0) return null;

		const best = candidates.reduce((prev, current) => (current.confidence > prev.confidence ? current : prev));

		return {
			value: best.value,
			confidence: best.confidence,
			source: best.source,
			sources: best.sources,
		};
	}

	private extractEnvironmentInfo(context: MigrationContext): ExtractedInfo | null {
		const candidates: {
			value: string;
			confidence: number;
			source: ExtractedInfo["source"];
			sources: string[];
		}[] = [];

		// Check user message
		if (context.userMessage) {
			const envPatterns = [
				/(?:for|in|to)\s+(production|staging|development|dev|prod|test)/gi,
				/env(?:ironment)?[:\s]*(production|staging|development|dev|prod|test)/gi,
			];

			envPatterns.forEach((pattern) => {
				const matches = context.userMessage!.matchAll(pattern);
				for (const match of matches) {
					const normalized = this.normalizeEnvironment(match[1].toLowerCase());
					candidates.push({
						value: normalized,
						confidence: 0.9,
						source: "explicit",
						sources: ["user-message"],
					});
				}
			});
		}

		// Check file paths
		if (context.filePaths?.length) {
			const envKeywords = ["prod", "production", "staging", "stage", "dev", "development", "test"];
			context.filePaths.forEach((path) => {
				envKeywords.forEach((keyword) => {
					if (path.toLowerCase().includes(keyword)) {
						const normalized = this.normalizeEnvironment(keyword);
						candidates.push({
							value: normalized,
							confidence: 0.7,
							source: "implicit",
							sources: ["file-path"],
						});
					}
				});
			});
		}

		// NO FALLBACKS FOR PRODUCTION - User must explicitly specify environment
		// Removed production default - this is a production-grade deployment system

		// Return the highest confidence candidate or null if no candidates
		if (candidates.length === 0) return null;

		const best = candidates.reduce((prev, current) => (current.confidence > prev.confidence ? current : prev));

		return {
			value: best.value,
			confidence: best.confidence,
			source: best.source,
			sources: best.sources,
		};
	}

	private extractTeamInfo(context: MigrationContext): ExtractedInfo | null {
		const candidates: {
			value: string;
			confidence: number;
			source: ExtractedInfo["source"];
			sources: string[];
		}[] = [];

		// Check user message for team mentions
		if (context.userMessage) {
			const teamPatterns = [/(?:team|owned by|belongs to)\s+([a-z0-9-]{2,15})/gi];

			teamPatterns.forEach((pattern) => {
				const matches = context.userMessage!.matchAll(pattern);
				for (const match of matches) {
					candidates.push({
						value: match[1].toLowerCase(),
						confidence: 0.9,
						source: "explicit",
						sources: ["user-message"],
					});
				}
			});
		}

		// Infer from git context
		if (context.gitContext?.teamMembers?.length) {
			// This would need actual git analysis implementation
			// NO FALLBACKS - User must explicitly specify team
		}

		// NO FALLBACKS FOR PRODUCTION - User must explicitly specify team ownership
		// Removed platform default - this is a production-grade deployment system

		// Return the highest confidence candidate or null if no candidates
		if (candidates.length === 0) return null;

		const best = candidates.reduce((prev, current) => (current.confidence > prev.confidence ? current : prev));

		return {
			value: best.value,
			confidence: best.confidence,
			source: best.source,
			sources: best.sources,
		};
	}

	private extractControlPlaneInfo(context: MigrationContext): ExtractedInfo | null {
		const controlPlaneName = context.deckConfigs?.[0]?._konnect?.control_plane_name;
		if (controlPlaneName) {
			return {
				value: controlPlaneName,
				confidence: 1.0,
				source: "explicit",
				sources: ["deck-config"],
			};
		}
		return null;
	}

	private countEntities(deckConfigs: DeckConfiguration[]) {
		const counts = {
			services: 0,
			routes: 0,
			consumers: 0,
			plugins: 0,
			total: 0,
		};

		deckConfigs.forEach((config) => {
			counts.services += config.services?.length || 0;
			counts.routes += config.routes?.length || 0;
			counts.consumers += config.consumers?.length || 0;
			counts.plugins += config.plugins?.length || 0;
		});

		counts.total = counts.services + counts.routes + counts.consumers + counts.plugins;
		return counts;
	}

	private extractServiceNames(deckConfigs: DeckConfiguration[]): string[] {
		const names: string[] = [];
		deckConfigs.forEach((config) => {
			config.services?.forEach((service) => {
				if (service.name) names.push(service.name);
			});
		});
		return names;
	}

	private normalizeEnvironment(env: string): string {
		const envMap: Record<string, string> = {
			prod: "production",
			dev: "development",
			stage: "staging",
			staging: "staging",
			production: "production",
			development: "development",
			test: "test",
		};
		return envMap[env] || env;
	}

	private calculateRiskAssessment(analysis: MigrationAnalysis): "low" | "medium" | "high" {
		let riskScore = 0;

		// Missing information increases risk
		if (analysis.missingInfo.domain) riskScore += 3;
		if (analysis.missingInfo.environment) riskScore += 2;
		if (analysis.missingInfo.team) riskScore += 1;

		// Low confidence increases risk
		if (analysis.confidence.overall < 0.5) riskScore += 2;

		// Large number of entities increases complexity risk
		if (analysis.entityCounts.total > 20) riskScore += 1;
		if (analysis.entityCounts.total > 50) riskScore += 1;

		if (riskScore <= 2) return "low";
		if (riskScore <= 5) return "medium";
		return "high";
	}

	private generateRecommendations(analysis: MigrationAnalysis, context: MigrationContext): string[] {
		const recommendations: string[] = [];

		if (analysis.missingInfo.domain) {
			recommendations.push("Domain classification is required for proper resource organization and discovery");
		}

		if (analysis.missingInfo.environment) {
			recommendations.push("Environment specification is critical for deployment safety and compliance");
		}

		if (analysis.confidence.overall < 0.6) {
			recommendations.push("Low confidence in extracted information - manual verification recommended");
		}

		if (analysis.entityCounts.total > 30) {
			recommendations.push("Large configuration detected - consider incremental migration approach");
		}

		if (analysis.riskAssessment === "high") {
			recommendations.push("High-risk migration - comprehensive validation and rollback planning recommended");
		}

		return recommendations;
	}

	private generateTeamSuggestions(context: MigrationContext): string[] {
		const suggestions = new Set(["platform", "devops", "api", "backend", "frontend"]);

		// Add domain-based suggestions
		if (context.userMessage) {
			const words = context.userMessage.toLowerCase().split(/\s+/);
			words.forEach((word) => {
				if (word.match(/^[a-z]{3,15}$/) && !["the", "and", "for", "with"].includes(word)) {
					suggestions.add(word);
				}
			});
		}

		return Array.from(suggestions).slice(0, 8);
	}

	private generateElicitationSummary(requests: ElicitationRequest[], analysis: MigrationAnalysis): string {
		let summary = `INFO: **Migration Analysis Summary**\n\n`;
		summary += `• **Entities to migrate**: ${analysis.entityCounts.total} total (${analysis.entityCounts.services} services, ${analysis.entityCounts.routes} routes)\n`;
		summary += `• **Overall confidence**: ${Math.round(analysis.confidence.overall * 100)}%\n`;
		summary += `• **Risk level**: ${analysis.riskAssessment}\n`;
		summary += `• **Information needed**: ${requests.length} items\n\n`;

		if (requests.length > 0) {
			summary += `**Please provide the following information:**\n`;
			requests.forEach((req, index) => {
				const type = req.id.includes("domain")
					? "INFO: Domain"
					: req.id.includes("environment")
						? "INFO: Environment"
						: req.id.includes("team")
							? "👥 Team"
							: "❓ Information";
				summary += `${index + 1}. ${type}\n`;
			});
		}

		return summary;
	}
}
