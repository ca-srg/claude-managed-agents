import { TOOL_NAMES } from "@/shared/constants";
import type { CustomToolDefinition } from "@/shared/tool-schema-core";
import { toJsonSchema } from "@/shared/tool-schema-core";

import { CreateFinalPrInput } from "./schemas";

export const CREATE_FINAL_PR_TOOL_DEFINITION: CustomToolDefinition = {
  description:
    "Create or update the final pull request for this run. Origin-specific closing/provenance is added server-side.",
  input_schema: toJsonSchema(CreateFinalPrInput),
  name: TOOL_NAMES.CREATE_FINAL_PR,
  type: "custom",
};
