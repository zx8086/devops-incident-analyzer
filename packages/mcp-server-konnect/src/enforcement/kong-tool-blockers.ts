/**
 * KONG TOOL BLOCKING MECHANISMS
 *
 * This file contains wrapped versions of ALL Kong MCP tools that
 * MUST pass through mandatory elicitation before execution.
 *
 * ARCHITECTURAL PRINCIPLE: Every Kong operation is blocked until
 * mandatory context (domain, environment, team) is provided.
 */

import { KongApi } from "../api/kong-api.js";
import * as configOps from "../tools/configuration/operations.js";
import * as controlPlaneOps from "../tools/control-planes/operations.js";
import { mcpLogger } from "../utils/mcp-logger.js";
import {
  ElicitationBlockedError,
  KongOperationContext,
  type MandatoryContext,
  withMandatoryElicitation,
} from "./mandatory-elicitation-gate";

/**
 * ELICITATION ENFORCEMENT ERROR
 *
 * This error is thrown when operations are attempted without
 * completing mandatory elicitation. It includes the elicitation
 * session data needed to gather missing context.
 */
export class KongOperationBlockedError extends ElicitationBlockedError {
  constructor(
    public operation: string,
    missingFields: string[],
    elicitationSession: any,
    message: string = `[BLOCKED] KONG OPERATION BLOCKED: ${operation} requires mandatory context: ${missingFields.join(", ")}`,
  ) {
    super(missingFields, elicitationSession, message);
    this.name = "KongOperationBlockedError";
  }
}

/**
 * BLOCKED KONG API CLIENT
 *
 * Returns Kong API client only after elicitation validation
 */
async function getValidatedKongApi(
  context: MandatoryContext,
): Promise<KongApi> {
  if (!context.elicitationComplete) {
    throw new Error(
      "INTERNAL ERROR: Kong API requested without completed elicitation",
    );
  }

  return new KongApi();
}

/**
 * TAG GENERATION WITH MANDATORY CONTEXT
 *
 * Generates the mandatory 5-tag system using elicited context
 */
function generateMandatoryTags(
  context: MandatoryContext,
  entityType: string,
  entityPurpose?: string,
): string[] {
  const mandatoryTags = [
    `env-${context.environment}`,
    `domain-${context.domain}`,
    `team-${context.team}`,
  ];

  const optionalTags = [
    `type-${entityType}`,
    entityPurpose ? `purpose-${entityPurpose}` : `function-gateway`,
  ];

  const allTags = [...mandatoryTags, ...optionalTags];

  mcpLogger.debug("enforcement", "Mandatory tags generated", { tags: allTags });

  return allTags;
}

/**
 * BLOCKED SERVICE OPERATIONS
 */
export const BlockedServiceOperations = {
  /**
   * CREATE SERVICE - BLOCKED UNTIL ELICITATION
   */
  async createService(
    controlPlaneId: string,
    name: string,
    host: string,
    port: number = 80,
    protocol: string = "http",
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
    additionalParams: any = {},
  ) {
    return await withMandatoryElicitation(
      "create_service",
      {
        operationName: "create_service",
        parameters: {
          controlPlaneId,
          name,
          host,
          port,
          protocol,
          ...additionalParams,
        },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        mcpLogger.info(
          "enforcement",
          "Creating service with validated context",
          { name },
        );

        const api = await getValidatedKongApi(validatedContext);
        const tags = generateMandatoryTags(
          validatedContext,
          "service",
          additionalParams.purpose,
        );

        return await configOps.createService(api, controlPlaneId, {
          name,
          host,
          port,
          protocol,
          tags,
          ...additionalParams,
        });
      },
    );
  },

  /**
   * UPDATE SERVICE - BLOCKED UNTIL ELICITATION
   */
  async updateService(
    controlPlaneId: string,
    serviceId: string,
    updates: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "update_service",
      {
        operationName: "update_service",
        parameters: { controlPlaneId, serviceId, updates },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);

        // Ensure mandatory tags are preserved/added in updates
        if (!updates.tags) {
          updates.tags = generateMandatoryTags(validatedContext, "service");
        }

        return await configOps.updateService(
          api,
          controlPlaneId,
          serviceId,
          updates,
        );
      },
    );
  },

  /**
   * DELETE SERVICE - BLOCKED UNTIL ELICITATION
   */
  async deleteService(
    controlPlaneId: string,
    serviceId: string,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "delete_service",
      {
        operationName: "delete_service",
        parameters: { controlPlaneId, serviceId },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        return await configOps.deleteService(api, controlPlaneId, serviceId);
      },
    );
  },
};

/**
 * BLOCKED ROUTE OPERATIONS
 */
export const BlockedRouteOperations = {
  /**
   * CREATE ROUTE - BLOCKED UNTIL ELICITATION
   */
  async createRoute(
    controlPlaneId: string,
    routeParams: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "create_route",
      {
        operationName: "create_route",
        parameters: { controlPlaneId, ...routeParams },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        const tags = generateMandatoryTags(
          validatedContext,
          "route",
          routeParams.purpose,
        );

        return await configOps.createRoute(api, controlPlaneId, {
          ...routeParams,
          tags,
        });
      },
    );
  },

  /**
   * UPDATE ROUTE - BLOCKED UNTIL ELICITATION
   */
  async updateRoute(
    controlPlaneId: string,
    routeId: string,
    updates: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "update_route",
      {
        operationName: "update_route",
        parameters: { controlPlaneId, routeId, updates },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);

        if (!updates.tags) {
          updates.tags = generateMandatoryTags(validatedContext, "route");
        }

        return await configOps.updateRoute(
          api,
          controlPlaneId,
          routeId,
          updates,
        );
      },
    );
  },

  /**
   * DELETE ROUTE - BLOCKED UNTIL ELICITATION
   */
  async deleteRoute(
    controlPlaneId: string,
    routeId: string,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "delete_route",
      {
        operationName: "delete_route",
        parameters: { controlPlaneId, routeId },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        return await configOps.deleteRoute(api, controlPlaneId, routeId);
      },
    );
  },
};

