import { isExact } from './decimal.js';
import type { JsonSchema, JsonType } from './json-schema.js';
import { numericViolation } from './numeric-facets.js';
import type { At, Problems } from './problems.js';

/** A lexical value as JSON; `rounded` says that a JSON number cannot hold it exactly. */
export function lexicalToJson(
  jsonType: JsonType | undefined,
  lexical: string,
): { value: unknown; rounded?: true } | { error: string } {
  const text = lexical.trim();
  if (jsonType === 'integer' || jsonType === 'number') {
    if (!/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(text)) {
      return { error: `${lexical} is no number` };
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return { error: `${lexical} is not a finite JSON number` };
    }
    if (jsonType === 'integer' && !Number.isInteger(value)) {
      return { error: `${lexical} is no integer` };
    }
    return isExact(text, value) ? { value } : { value, rounded: true };
  }
  if (jsonType === 'boolean') {
    if (text === 'true' || text === '1') {
      return { value: true };
    }
    if (text === 'false' || text === '0') {
      return { value: false };
    }
    return { error: `${lexical} is no boolean` };
  }
  return { value: lexical };
}

/** Why a value breaks the simple constraints of a schema, or undefined if it meets them. */
export function violation(schema: JsonSchema, value: unknown): string | undefined {
  const type = schema.type;
  if (
    (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) ||
    (type === 'number' && typeof value !== 'number') ||
    (type === 'string' && typeof value !== 'string') ||
    (type === 'boolean' && typeof value !== 'boolean')
  ) {
    return `not a value of type ${type ?? ''}`;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return 'not in the base enumeration';
  }
  if (schema.anyOf && !schema.anyOf.some((member) => violation(member, value) === undefined)) {
    return 'does not satisfy any allowed alternative';
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return `shorter than ${schema.minLength}`;
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return `longer than ${schema.maxLength}`;
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      return `does not match ${schema.pattern}`;
    }
  }
  return typeof value === 'number' ? numericViolation(schema, value) : undefined;
}

export function enumSchema(schema: JsonSchema, values: string[], problems: Problems, at?: At): JsonSchema {
  const json = schema.type;
  const kept: unknown[] = [];
  for (const lexical of values) {
    const converted = lexicalToJson(json, lexical);
    if ('error' in converted) {
      problems.error('invalid-facet', converted.error, at);
      continue;
    }
    const value = converted.value;
    if (converted.rounded) {
      problems.warning('rounded-number', `enumeration value ${lexical} is rounded to ${String(value)}`, at);
    }
    const reason = violation(schema, value);
    if (reason) {
      problems.warning('unreachable-enumeration', `enumeration value ${lexical} is left out: ${reason}`, at);
      continue;
    }
    if (!kept.includes(value)) {
      kept.push(value);
    }
  }
  const out: JsonSchema = {};
  if (json !== undefined) {
    out.type = json;
  }
  if (schema.format !== undefined) {
    out.format = schema.format;
  }
  // JSON Schema has no empty enum; a type without any value accepts nothing.
  if (kept.length > 0) {
    out.enum = kept;
  } else {
    out.not = {};
  }
  return out;
}
