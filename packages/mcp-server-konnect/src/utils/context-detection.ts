/**
 * Context Detection Patterns for Kong Migrations
 *
 * Implements intelligent pattern matching and context extraction for detecting
 * implicit information from user messages, file paths, configuration content,
 * and other contextual signals.
 */

export interface DetectionPattern {
  name: string;
  pattern: RegExp;
  confidence: number;
  extractor: (match: RegExpMatchArray) => string;
  validator?: (value: string) => boolean;
  category: "domain" | "environment" | "team" | "service-type" | "protocol";
}

export interface ContextSignal {
  value: string;
  confidence: number;
  source: string;
  pattern: string;
  category: string;
}

export interface DetectionResult {
  domain: ContextSignal[];
  environment: ContextSignal[];
  team: ContextSignal[];
  serviceType: ContextSignal[];
  protocol: ContextSignal[];
  summary: {
    bestDomain?: ContextSignal;
    bestEnvironment?: ContextSignal;
    bestTeam?: ContextSignal;
    overallConfidence: number;
  };
}

export class ContextDetector {
  private patterns: DetectionPattern[] = [
    // Domain Detection Patterns
    {
      name: "explicit-domain-mention",
      pattern:
        /(?:for the|using the|migrate to|in the|domain[:\s]+)([a-z0-9]([a-z0-9-]*[a-z0-9])?)\s+domain/gi,
      confidence: 0.95,
      extractor: (match) => match[1].toLowerCase(),
      validator: (value) => value.length >= 3 && value.length <= 20,
      category: "domain",
    },
    {
      name: "domain-keyword",
      pattern: /domain[:\s]*([a-z0-9-]{3,20})/gi,
      confidence: 0.8,
      extractor: (match) => match[1].toLowerCase(),
      validator: (value) => value.length >= 3 && value.length <= 20,
      category: "domain",
    },
    {
      name: "possessive-domain",
      pattern: /([a-z0-9-]{3,20})\s+(?:domain|team|services?|apis?)/gi,
      confidence: 0.6,
      extractor: (match) => match[1].toLowerCase(),
      validator: (value) =>
        !["the", "our", "this", "that", "some"].includes(value),
      category: "domain",
    },

    // Environment Detection Patterns
    {
      name: "explicit-environment",
      pattern:
        /(?:for|in|to|environment[:\s]+)(production|staging|development|dev|prod|test)/gi,
      confidence: 0.9,
      extractor: (match) => this.normalizeEnvironment(match[1].toLowerCase()),
      category: "environment",
    },
    {
      name: "env-prefix",
      pattern: /env[:\s]*(production|staging|development|dev|prod|test)/gi,
      confidence: 0.85,
      extractor: (match) => this.normalizeEnvironment(match[1].toLowerCase()),
      category: "environment",
    },
    {
      name: "deploy-context",
      pattern:
        /deploy(?:ing|ed)?.*?(?:to|in).*?(production|staging|development|dev|prod|test)/gi,
      confidence: 0.75,
      extractor: (match) => this.normalizeEnvironment(match[1].toLowerCase()),
      category: "environment",
    },

    // Team Detection Patterns
    {
      name: "explicit-team",
      pattern:
        /(?:team|owned by|belongs to|maintained by)[:\s]+([a-z0-9-]{2,15})/gi,
      confidence: 0.9,
      extractor: (match) => match[1].toLowerCase(),
      validator: (value) => !["the", "our", "my", "a"].includes(value),
      category: "team",
    },
    {
      name: "team-possessive",
      pattern: /([a-z0-9-]{2,15})\s+team/gi,
      confidence: 0.7,
      extractor: (match) => match[1].toLowerCase(),
      validator: (value) =>
        !["the", "our", "my", "your", "this"].includes(value),
      category: "team",
    },

    // Service Type Detection Patterns
    {
      name: "api-service-type",
      pattern:
        /(rest|graphql|grpc|microservice|api)\s+(?:service|endpoint|gateway)/gi,
      confidence: 0.8,
      extractor: (match) => match[1].toLowerCase(),
      category: "service-type",
    },
    {
      name: "service-architecture",
      pattern: /\b(microservice|monolith|serverless|lambda|function)\b/gi,
      confidence: 0.6,
      extractor: (match) => match[1].toLowerCase(),
      category: "service-type",
    },

    // Protocol Detection Patterns
    {
      name: "explicit-protocol",
      pattern: /\b(https?|grpc|tcp|udp|websocket|ws)\b/gi,
      confidence: 0.85,
      extractor: (match) => match[1].toLowerCase().replace(/^http$/, "http"),
      category: "protocol",
    },
  ];

