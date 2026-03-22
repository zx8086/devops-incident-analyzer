/**
 * Enhanced Client Detection for MCP Server
 * Determines client environment during initialization for better UX adaptation
 */

import { mcpLogger } from "./mcp-logger.js";

export type ClientType =
	// Official Claude Clients
	| "claude-code"
	| "claude-desktop"
	| "claude-web"
	// IDE Integrations
	| "vscode-extension"
	| "jetbrains-plugin"
	| "vim-plugin"
	| "emacs-extension"
	// MCP Client Libraries
	| "mcp-client-python"
	| "mcp-client-typescript"
	| "mcp-client-rust"
	| "mcp-client-go"
	// Custom/Enterprise Clients
	| "custom-web-client"
	| "custom-desktop-client"
	| "enterprise-client"
	| "api-client"
	// Development Tools
	| "cli-tool"
	| "automation-script"
	| "testing-framework"
	| "ci-cd-pipeline"
	// Unknown/Fallback
	| "unknown";

export interface ClientEnvironment {
	type: ClientType;
	name: string;
	version?: string;
	userAgent?: string;
	capabilities: ClientCapabilities;
	detectionConfidence: number; // 0-1 scale
	detectionMethod: string[];
	// Enhanced metadata
	category: "official" | "ide" | "library" | "custom" | "development" | "unknown";
	platform?: "desktop" | "web" | "mobile" | "server" | "embedded";
	integration?: "native" | "extension" | "plugin" | "standalone" | "api";
}

export interface ClientCapabilities {
	// Core capabilities
	hasFileSystem: boolean;
	hasGitContext: boolean;
	hasTodoList: boolean;
	hasDirectInput: boolean;

	// Interaction capabilities
	supportsInteractiveElicitation: boolean;
	supportsImageUpload: boolean;
	supportsRealTimeUpdates: boolean;
	supportsProgressIndicators: boolean;

	// Advanced features
	hasCodeExecution: boolean;
	hasTerminalAccess: boolean;
	hasNetworkAccess: boolean;
	hasClipboardAccess: boolean;

	// UI/UX features
	supportsMarkdownRendering: boolean;
	supportsCodeHighlighting: boolean;
	supportsInlineImages: boolean;
	hasStatusBar: boolean;
	hasNotifications: boolean;

	// Integration features
	hasIDEIntegration: boolean;
	hasDebuggerAccess: boolean;
	hasExtensionAPI: boolean;

	// Elicitation preferences
	preferredElicitationMode: "interactive" | "direct-prompt" | "mixed" | "api-driven";
}

/**
 * Enhanced client detection using multiple signals and detection patterns
 */
export function detectClientEnvironment(
	transportMode: "stdio" | "sse",
	environmentVars?: Record<string, string>,
	processInfo?: {
		argv: string[];
		cwd: string;
		platform: string;
	},
): ClientEnvironment {
	const env = environmentVars || process.env;
	const argv = processInfo?.argv || process.argv;
	const cwd = processInfo?.cwd || process.cwd();
	const platform = processInfo?.platform || process.platform;

	// Run all detection patterns
	const detectionResults = [
		...runOfficialClientDetection(transportMode, env, argv, cwd),
		...runIDEIntegrationDetection(env, argv, cwd),
		...runMCPLibraryDetection(env, argv, cwd),
		...runCustomClientDetection(env, argv, cwd),
		...runDevelopmentToolDetection(env, argv, cwd),
		...runTransportAnalysis(transportMode),
		...runPlatformAnalysis(platform, env),
	];

	// Find best match
	const bestMatch = detectionResults.reduce((best, current) => (current.confidence > best.confidence ? current : best));

	// Combine all detection methods
	const allMethods = detectionResults.flatMap((r) => r.methods);

	return {
		type: bestMatch.type,
		name: bestMatch.name,
		version: bestMatch.version,
		userAgent: bestMatch.userAgent,
		capabilities: getClientCapabilities(bestMatch.type),
		detectionConfidence: bestMatch.confidence,
		detectionMethod: [...new Set(allMethods)],
		category: bestMatch.category,
		platform: bestMatch.platform,
		integration: bestMatch.integration,
	};
}

