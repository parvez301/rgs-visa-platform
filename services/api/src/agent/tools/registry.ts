import { z } from "zod";
import type { AppContext } from "../../lib/context";
import type { ToolDefinition } from "../providers/types";

export type ToolKind = "read" | "write";

/**
 * One capability the agent can invoke. `kind` is what makes the approval gate
 * checkable by a test rather than by a prompt instruction someone remembers to
 * write and someone else remembers to keep true: a test can assert a property
 * over *every* write tool by filtering on this field, rather than over the
 * subset of tools whoever wrote the test happened to enumerate.
 */
export interface AgentTool<TInput = Record<string, unknown>> {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(
    context: AppContext,
    tenantId: string,
    input: TInput,
    actorEmail: string,
  ): Promise<unknown>;
  /**
   * The domain mutation this tool stands for. Present on every write tool and on
   * no read tool. `execute` only ever PROPOSES; this is the half that writes, and
   * the approval gate (Task 8) is its only caller.
   */
  apply?(context: AppContext, tenantId: string, input: TInput, actorEmail: string): Promise<unknown>;
}

/**
 * Minimal Zod -> JSON Schema. Deliberately not a dependency: the tool inputs in
 * this plan are flat objects of strings, numbers, booleans, enums, arrays of
 * those, and -- since `create_case.applicants` -- one level of arrays of
 * nested objects, and a whole library to convert those is weight we do not
 * need. If a tool ever needs a shape beyond this, extend this and its test
 * together.
 */
export function zodObjectToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const objectSchema = schema as unknown as z.ZodObject<z.ZodRawShape>;
  const shape = objectSchema.shape;
  const properties: Record<string, unknown> = {};
  const requiredPropertyNames: string[] = [];

  for (const [propertyName, propertySchema] of Object.entries(shape)) {
    const unwrapped = propertySchema instanceof z.ZodOptional ? propertySchema.unwrap() : propertySchema;
    if (!(propertySchema instanceof z.ZodOptional)) {
      requiredPropertyNames.push(propertyName);
    }
    properties[propertyName] = jsonSchemaForZodType(unwrapped);
  }

  return { type: "object", properties, required: requiredPropertyNames };
}

/**
 * The per-property half of the conversion above, factored out so an array's
 * element schema recurses through the same rules a top-level property uses.
 * `create_case.applicants` -- an array of `{applicantRef, travellerId,
 * passportNumber?}` objects -- is the one shape in this plan that needs the
 * `ZodArray` branch to recurse rather than fall back to the string default;
 * without it, the schema handed to a provider described every array as an
 * array of strings regardless of what it actually held.
 */
function jsonSchemaForZodType(zodType: z.ZodTypeAny): Record<string, unknown> {
  if (zodType instanceof z.ZodObject) {
    return zodObjectToJsonSchema(zodType);
  }
  if (zodType instanceof z.ZodArray) {
    return { type: "array", items: jsonSchemaForZodType(zodType.element) };
  }
  if (zodType instanceof z.ZodEnum) {
    return { type: "string", enum: zodType.options };
  }
  if (zodType instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (zodType instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  return { type: "string" };
}

export class ToolRegistry {
  private readonly toolsByName = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`two tools are registered under the name "${tool.name}"`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  get(toolName: string): AgentTool | undefined {
    return this.toolsByName.get(toolName);
  }

  allTools(): AgentTool[] {
    return [...this.toolsByName.values()];
  }

  readTools(): AgentTool[] {
    return this.allTools().filter((tool) => tool.kind === "read");
  }

  writeTools(): AgentTool[] {
    return this.allTools().filter((tool) => tool.kind === "write");
  }

  toolDefinitions(): ToolDefinition[] {
    return this.allTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodObjectToJsonSchema(tool.inputSchema),
    }));
  }
}