  /**
   * Detect context from user message
   */
  detectFromMessage(message: string): DetectionResult {
    const result: DetectionResult = {
      domain: [],
      environment: [],
      team: [],
      serviceType: [],
      protocol: [],
      summary: { overallConfidence: 0 },
    };

    this.patterns.forEach((pattern) => {
      const matches = [...message.matchAll(pattern.pattern)];
      matches.forEach((match) => {
        try {
          const value = pattern.extractor(match);

          // Apply validator if present
          if (pattern.validator && !pattern.validator(value)) {
            return;
          }

          const signal: ContextSignal = {
            value,
            confidence: pattern.confidence,
            source: "user-message",
            pattern: pattern.name,
            category: pattern.category,
          };

          // Add to appropriate category
          switch (pattern.category) {
            case "domain":
              result.domain.push(signal);
              break;
            case "environment":
              result.environment.push(signal);
              break;
            case "team":
              result.team.push(signal);
              break;
            case "service-type":
              result.serviceType.push(signal);
              break;
            case "protocol":
              result.protocol.push(signal);
              break;
          }
        } catch (error) {
          // Skip invalid matches
        }
      });
    });

    this.calculateSummary(result);
    return result;
  }

  /**
   * Detect context from file paths
   */
  detectFromFilePaths(paths: string[]): DetectionResult {
    const result: DetectionResult = {
      domain: [],
      environment: [],
      team: [],
      serviceType: [],
      protocol: [],
      summary: { overallConfidence: 0 },
    };

    paths.forEach((path) => {
      // Environment detection from paths
      const envPatterns = [
        {
          pattern: /\/(prod|production)(?:\/|$)/i,
          value: "production",
          confidence: 0.8,
        },
        {
          pattern: /\/(staging|stage)(?:\/|$)/i,
          value: "staging",
          confidence: 0.8,
        },
        {
          pattern: /\/(dev|development)(?:\/|$)/i,
          value: "development",
          confidence: 0.8,
        },
        {
          pattern: /\/(test|testing)(?:\/|$)/i,
          value: "test",
          confidence: 0.7,
        },
      ];

      envPatterns.forEach(({ pattern, value, confidence }) => {
        if (pattern.test(path)) {
          result.environment.push({
            value,
            confidence,
            source: "file-path",
            pattern: "path-environment",
            category: "environment",
          });
        }
      });

      // Domain detection from path segments
      const pathSegments = path
        .split("/")
        .filter(
          (segment) =>
            segment.length > 0 &&
            segment.match(/^[a-z0-9-]{3,20}$/i) &&
            ![
              "src",
              "lib",
              "config",
              "configs",
              "kong",
              "deck",
              "yaml",
              "yml",
            ].includes(segment.toLowerCase()),
        );

      pathSegments.forEach((segment) => {
        result.domain.push({
          value: segment.toLowerCase(),
          confidence: 0.4,
          source: "file-path",
          pattern: "path-segment",
          category: "domain",
        });
      });
    });

    this.calculateSummary(result);
    return result;
  }

  /**
   * Detect context from Kong deck configuration
   */
  detectFromDeckConfig(configs: any[]): DetectionResult {
    const result: DetectionResult = {
      domain: [],
      environment: [],
      team: [],
      serviceType: [],
      protocol: [],
      summary: { overallConfidence: 0 },
    };

    configs.forEach((config) => {
      // Control plane name analysis
      if (config._konnect?.control_plane_name) {
        const cpName = config._konnect.control_plane_name.toLowerCase();
        const parts = cpName.split(/[-_\s]/);

        parts.forEach((part) => {
          if (part.length >= 3 && part.length <= 15) {
            result.domain.push({
              value: part,
              confidence: 0.6,
              source: "control-plane-name",
              pattern: "control-plane-analysis",
              category: "domain",
            });
          }
        });
      }

      // Service analysis
      if (config.services) {
        config.services.forEach((service: any) => {
          // Protocol detection
          if (service.protocol) {
            result.protocol.push({
              value: service.protocol.toLowerCase(),
              confidence: 0.9,
              source: "service-config",
              pattern: "service-protocol",
              category: "protocol",
            });
          }

          // Service name analysis for domain hints
          if (service.name) {
            const nameParts = service.name.toLowerCase().split(/[-_]/);
            nameParts.forEach((part) => {
              if (
                part.length >= 3 &&
                part.length <= 15 &&
                !["api", "service", "app", "web", "server"].includes(part)
              ) {
                result.domain.push({
                  value: part,
                  confidence: 0.3,
                  source: "service-name",
                  pattern: "service-name-analysis",
                  category: "domain",
                });
              }
            });
          }
        });
      }

      // Plugin analysis
      if (config.plugins) {
        const pluginTypes = config.plugins.map((plugin: any) => plugin.name);

        // Infer service type from plugins
        if (pluginTypes.includes("oauth2") || pluginTypes.includes("jwt")) {
          result.serviceType.push({
            value: "external-api",
            confidence: 0.7,
            source: "plugin-analysis",
            pattern: "plugin-inference",
            category: "service-type",
          });
        }
      }
    });

    this.calculateSummary(result);
    return result;
  }

