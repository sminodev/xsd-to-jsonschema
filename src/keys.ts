// The property names of an object. While an object is written, an element is known as `{namespace}local` and an
// attribute as `@{namespace}local`, so that names from different namespaces stay apart. Once the whole object is
// known, each gets its final name, planned from all its properties, never from a document:
//
// - an element keeps its local name, unless elements of that local name come from more than one namespace, or it
//   has the name of the text property; then all of them keep `{namespace}local`;
// - an attribute keeps its local name, unless attributes of that local name come from more than one namespace
//   (then `@{namespace}local`), or an element or the text property has that name (then `@local`).
//
// The name of the text property is reserved in every object, whether it has text or not.

import type { JsonSchema } from './json-schema.js';

/** The name of an element while its object is written. */
export const elementKey = (ns: string, local: string): string => `{${ns}}${local}`;

/** The name of an attribute while its object is written. */
export const attributeKey = (ns: string, local: string): string => `@{${ns}}${local}`;

interface Name {
  attribute: boolean;
  ns: string;
  local: string;
}

function parse(key: string): Name | undefined {
  const attribute = key.startsWith('@{');
  if (!attribute && !key.startsWith('{')) {
    return undefined;
  }
  const end = key.indexOf('}');
  return { attribute, ns: key.slice(attribute ? 2 : 1, end), local: key.slice(end + 1) };
}

/** The local name of an element or attribute key; the key itself for any other property. */
export const localName = (key: string): string => parse(key)?.local ?? key;

/** The final name of each property of an object. */
export function planKeys(keys: string[], textProperty: string): Map<string, string> {
  const names = new Map(keys.map((key) => [key, parse(key)]));
  // The namespaces of each local name, elements and attributes apart, gathered once: linear in the number of keys.
  const byLocal = new Map<string, Set<string>>();
  const group = (attribute: boolean, local: string): string => `${attribute ? '@' : ''}${local}`;
  for (const name of names.values()) {
    if (name) {
      const key = group(name.attribute, name.local);
      const found = byLocal.get(key);
      if (found) {
        found.add(name.ns);
      } else {
        byLocal.set(key, new Set([name.ns]));
      }
    }
  }
  const namespaces = (attribute: boolean, local: string): Set<string> =>
    byLocal.get(group(attribute, local)) ?? new Set();
  const plan = new Map<string, string>();
  for (const [key, name] of names) {
    if (!name) {
      plan.set(key, key);
    } else if (!name.attribute) {
      plan.set(key, namespaces(false, name.local).size > 1 || name.local === textProperty ? key : name.local);
    } else if (namespaces(true, name.local).size > 1) {
      plan.set(key, key);
    } else {
      const taken = namespaces(false, name.local).size > 0 || name.local === textProperty;
      plan.set(key, taken ? `@${name.local}` : name.local);
    }
  }
  return plan;
}

/**
 * Gives the properties of an object schema their final names: in `properties`, `required`, `dependentRequired` and
 * the constraints of its choices. A property whose name isn't its local name records that in `xml.name`.
 *
 * @returns the names that two properties would share, which are kept by the first one
 */
export function renameObject(
  schema: JsonSchema,
  plan: Map<string, string>,
  xml: boolean,
  moved?: (from: object, to: object) => void,
): string[] {
  const clashes: string[] = [];
  if (schema.properties) {
    const properties: Record<string, JsonSchema | boolean> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const name = plan.get(key) ?? key;
      if (Object.hasOwn(properties, name)) {
        clashes.push(name);
        continue;
      }
      const local = localName(key);
      const property =
        xml && name !== local && typeof value === 'object' ? { ...value, xml: { name: local, ...value.xml } } : value;
      // defineProperty: a name such as __proto__ is an own property, not the prototype.
      Object.defineProperty(properties, name, {
        value: property,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    schema.properties = properties;
    // Ajv leaves a property named __proto__ out of `properties` and would count it as additional: such an object is
    // closed by the names of its properties instead.
    if (Object.hasOwn(properties, '__proto__') && schema.additionalProperties === false) {
      delete schema.additionalProperties;
      schema.propertyNames = { enum: Object.keys(properties) };
    }
  }
  renameConstraints(schema, plan, moved);
  return clashes;
}

/**
 * The output entries of a schema, which `maxOutputEntries` limits: one for each key of a `properties` map and one for
 * each branch of an `anyOf` or `oneOf`, in the schema and the schemas inside it, each time it is written. An `allOf`
 * is followed without counting its parts; a `$ref` is not followed, and `$defs` count where they are written.
 */
export function outputEntries(schema: JsonSchema | boolean | undefined): number {
  if (typeof schema !== 'object') {
    return 0;
  }
  let entries = 0;
  for (const value of Object.values(schema.properties ?? {})) {
    entries += 1 + outputEntries(value);
  }
  for (const part of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    entries += 1 + outputEntries(part);
  }
  for (const part of [
    ...(schema.allOf ?? []),
    ...(schema.prefixItems ?? []),
    schema.items,
    schema.not,
    schema.additionalProperties,
    schema.propertyNames,
    ...Object.values(schema.dependentSchemas ?? {}),
    ...Object.values(schema.$defs ?? {}),
  ]) {
    entries += outputEntries(part);
  }
  return entries;
}

/** The schemas inside the constraints of an object: its choice branches, what they rule out and bring along. */
function constraintParts(schema: JsonSchema): JsonSchema[] {
  return [
    ...(schema.oneOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
    ...(schema.not ? [schema.not] : []),
    ...Object.values(schema.dependentSchemas ?? {}),
  ];
}

function renameConstraints(
  schema: JsonSchema,
  plan: Map<string, string>,
  moved?: (from: object, to: object) => void,
): void {
  const rename = (key: string) => plan.get(key) ?? key;
  if (schema.required) {
    schema.required = [...new Set(schema.required.map(rename))];
  }
  if (schema.dependentRequired) {
    schema.dependentRequired = Object.fromEntries(
      Object.entries(schema.dependentRequired).map(([key, keys]) => [rename(key), keys.map(rename)]),
    );
  }
  if (schema.dependentSchemas) {
    schema.dependentSchemas = Object.fromEntries(
      Object.entries(schema.dependentSchemas).map(([key, dependent]) => [rename(key), dependent]),
    );
  }
  // The constraints of choices: their branches, what they rule out, and what a property brings along.
  for (const part of constraintParts(schema)) {
    if (part.properties) {
      const from = part.properties;
      part.properties = Object.fromEntries(Object.entries(from).map(([key, v]) => [rename(key), v]));
      moved?.(from, part.properties);
    }
    renameConstraints(part, plan, moved);
  }
}