interface DetectionResult {
	type: ClientType;
	name: string;
	version?: string;
	userAgent?: string;
	confidence: number;
	methods: string[];
	category: ClientEnvironment["category"];
	platform?: ClientEnvironment["platform"];
	integration?: ClientEnvironment["integration"];
}

// Official Claude Client Detection
function runOfficialClientDetection(
	transportMode: "stdio" | "sse",
	env: Record<string, string>,
	argv: string[],
	cwd: string,
): DetectionResult[] {
	const results: DetectionResult[] = [];

	// Claude Code Detection
	if (
		env.CLAUDE_CODE_VERSION ||
		env.CLAUDE_CLI_VERSION ||
		argv.some((arg) => arg.includes("claude-code")) ||
		cwd.includes("claude-code") ||
		env.CLAUDE_DESKTOP_PATH
	) {
		results.push({
			type: "claude-code",
			name: "Claude Code",
			version: env.CLAUDE_CODE_VERSION || env.CLAUDE_CLI_VERSION,
			userAgent: "claude-code",
			confidence: 0.95,
			methods: ["env-claude-code", "argv-claude", "path-claude"],
			category: "official",
			platform: "desktop",
			integration: "native",
		});
	}

	// Claude Desktop Detection
	if (transportMode === "stdio" && !results.length) {
		results.push({
			type: "claude-desktop",
			name: "Claude Desktop",
			userAgent: "claude-desktop",
			confidence: 0.7,
			methods: ["transport-stdio-default"],
			category: "official",
			platform: "desktop",
			integration: "native",
		});
	}

	// Claude Web Detection
	if (transportMode === "sse") {
		results.push({
			type: "claude-web",
			name: "Claude Web",
			userAgent: "claude-web",
			confidence: 0.8,
			methods: ["transport-sse"],
			category: "official",
			platform: "web",
			integration: "native",
		});
	}

	return results;
}

// IDE Integration Detection
function runIDEIntegrationDetection(env: Record<string, string>, argv: string[], cwd: string): DetectionResult[] {
	const results: DetectionResult[] = [];

	// VS Code Extension
	if (env.VSCODE_PID || env.VSCODE_IPC_HOOK || argv.some((arg) => arg.includes("vscode"))) {
		results.push({
			type: "vscode-extension",
			name: "VS Code Claude Extension",
			version: env.VSCODE_VERSION,
			userAgent: "vscode-claude",
			confidence: 0.9,
			methods: ["env-vscode", "process-vscode"],
			category: "ide",
			platform: "desktop",
			integration: "extension",
		});
	}

	// JetBrains IDEs (WebStorm, IntelliJ, etc.)
	if (
		cwd.includes("WebstormProjects") ||
		cwd.includes("IntellijProjects") ||
		env.JETBRAINS_IDE ||
		argv.some((arg) => arg.includes("jetbrains"))
	) {
		results.push({
			type: "jetbrains-plugin",
			name: "JetBrains Claude Plugin",
			version: env.JETBRAINS_VERSION,
			userAgent: "jetbrains-claude",
			confidence: 0.85,
			methods: ["path-jetbrains", "env-jetbrains"],
			category: "ide",
			platform: "desktop",
			integration: "plugin",
		});
	}

	// Vim/Neovim
	if (env.VIM_VERSION || env.NVIM_VERSION || argv.some((arg) => arg.includes("vim"))) {
		results.push({
			type: "vim-plugin",
			name: "Vim Claude Plugin",
			version: env.VIM_VERSION || env.NVIM_VERSION,
			userAgent: "vim-claude",
			confidence: 0.8,
			methods: ["env-vim", "process-vim"],
			category: "ide",
			platform: "desktop",
			integration: "plugin",
		});
	}

	// Emacs
	if (env.EMACS_VERSION || argv.some((arg) => arg.includes("emacs"))) {
		results.push({
			type: "emacs-extension",
			name: "Emacs Claude Extension",
			version: env.EMACS_VERSION,
			userAgent: "emacs-claude",
			confidence: 0.8,
			methods: ["env-emacs", "process-emacs"],
			category: "ide",
			platform: "desktop",
			integration: "extension",
		});
	}

	return results;
}

