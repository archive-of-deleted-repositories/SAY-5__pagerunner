import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const NavigateInput = z.object({
  url: z.string().url(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
});
export type NavigateInput = z.infer<typeof NavigateInput>;

export const ClickInput = z.object({
  selector: z.string().min(1),
  nth: z.number().int().min(0).optional(),
});
export type ClickInput = z.infer<typeof ClickInput>;

export const TypeInput = z.object({
  selector: z.string().min(1),
  text: z.string(),
  submit: z.boolean().default(false),
});
export type TypeInput = z.infer<typeof TypeInput>;

export const ExtractInput = z.object({
  selector: z.string().min(1),
  attribute: z.string().optional(),
  multiple: z.boolean().default(false),
});
export type ExtractInput = z.infer<typeof ExtractInput>;

export const WaitInput = z.object({
  selector: z.string().optional(),
  ms: z.number().int().min(0).max(30_000).optional(),
});
export type WaitInput = z.infer<typeof WaitInput>;

export const FinishInput = z.object({
  result: z.record(z.unknown()).default({}),
  reason: z.string().default('done'),
});
export type FinishInput = z.infer<typeof FinishInput>;

export const TOOLS = {
  navigate: NavigateInput,
  click: ClickInput,
  type: TypeInput,
  extract: ExtractInput,
  wait: WaitInput,
  finish: FinishInput,
} as const;

export type ToolName = keyof typeof TOOLS;

export const ToolCall = z.object({
  tool: z.enum(['navigate', 'click', 'type', 'extract', 'wait', 'finish']),
  input: z.record(z.unknown()),
});
// Hand-written to avoid Zod's `z.record(z.unknown())` inferring optional fields
// under exactOptionalPropertyTypes, which infects every call site.
export type ToolCall = {
  tool: 'navigate' | 'click' | 'type' | 'extract' | 'wait' | 'finish';
  input: Record<string, unknown>;
};

export const validateToolCall = (call: ToolCall): { tool: ToolName; input: unknown } => {
  const schema = TOOLS[call.tool];
  return { tool: call.tool, input: schema.parse(call.input) };
};

export const toolJsonSchemas = (): Record<ToolName, unknown> => {
  const out = {} as Record<ToolName, unknown>;
  for (const [name, schema] of Object.entries(TOOLS)) {
    // zod-to-json-schema's union over discriminated Zod objects loses precision;
    // cast through `any` keeps the call site clean without leaking generics.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[name as ToolName] = zodToJsonSchema(schema as any, name);
  }
  return out;
};
