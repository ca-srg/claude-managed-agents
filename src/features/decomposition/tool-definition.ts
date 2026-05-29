import { TOOL_NAMES } from "@/shared/constants";
import type { CustomToolDefinition } from "@/shared/tool-schema-core";
import { toJsonSchema } from "@/shared/tool-schema-core";

import { CreateSubIssueInput } from "./schemas";

export const CREATE_SUB_ISSUE_TOOL_DEFINITION: CustomToolDefinition = {
  description: "Create or reuse a linked GitHub sub-issue for one decomposed child task.",
  input_schema: toJsonSchema(CreateSubIssueInput),
  name: TOOL_NAMES.CREATE_SUB_ISSUE,
  type: "custom",
};
