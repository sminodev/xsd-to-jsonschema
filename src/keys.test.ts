import { describe, expect, it } from 'vitest';
import type { JsonSchema } from './json-schema.js';
import { planKeys, renameObject } from './keys.js';

describe('the final property names of an object', () => {
  it('are written in properties, required and every constraint, also under not and in dependentSchemas', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { '{urn:a}x': {}, '{urn:b}x': {}, '@{}y': {}, '{}y': {} },
      required: ['{urn:a}x'],
      dependentRequired: { '@{}y': ['{}y'] },
      oneOf: [{ required: ['{urn:b}x'], properties: { '{}y': false } }],
      not: { properties: { '@{}y': false } },
      dependentSchemas: { '{}y': { required: ['{urn:a}x'], not: { properties: { '{urn:b}x': false } } } },
    };
    renameObject(schema, planKeys(Object.keys(schema.properties ?? {}), 'value'), true);
    expect(Object.keys(schema.properties ?? {})).toEqual(['{urn:a}x', '{urn:b}x', '@y', 'y']);
    expect(schema.dependentRequired).toEqual({ '@y': ['y'] });
    expect(schema.oneOf).toEqual([{ required: ['{urn:b}x'], properties: { y: false } }]);
    expect(schema.not).toEqual({ properties: { '@y': false } });
    expect(schema.dependentSchemas).toEqual({
      y: { required: ['{urn:a}x'], not: { properties: { '{urn:b}x': false } } },
    });
  });
});