/**
 * BLOCKED CONSUMER OPERATIONS
 */
export const BlockedConsumerOperations = {
  /**
   * CREATE CONSUMER - BLOCKED UNTIL ELICITATION
   */
  async createConsumer(
    controlPlaneId: string,
    consumerParams: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "create_consumer",
      {
        operationName: "create_consumer",
        parameters: { controlPlaneId, ...consumerParams },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        const tags = generateMandatoryTags(
          validatedContext,
          "consumer",
          consumerParams.purpose,
        );

        return await configOps.createConsumer(api, controlPlaneId, {
          ...consumerParams,
          tags,
        });
      },
    );
  },

  /**
   * DELETE CONSUMER - BLOCKED UNTIL ELICITATION
   */
  async deleteConsumer(
    controlPlaneId: string,
    consumerId: string,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "delete_consumer",
      {
        operationName: "delete_consumer",
        parameters: { controlPlaneId, consumerId },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        return await configOps.deleteConsumer(api, controlPlaneId, consumerId);
      },
    );
  },
};

/**
 * BLOCKED PLUGIN OPERATIONS
 */
export const BlockedPluginOperations = {
  /**
   * CREATE PLUGIN - BLOCKED UNTIL ELICITATION
   */
  async createPlugin(
    controlPlaneId: string,
    pluginParams: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "create_plugin",
      {
        operationName: "create_plugin",
        parameters: { controlPlaneId, ...pluginParams },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        const tags = generateMandatoryTags(
          validatedContext,
          "plugin",
          pluginParams.name,
        );

        return await configOps.createPlugin(api, controlPlaneId, {
          ...pluginParams,
          tags,
        });
      },
    );
  },

  /**
   * UPDATE PLUGIN - BLOCKED UNTIL ELICITATION
   */
  async updatePlugin(
    controlPlaneId: string,
    pluginId: string,
    updates: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "update_plugin",
      {
        operationName: "update_plugin",
        parameters: { controlPlaneId, pluginId, updates },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);

        if (!updates.tags) {
          updates.tags = generateMandatoryTags(validatedContext, "plugin");
        }

        return await configOps.updatePlugin(
          api,
          controlPlaneId,
          pluginId,
          updates,
        );
      },
    );
  },

  /**
   * DELETE PLUGIN - BLOCKED UNTIL ELICITATION
   */
  async deletePlugin(
    controlPlaneId: string,
    pluginId: string,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "delete_plugin",
      {
        operationName: "delete_plugin",
        parameters: { controlPlaneId, pluginId },
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);
        return await configOps.deletePlugin(api, controlPlaneId, pluginId);
      },
    );
  },
};

/**
 * BLOCKED LIST OPERATIONS
 *
 * Read operations are generally allowed, but we may want to
 * track context for consistency in some cases.
 */
export const BlockedListOperations = {
  /**
   * LIST SERVICES - NO BLOCKING (READ OPERATION)
   */
  async listServices(controlPlaneId: string) {
    const api = new KongApi();
    return await configOps.listServices(api, controlPlaneId);
  },

  /**
   * LIST ROUTES - NO BLOCKING (READ OPERATION)
   */
  async listRoutes(controlPlaneId: string) {
    const api = new KongApi();
    return await configOps.listRoutes(api, controlPlaneId);
  },

  /**
   * LIST CONSUMERS - NO BLOCKING (READ OPERATION)
   */
  async listConsumers(controlPlaneId: string) {
    const api = new KongApi();
    return await configOps.listConsumers(api, controlPlaneId);
  },

  /**
   * LIST PLUGINS - NO BLOCKING (READ OPERATION)
   */
  async listPlugins(controlPlaneId: string) {
    const api = new KongApi();
    return await configOps.listPlugins(api, controlPlaneId);
  },
};

/**
 * BLOCKED CONTROL PLANE OPERATIONS
 *
 * Control plane operations typically don't need entity-level tagging
 * but may still require context for proper organization.
 */
export const BlockedControlPlaneOperations = {
  /**
   * LIST CONTROL PLANES - NO BLOCKING (READ OPERATION)
   */
  async listControlPlanes() {
    const api = new KongApi();
    return await controlPlaneOps.listControlPlanes(api);
  },

  /**
   * CREATE CONTROL PLANE - BLOCKED UNTIL ELICITATION
   */
  async createControlPlane(
    params: any,
    requestContext: { userMessage: string; files?: string[]; configs?: any[] },
  ) {
    return await withMandatoryElicitation(
      "create_control_plane",
      {
        operationName: "create_control_plane",
        parameters: params,
        requestContext,
      },
      async (validatedContext: MandatoryContext) => {
        const api = await getValidatedKongApi(validatedContext);

        // Add context-aware labels to control plane
        const labels = {
          domain: validatedContext.domain,
          environment: validatedContext.environment,
          team: validatedContext.team,
          ...params.labels,
        };

        return await controlPlaneOps.createControlPlane(api, {
          ...params,
          labels,
        });
      },
    );
  },
};
