/* src/lib/constants.ts */

export const ENV_TRUE = ["true", "1", "y", "yes", "on"] as const;

// Type for environment truthy values
export type EnvTruthy = typeof ENV_TRUE[number];

// Helper function to check if a value is truthy
export function isTruthy(value: string | undefined): boolean {
    return value ? ENV_TRUE.includes(value.toLowerCase() as EnvTruthy) : false;
} 