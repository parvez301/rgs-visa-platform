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
}

/**
 * Minimal Zod -> JSON Schema. Deliberately not a dependency: the tool inputs in
 * this plan are flat objects of strings, numbers, booleans, enums and arrays of
 * strings, and a whole library to convert those is weight we do not need.
 * If a tool ever needs a nested object, extend this and its test together.
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
    if (unwrapped instanceof z.ZodEnum) {
      properties[propertyName] = { type: "string", enum: unwrapped.options };
    } else if (unwrapped instanceof z.ZodNumber) {
      properties[propertyName] = { type: "number" };
    } else if (unwrapped instanceof z.ZodBoolean) {
      properties[propertyName] = { type: "boolean" };
    } else if (unwrapped instanceof z.ZodArray) {
      properties[propertyName] = { type: "array", items: { type: "string" } };
    } else {
      properties[propertyName] = { type: "string" };
    }
  }

  return { type: "object", properties, required: requiredPropertyNames };
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