// MCP Client Library Detection
function runMCPLibraryDetection(env: Record<string, string>, argv: string[], cwd: string): DetectionResult[] {
	const results: DetectionResult[] = [];

	// Python MCP Client
	if (argv.some((arg) => arg.includes("python")) && (cwd.includes("mcp") || env.MCP_CLIENT_PYTHON)) {
		results.push({
			type: "mcp-client-python",
			name: "Python MCP Client",
			version: env.MCP_CLIENT_VERSION,
			userAgent: "mcp-python",
			confidence: 0.85,
			methods: ["process-python", "path-mcp", "env-mcp"],
			category: "library",
			platform: "server",
			integration: "api",
		});
	}

	// TypeScript/Node MCP Client
	if (
		argv.some((arg) => arg.includes("node") || arg.includes("bun") || arg.includes("tsx")) &&
		(cwd.includes("mcp") || env.MCP_CLIENT_TS)
	) {
		results.push({
			type: "mcp-client-typescript",
			name: "TypeScript MCP Client",
			version: env.MCP_CLIENT_VERSION,
			userAgent: "mcp-typescript",
			confidence: 0.8,
			methods: ["process-typescript", "path-mcp"],
			category: "library",
			platform: "server",
			integration: "api",
		});
	}

	return results;
}

// Custom Client Detection
function runCustomClientDetection(env: Record<string, string>, argv: string[], cwd: string): DetectionResult[] {
	const results: DetectionResult[] = [];

	// Custom Web Client
	if (env.CUSTOM_CLIENT_WEB || env.HTTP_USER_AGENT?.includes("custom")) {
		results.push({
			type: "custom-web-client",
			name: env.CUSTOM_CLIENT_NAME || "Custom Web Client",
			version: env.CUSTOM_CLIENT_VERSION,
			userAgent: env.HTTP_USER_AGENT || "custom-web",
			confidence: 0.9,
			methods: ["env-custom-web", "user-agent-custom"],
			category: "custom",
			platform: "web",
			integration: "api",
		});
	}

	// Enterprise Client
	if (env.ENTERPRISE_CLIENT || cwd.includes("enterprise")) {
		results.push({
			type: "enterprise-client",
			name: env.ENTERPRISE_CLIENT_NAME || "Enterprise Client",
			version: env.ENTERPRISE_CLIENT_VERSION,
			userAgent: "enterprise-client",
			confidence: 0.85,
			methods: ["env-enterprise", "path-enterprise"],
			category: "custom",
			platform: "desktop",
			integration: "standalone",
		});
	}

	return results;
}

// Development Tool Detection
function runDevelopmentToolDetection(env: Record<string, string>, argv: string[], cwd: string): DetectionResult[] {
	const results: DetectionResult[] = [];

	// CI/CD Pipeline
	if (env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.JENKINS_URL) {
		results.push({
			type: "ci-cd-pipeline",
			name: "CI/CD Pipeline",
			version: env.CI_VERSION,
			userAgent: "ci-cd",
			confidence: 0.95,
			methods: ["env-ci", "env-github-actions"],
			category: "development",
			platform: "server",
			integration: "api",
		});
	}

	// Testing Framework
	if (argv.some((arg) => arg.includes("test") || arg.includes("jest") || arg.includes("pytest"))) {
		results.push({
			type: "testing-framework",
			name: "Testing Framework",
			userAgent: "testing-framework",
			confidence: 0.8,
			methods: ["process-testing"],
			category: "development",
			platform: "server",
			integration: "api",
		});
	}

	// Automation Script
	if (argv.some((arg) => arg.includes("script") || arg.includes("automation"))) {
		results.push({
			type: "automation-script",
			name: "Automation Script",
			userAgent: "automation",
			confidence: 0.7,
			methods: ["process-automation"],
			category: "development",
			platform: "server",
			integration: "api",
		});
	}

	return results;
}

// Transport Analysis
function runTransportAnalysis(transportMode: "stdio" | "sse"): DetectionResult[] {
	if (transportMode === "stdio") {
		return [
			{
				type: "unknown",
				name: "Unknown STDIO Client",
				userAgent: "unknown-stdio",
				confidence: 0.3,
				methods: ["transport-stdio"],
				category: "unknown",
				platform: "desktop",
				integration: "native",
			},
		];
	} else {
		return [
			{
				type: "unknown",
				name: "Unknown Web Client",
				userAgent: "unknown-web",
				confidence: 0.4,
				methods: ["transport-sse"],
				category: "unknown",
				platform: "web",
				integration: "api",
			},
		];
	}
}