  /**
   * Merge multiple detection results
   */
  mergeResults(...results: DetectionResult[]): DetectionResult {
    const merged: DetectionResult = {
      domain: [],
      environment: [],
      team: [],
      serviceType: [],
      protocol: [],
      summary: { overallConfidence: 0 },
    };

    results.forEach((result) => {
      merged.domain.push(...result.domain);
      merged.environment.push(...result.environment);
      merged.team.push(...result.team);
      merged.serviceType.push(...result.serviceType);
      merged.protocol.push(...result.protocol);
    });

    // Deduplicate and sort by confidence
    this.deduplicateSignals(merged);
    this.calculateSummary(merged);

    return merged;
  }

  /**
   * Get the most confident detection for a category
   */
  getBestDetection(signals: ContextSignal[]): ContextSignal | undefined {
    if (signals.length === 0) return undefined;

    // Group by value and sum confidences
    const grouped = new Map<
      string,
      { signal: ContextSignal; totalConfidence: number; count: number }
    >();

    signals.forEach((signal) => {
      const existing = grouped.get(signal.value);
      if (existing) {
        existing.totalConfidence += signal.confidence;
        existing.count++;
        // Keep the signal with highest individual confidence
        if (signal.confidence > existing.signal.confidence) {
          existing.signal = signal;
        }
      } else {
        grouped.set(signal.value, {
          signal,
          totalConfidence: signal.confidence,
          count: 1,
        });
      }
    });

    // Find the value with highest weighted confidence
    let best: { signal: ContextSignal; score: number } | undefined;

    grouped.forEach(({ signal, totalConfidence, count }) => {
      // Score combines total confidence with repetition bonus
      const score = totalConfidence + (count > 1 ? 0.1 * (count - 1) : 0);

      if (!best || score > best.score) {
        best = { signal, score };
      }
    });

    return best?.signal;
  }

  /**
   * Generate confidence explanation
   */
  explainDetection(signal: ContextSignal): string {
    const sourceDescriptions = {
      "user-message": "explicitly mentioned in your message",
      "file-path": "inferred from configuration file path",
      "control-plane-name": "extracted from control plane name",
      "service-config": "detected in service configuration",
      "service-name": "inferred from service names",
      "plugin-analysis": "inferred from plugin configuration",
    };

    const confidenceLevel =
      signal.confidence >= 0.8
        ? "high"
        : signal.confidence >= 0.6
          ? "medium"
          : "low";

    return `"${signal.value}" (${confidenceLevel} confidence) - ${sourceDescriptions[signal.source as keyof typeof sourceDescriptions] || "detected from configuration"}`;
  }

  // Private helper methods
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

  private calculateSummary(result: DetectionResult): void {
    result.summary.bestDomain = this.getBestDetection(result.domain);
    result.summary.bestEnvironment = this.getBestDetection(result.environment);
    result.summary.bestTeam = this.getBestDetection(result.team);

    // Calculate overall confidence as average of best detections
    const bestSignals = [
      result.summary.bestDomain,
      result.summary.bestEnvironment,
      result.summary.bestTeam,
    ].filter(Boolean) as ContextSignal[];

    result.summary.overallConfidence =
      bestSignals.length > 0
        ? bestSignals.reduce((sum, signal) => sum + signal.confidence, 0) /
          bestSignals.length
        : 0;
  }

  private deduplicateSignals(result: DetectionResult): void {
    const deduplicate = (signals: ContextSignal[]) => {
      const seen = new Map<string, ContextSignal>();

      signals.forEach((signal) => {
        const existing = seen.get(signal.value);
        if (!existing || signal.confidence > existing.confidence) {
          seen.set(signal.value, signal);
        }
      });

      return Array.from(seen.values()).sort(
        (a, b) => b.confidence - a.confidence,
      );
    };

    result.domain = deduplicate(result.domain);
    result.environment = deduplicate(result.environment);
    result.team = deduplicate(result.team);
    result.serviceType = deduplicate(result.serviceType);
    result.protocol = deduplicate(result.protocol);
  }
}

// Export singleton instance
export const contextDetector = new ContextDetector();
