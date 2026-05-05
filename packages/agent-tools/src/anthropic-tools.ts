import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOLS, type ToolName } from './index.js';

/**
 * Anthropic tool definition shape (subset). The SDK accepts richer fields,
 * but only `name`, `description`, and `input_schema` are required for
 * tool-use mode and that keeps the conversion stable across SDK versions.
 */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const DESCRIPTIONS: Record<ToolName, string> = {
  navigate: 'Open a URL in the browser. waitUntil controls the readiness signal.',
  click: 'Click the first DOM element matching the CSS selector. Use nth to disambiguate.',
  type: 'Type text into the element matching the selector. Set submit=true to press Enter.',
  extract:
    'Read text or an attribute from the element(s) matching the selector. Set multiple=true for arrays.',
  wait: 'Wait for a selector to appear or for ms milliseconds to elapse.',
  finish: 'Terminate the run with a final result object and a short reason string.',
};

const stripJsonSchemaWrapper = (schema: Record<string, unknown>): Record<string, unknown> => {
  // zod-to-json-schema wraps the schema with `$schema`, `$ref`, `definitions`.
  // Anthropic expects a plain object schema, so unwrap to the named definition.
  const ref = schema['$ref'];
  const defs = schema['definitions'] as Record<string, Record<string, unknown>> | undefined;
  if (typeof ref === 'string' && defs) {
    const key = ref.replace('#/definitions/', '');
    const inner = defs[key];
    if (inner) return inner;
  }
  return schema;
};

export const toAnthropicTools = (): AnthropicToolDef[] =>
  (Object.keys(TOOLS) as ToolName[]).map((name) => {
    const raw = zodToJsonSchema(TOOLS[name], name) as Record<string, unknown>;
    return {
      name,
      description: DESCRIPTIONS[name],
      input_schema: stripJsonSchemaWrapper(raw),
    };
  });