// Platform Analysis
function runPlatformAnalysis(platform: string, env: Record<string, string>): DetectionResult[] {
	const results: DetectionResult[] = [];

	// Add platform-specific hints
	if (platform === "darwin" && env.TERM_PROGRAM) {
		results.push({
			type: "unknown",
			name: `macOS ${env.TERM_PROGRAM} Client`,
			userAgent: `macos-${env.TERM_PROGRAM}`,
			confidence: 0.2,
			methods: ["platform-macos", "term-program"],
			category: "unknown",
			platform: "desktop",
			integration: "native",
		});
	}

	return results;
}

function getClientCapabilities(clientType: ClientType): ClientCapabilities {
	switch (clientType) {
		// Official Claude Clients
		case "claude-code":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: true,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: true,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: true,
				hasStatusBar: true,
				hasNotifications: true,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: true,
				preferredElicitationMode: "interactive",
			};

		case "claude-desktop":
			return {
				hasFileSystem: false,
				hasGitContext: false,
				hasTodoList: false,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: true,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: false,
				hasTerminalAccess: false,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: true,
				hasStatusBar: false,
				hasNotifications: true,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: false,
				preferredElicitationMode: "interactive",
			};

		case "claude-web":
			return {
				hasFileSystem: false,
				hasGitContext: false,
				hasTodoList: false,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: true,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: false,
				hasTerminalAccess: false,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: true,
				hasStatusBar: false,
				hasNotifications: true,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: false,
				preferredElicitationMode: "mixed",
			};

		// IDE Integrations
		case "vscode-extension":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: true,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: true,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: true,
				hasStatusBar: true,
				hasNotifications: true,
				hasIDEIntegration: true,
				hasDebuggerAccess: true,
				hasExtensionAPI: true,
				preferredElicitationMode: "interactive",
			};

		case "jetbrains-plugin":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: true,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: false,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: false,
				hasStatusBar: true,
				hasNotifications: true,
				hasIDEIntegration: true,
				hasDebuggerAccess: true,
				hasExtensionAPI: true,
				preferredElicitationMode: "interactive",
			};

		case "vim-plugin":
		case "emacs-extension":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: false,
				hasDirectInput: true,
				supportsInteractiveElicitation: false,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: false,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: true,
				supportsInlineImages: false,
				hasStatusBar: true,
				hasNotifications: false,
				hasIDEIntegration: true,
				hasDebuggerAccess: false,
				hasExtensionAPI: true,
				preferredElicitationMode: "direct-prompt",
			};

		// MCP Client Libraries
		case "mcp-client-python":
		case "mcp-client-typescript":
		case "mcp-client-rust":
		case "mcp-client-go":
			return {
				hasFileSystem: true,
				hasGitContext: false,
				hasTodoList: false,
				hasDirectInput: false,
				supportsInteractiveElicitation: true,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: false,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: false,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: false,
				supportsInlineImages: false,
				hasStatusBar: false,
				hasNotifications: false,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: true,
				preferredElicitationMode: "api-driven",
			};

		// Custom/Enterprise Clients
		case "custom-web-client":
			return {
				hasFileSystem: false,
				hasGitContext: false,
				hasTodoList: false,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: true,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: false,
				hasTerminalAccess: false,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: true,
				hasStatusBar: false,
				hasNotifications: true,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: true,
				preferredElicitationMode: "mixed",
			};

		case "custom-desktop-client":
		case "enterprise-client":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: true,
				hasDirectInput: true,
				supportsInteractiveElicitation: true,
				supportsImageUpload: true,
				supportsRealTimeUpdates: true,
				supportsProgressIndicators: true,
				hasCodeExecution: false,
				hasTerminalAccess: false,
				hasNetworkAccess: true,
				hasClipboardAccess: true,
				supportsMarkdownRendering: true,
				supportsCodeHighlighting: true,
				supportsInlineImages: true,
				hasStatusBar: true,
				hasNotifications: true,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: true,
				preferredElicitationMode: "mixed",
			};

		case "api-client":
			return {
				hasFileSystem: false,
				hasGitContext: false,
				hasTodoList: false,
				hasDirectInput: false,
				supportsInteractiveElicitation: false,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: false,
				hasCodeExecution: false,
				hasTerminalAccess: false,
				hasNetworkAccess: true,
				hasClipboardAccess: false,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: false,
				supportsInlineImages: false,
				hasStatusBar: false,
				hasNotifications: false,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: true,
				preferredElicitationMode: "api-driven",
			};

		// Development Tools
		case "ci-cd-pipeline":
		case "automation-script":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: false,
				hasDirectInput: false,
				supportsInteractiveElicitation: false,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: false,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: false,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: false,
				supportsInlineImages: false,
				hasStatusBar: false,
				hasNotifications: false,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: false,
				preferredElicitationMode: "api-driven",
			};

		case "testing-framework":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: false,
				hasDirectInput: false,
				supportsInteractiveElicitation: false,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: true,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: false,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: false,
				supportsInlineImages: false,
				hasStatusBar: false,
				hasNotifications: false,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: false,
				preferredElicitationMode: "api-driven",
			};

		case "cli-tool":
			return {
				hasFileSystem: true,
				hasGitContext: true,
				hasTodoList: false,
				hasDirectInput: true,
				supportsInteractiveElicitation: false,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: false,
				hasCodeExecution: true,
				hasTerminalAccess: true,
				hasNetworkAccess: true,
				hasClipboardAccess: false,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: false,
				supportsInlineImages: false,
				hasStatusBar: false,
				hasNotifications: false,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: false,
				preferredElicitationMode: "direct-prompt",
			};

		// Default/Unknown
		default:
			return {
				hasFileSystem: false,
				hasGitContext: false,
				hasTodoList: false,
				hasDirectInput: true,
				supportsInteractiveElicitation: false,
				supportsImageUpload: false,
				supportsRealTimeUpdates: false,
				supportsProgressIndicators: false,
				hasCodeExecution: false,
				hasTerminalAccess: false,
				hasNetworkAccess: true,
				hasClipboardAccess: false,
				supportsMarkdownRendering: false,
				supportsCodeHighlighting: false,
				supportsInlineImages: false,
				hasStatusBar: false,
				hasNotifications: false,
				hasIDEIntegration: false,
				hasDebuggerAccess: false,
				hasExtensionAPI: false,
				preferredElicitationMode: "direct-prompt",
			};
	}
}

