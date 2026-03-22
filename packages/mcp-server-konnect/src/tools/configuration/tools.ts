import type { z } from "zod";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type ConfigurationTool = {
  method: string;
  name: string;
  description: string;
  parameters: z.ZodObject<any, any, any, any>;
  category: string;
};

export const configurationTools = (): ConfigurationTool[] => [
  // =========================
  // Legacy List Tools (for backward compatibility)
  // =========================
  {
    method: "list_services",
    name: "List Services",
    description: prompts.listServicesPrompt(),
    parameters: parameters.listServicesParameters(),
    category: "configuration",
  },
  {
    method: "list_routes",
    name: "List Routes",
    description: prompts.listRoutesPrompt(),
    parameters: parameters.listRoutesParameters(),
    category: "configuration",
  },
  {
    method: "list_consumers",
    name: "List Consumers",
    description: prompts.listConsumersPrompt(),
    parameters: parameters.listConsumersParameters(),
    category: "configuration",
  },
  {
    method: "list_plugins",
    name: "List Plugins",
    description: prompts.listPluginsPrompt(),
    parameters: parameters.listPluginsParameters(),
    category: "configuration",
  },

  // =========================
  // Service CRUD Tools
  // =========================
  {
    method: "create_service",
    name: "Create Service",
    description: prompts.createServicePrompt(),
    parameters: parameters.createServiceParameters(),
    category: "configuration",
  },
  {
    method: "get_service",
    name: "Get Service",
    description: prompts.getServicePrompt(),
    parameters: parameters.getServiceParameters(),
    category: "configuration",
  },
  {
    method: "update_service",
    name: "Update Service",
    description: prompts.updateServicePrompt(),
    parameters: parameters.updateServiceParameters(),
    category: "configuration",
  },
  {
    method: "delete_service",
    name: "Delete Service",
    description: prompts.deleteServicePrompt(),
    parameters: parameters.deleteServiceParameters(),
    category: "configuration",
  },

  // =========================
  // Route CRUD Tools
  // =========================
  {
    method: "create_route",
    name: "Create Route",
    description: prompts.createRoutePrompt(),
    parameters: parameters.createRouteParameters(),
    category: "configuration",
  },
  {
    method: "get_route",
    name: "Get Route",
    description: prompts.getRoutePrompt(),
    parameters: parameters.getRouteParameters(),
    category: "configuration",
  },
  {
    method: "update_route",
    name: "Update Route",
    description: prompts.updateRoutePrompt(),
    parameters: parameters.updateRouteParameters(),
    category: "configuration",
  },
  {
    method: "delete_route",
    name: "Delete Route",
    description: prompts.deleteRoutePrompt(),
    parameters: parameters.deleteRouteParameters(),
    category: "configuration",
  },

  // =========================
  // Consumer CRUD Tools
  // =========================
  {
    method: "create_consumer",
    name: "Create Consumer",
    description: prompts.createConsumerPrompt(),
    parameters: parameters.createConsumerParameters(),
    category: "configuration",
  },
  {
    method: "get_consumer",
    name: "Get Consumer",
    description: prompts.getConsumerPrompt(),
    parameters: parameters.getConsumerParameters(),
    category: "configuration",
  },
  {
    method: "update_consumer",
    name: "Update Consumer",
    description: prompts.updateConsumerPrompt(),
    parameters: parameters.updateConsumerParameters(),
    category: "configuration",
  },
  {
    method: "delete_consumer",
    name: "Delete Consumer",
    description: prompts.deleteConsumerPrompt(),
    parameters: parameters.deleteConsumerParameters(),
    category: "configuration",
  },

  // =========================
  // Plugin CRUD Tools
  // =========================
  {
    method: "create_plugin",
    name: "Create Plugin",
    description: prompts.createPluginPrompt(),
    parameters: parameters.createPluginParameters(),
    category: "configuration",
  },
  {
    method: "get_plugin",
    name: "Get Plugin",
    description: prompts.getPluginPrompt(),
    parameters: parameters.getPluginParameters(),
    category: "configuration",
  },
  {
    method: "update_plugin",
    name: "Update Plugin",
    description: prompts.updatePluginPrompt(),
    parameters: parameters.updatePluginParameters(),
    category: "configuration",
  },
  {
    method: "delete_plugin",
    name: "Delete Plugin",
    description: prompts.deletePluginPrompt(),
    parameters: parameters.deletePluginParameters(),
    category: "configuration",
  },
  {
    method: "list_plugin_schemas",
    name: "List Plugin Schemas",
    description: prompts.listPluginSchemasPrompt(),
    parameters: parameters.listPluginSchemasParameters(),
    category: "configuration",
  },
];
