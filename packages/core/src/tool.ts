import type { z } from 'zod';
import type { ContentBlock, ToolResultContent } from './types';
import type { Runtime } from './runtime';

/** Tool contract (DD-4). Zod is the single schema source (ADR-07). */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network' | 'meta';

export interface ToolProgress {
  note: string;
}

export interface ToolOutput {
  content: ToolResultContent[];
  isError?: boolean;
}

export interface PromptContext {
  cwd: string;
}

export interface ToolContext {
  runtime: Runtime;
  cwd: string;
  signal: AbortSignal;
  /** Emit progress to the event stream (tool.progress). */
  progress(note: string): void;
}

export interface Tool<I = unknown> {
  name: string;
  description: string | ((ctx: PromptContext) => string);
  /** Zod schema; I is its output type. Input side is `unknown` (model args). */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  risk: ToolRisk;
  readOnly: boolean;
  concurrencySafe: boolean;
  timeoutMs?: number;
  /** Parameters used for permission rule matching (path / command / url). */
  permissionSubject?(input: I): PermissionSubject;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput> | AsyncGenerator<ToolProgress, ToolOutput>;
}

export interface PermissionSubject {
  path?: string;
  command?: string;
  url?: string;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name} (FR-021: names are unique)`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitions(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.list().map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : t.description({ cwd: '' }),
      inputSchema: zodToJsonSchema(t.inputSchema),
    }));
  }
}

/**
 * Minimal Zod → JSON Schema conversion. Covers the constructs our own tools
 * use (object/string/number/boolean/enum/optional/default/describe) and leaves
 * anything exotic as `{}` (any), which is what MCP servers tolerate too.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = schema._def as Record<string, unknown>;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape as Record<string, z.ZodType>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        const inner = value._def as Record<string, unknown>;
        const isOptional = inner.typeName === 'ZodOptional';
        const hasDefault = inner.typeName === 'ZodDefault';
        if (!isOptional && !hasDefault) required.push(key);
      }
      return { type: 'object', properties, required: required.length > 0 ? required : undefined };
    }
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      const checks = (def.checks ?? []) as { kind?: string; value?: unknown }[];
      for (const c of checks) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
      }
      return out;
    }
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type as z.ZodType) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodLiteral':
      return { type: 'string', enum: [def.value] };
    case 'ZodOptional':
    case 'ZodNullable':
      return zodToJsonSchema(def.innerType as z.ZodType);
    case 'ZodDefault':
      return { ...zodToJsonSchema(def.innerType as z.ZodType), default: (def.defaultValue as () => unknown)() };
    case 'ZodUnion': {
      const options = (def.options as z.ZodType[]).map(zodToJsonSchema);
      return { anyOf: options };
    }
    default:
      return {};
  }
}

export function textContent(text: string): ToolResultContent[] {
  return [{ type: 'text', text }];
}

export function isTextBlock(b: ContentBlock): b is Extract<ContentBlock, { type: 'text' }> {
  return b.type === 'text';
}