/**
 * Determine elicitation strategy based on client capabilities
 */
export function getElicitationStrategy(client: ClientEnvironment): {
	strategy: "interactive-session" | "direct-prompt" | "hybrid";
	rationale: string;
	adaptations: string[];
} {
	const adaptations: string[] = [];

	if (client.capabilities.supportsInteractiveElicitation) {
		adaptations.push("Use step-by-step MCP elicitation tools");
		adaptations.push("Create elicitation sessions with response processing");

		return {
			strategy: "interactive-session",
			rationale: `${client.name} supports interactive elicitation with ${client.detectionConfidence.toFixed(2)} confidence`,
			adaptations,
		};
	}

	if (client.capabilities.hasDirectInput) {
		adaptations.push("Request information in format: domain=X, environment=Y, team=Z");
		adaptations.push("Provide structured prompts for missing information");

		return {
			strategy: "direct-prompt",
			rationale: `${client.name} requires direct information provision`,
			adaptations,
		};
	}

	adaptations.push("Mix of direct prompts with fallback to interactive if supported");

	return {
		strategy: "hybrid",
		rationale: `${client.name} has mixed capabilities - adapting approach`,
		adaptations,
	};
}

/**
 * Log client detection results for debugging
 */
export function logClientDetection(client: ClientEnvironment): void {
	mcpLogger.debug("session", "Client detection results", {
		type: client.type,
		name: client.name,
		confidence: `${(client.detectionConfidence * 100).toFixed(1)}%`,
		methods: client.detectionMethod,
		capabilities: {
			fileSystem: client.capabilities.hasFileSystem,
			gitContext: client.capabilities.hasGitContext,
			todoList: client.capabilities.hasTodoList,
			elicitationMode: client.capabilities.preferredElicitationMode,
		},
	});
}
