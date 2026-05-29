import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { TOOL_NAMES } from "@/shared/constants";

export const ToolErrorSchema = z
  .object({
    details: z.unknown().optional().describe("Optional structured error details for debugging."),
    message: z.string().min(1).describe("Human-readable explanation of the tool failure."),
    type: z.string().min(1).describe("Stable machine-readable error category for the tool."),
  })
  .strict()
  .describe("Structured tool failure details.");

export type JsonSchemaObject = Record<string, unknown> & {
  type?: string | string[];
};

export type CustomToolDefinition = {
  description: string;
  input_schema: JsonSchemaObject;
  name: (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
  type: "custom";
};

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject {
  return zodToJsonSchema(schema, {
    $refStrategy: "none",
    errorMessages: true,
    target: "jsonSchema7",
  }) as JsonSchemaObject;
}
