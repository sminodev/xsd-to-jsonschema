// Maps an XML document to JSON with nothing but a schema written by convert(): the property names, the `xml`
// annotations and the JSON types. Anything the schema has no place for is kept under a key the schema rejects
// (`#unknown:...`), so the JSON fails validation wherever the XML has something the schema does not describe.

import { type Attr, DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JsonSchema, XmlAnnotation } from '../json-schema.js';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XS = 'http://www.w3.org/2001/XMLSchema';

// XML white space is space, tab, line feed and carriage return only (XML 1.0, 2.3); `trim()` would also remove U+00A0.
const xmlTrim = (text: string): string => text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
// The lexical forms of numbers (XML Schema Part 2, 3.2.3, 3.2.4, 3.3.13): an integer has digits only, a decimal no
// exponent, a float or double may have one.
const INTEGER = /^[+-]?[0-9]+$/;
const DECIMAL = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/;
const NUMBER = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
const INTEGER_TYPES = new Set([
  'integer',
  'nonPositiveInteger',
  'negativeInteger',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'positiveInteger',
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

// How far the reader looks for a reading of repeated groups that the schema accepts.
const MAX_READINGS = 1024;
// Other readings are only sought among this many children; their copies would take quadratic time beyond.
const MAX_SEARCH_CHILDREN = 500;
const MAX_STEPS = 100_000;

const isElement = (node: Node): node is Element => node.nodeType === 1;

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const escapeAttribute = (text: string) =>
  escapeText(text).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');

// Mixed content as markup with the names as written. Each child element declares the namespaces its names use, so that
// the string can be read on its own. Comments and processing instructions are left out.
function markup(node: Node, declarations: string[]): string {
  if (node.nodeType === 3 || node.nodeType === 4) {
    return escapeText(node.nodeValue ?? '');
  }
  if (!isElement(node)) {
    return '';
  }
  const attributes = [...declarations, ...[...node.attributes].map((a) => `${a.name}="${escapeAttribute(a.value)}"`)];
  const open = `<${node.tagName}${attributes.map((a) => ` ${a}`).join('')}`;
  const children = [...node.childNodes];
  return children.length === 0
    ? `${open}/>`
    : `${open}>${children.map((child) => markup(child, [])).join('')}</${node.tagName}>`;
}

// The declarations the names in an element and its descendants need: the default namespace, then prefixes by use.
function declarationsOf(element: Element): string[] {
  const own = new Set(
    [...element.attributes].filter((a) => a.name === 'xmlns' || a.prefix === 'xmlns').map((a) => a.name),
  );
  let defaultNs: string | undefined;
  const prefixes = new Map<string, string>();
  const visit = (node: Element) => {
    if (node.namespaceURI) {
      if (node.prefix) {
        prefixes.set(node.prefix, node.namespaceURI);
      } else {
        defaultNs = node.namespaceURI;
      }
    }
    for (const a of [...node.attributes]) {
      if (a.prefix && a.prefix !== 'xmlns' && a.prefix !== 'xml' && a.namespaceURI) {
        prefixes.set(a.prefix, a.namespaceURI);
      }
      // The type xsi:type names is a name of the fragment too, right after xsi.
      if (a.namespaceURI === XSI && a.localName === 'type') {
        const value = xmlTrim(a.value);
        const colon = value.indexOf(':');
        const prefix = colon < 0 ? null : value.slice(0, colon);
        const ns = node.lookupNamespaceURI(prefix);
        if (prefix !== null && ns) {
          prefixes.set(prefix, ns);
        } else if (prefix === null && ns) {
          defaultNs ??= ns;
        }
      }
    }
    [...node.childNodes].filter(isElement).forEach(visit);
  };
  visit(element);
  return [
    ...(defaultNs !== undefined && !own.has('xmlns') ? [`xmlns="${escapeAttribute(defaultNs)}"`] : []),
    ...[...prefixes]
      .filter(([prefix]) => !own.has(`xmlns:${prefix}`))
      .map(([prefix, ns]) => `xmlns:${prefix}="${escapeAttribute(ns)}"`),
  ];
}

// Own properties only: an XML name such as __proto__, constructor or toString is an ordinary key.
const own = (object: JsonObject, key: string): Json | undefined =>
  Object.hasOwn(object, key) ? object[key] : undefined;
const put = (object: JsonObject, key: string, value: Json): void => {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
};

// Checks a value against one member of a union, to find the member that takes the text. A member may refer to the
// definitions of the schema, so it is compiled with them.
const memberAjv = new Ajv2020({ strict: false, ownProperties: true, validateSchema: false });
// ajv-formats is CommonJS: the default import is module.exports, which carries the plugin as `default` too.
addFormats.default(memberAjv);
memberAjv.addKeyword('xml');
const memberChecks = new WeakMap<JsonSchema, ValidateFunction>();

function memberAccepts(member: JsonSchema, value: string, defs: Record<string, JsonSchema>): boolean {
  let check = memberChecks.get(member);
  if (check === undefined) {
    check = memberAjv.compile({ ...member, $defs: defs });
    memberChecks.set(member, check);
  }
  return check(value);
}

// Checks the readings of objects: one validator per schema, which holds the whole schema to resolve references.
const ROOT = 'urn:xml-to-json:root';
const readingAjvs = new WeakMap<JsonSchema, Ajv2020>();

function ajvFor(schema: JsonSchema): Ajv2020 {
  let ajv = readingAjvs.get(schema);
  if (ajv === undefined) {
    ajv = new Ajv2020({ strict: false, multipleOfPrecision: 12, ownProperties: true, validateSchema: false });
    addFormats.default(ajv);
    ajv.addKeyword('xml');
    ajv.addSchema({ ...schema, $id: ROOT });
    readingAjvs.set(schema, ajv);
  }
  return ajv;
}

// A part of the schema with its references made absolute, so that it can be compiled on its own.
function absolute(part: unknown): unknown {
  if (Array.isArray(part)) {
    return part.map(absolute);
  }
  if (part === null || typeof part !== 'object') {
    return part;
  }
  return Object.fromEntries(
    Object.entries(part).map(([key, value]) => [
      key,
      key === '$ref' && typeof value === 'string' && value.startsWith('#') ? `${ROOT}${value}` : absolute(value),
    ]),
  );
}

/**
 * Why a document has no JSON form. `xsi-type-simple`, `name-collision` and `reading-limit` (the reader can't tell
 * which reading of repeated groups the document means) are documented limits of the mapping: the XML can be valid.
 * The other causes mean the XML is invalid.
 */
export type MappingCause =
  | 'xsi-type-simple'
  | 'name-collision'
  | 'nil-content'
  | 'unknown-type'
  | 'not-nillable'
  | 'invalid-nil'
  | 'undeclared-prefix'
  | 'reading-limit';

/** The causes that are limits of the mapping rather than mistakes in the XML. */
export const MAPPING_LIMITS: ReadonlySet<MappingCause> = new Set([
  'xsi-type-simple',
  'name-collision',
  'reading-limit',
]);

/** A document, or a part of it, has no JSON form; `code` says why, `path` where. */
export class MappingError extends Error {
  override name = 'MappingError';
  /** why the document has no JSON form */
  readonly code: MappingCause;
  /** the element, as `/root/child`, with `/@name` for an attribute */
  readonly path: string;
  /** for xsi:type: the declared type, if it has a name, and the type xsi:type names, as `{namespace}local` */
  readonly types: { declared?: string; requested?: string };

  // Written without parameter properties, so that Node's type stripping can load this file.
  constructor(
    code: MappingCause,
    message: string,
    path: string,
    types: { declared?: string; requested?: string } = {},
  ) {
    super(`${path}: ${message}`);
    this.code = code;
    this.path = path;
    this.types = types;
  }

  /** whether the cause is a documented limit of the mapping, not a mistake in the XML */
  get limit(): boolean {
    return MAPPING_LIMITS.has(this.code);
  }
}

/** The path of a node from the root: element names as written, an attribute as `@name`. */
function pathOf(node: Node): string {
  const parts: string[] = [];
  let current: Node | null = node;
  if (current.nodeType === 2) {
    parts.push(`@${current.nodeName}`);
    current = (current as Attr).ownerElement;
  }
  for (; current && current.nodeType === 1; current = current.parentNode) {
    parts.unshift(current.nodeName);
  }
  return `/${parts.join('/')}`;
}

export interface XmlToJsonOptions {
  /** the property for text next to attributes in content a wildcard takes; the converter's `textProperty` */
  textProperty?: string;
}

/**
 * Maps an XML document to the JSON the schema describes. Throws when the document has no JSON form: a name that
 * collides in wildcard content, a nil element with content, or xsi:nil on an element that isn't nillable.
 */
export function xmlToJson(schema: JsonSchema, text: string, options: XmlToJsonOptions = {}): Json {
  const textProperty = options.textProperty ?? 'value';
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') {
        throw new Error(message);
      }
    },
  }).parseFromString(text, 'text/xml');
  const defs = schema.$defs ?? {};

  const resolve = (s: JsonSchema | boolean | undefined): JsonSchema => {
    let current = typeof s === 'object' ? s : undefined;
    for (let i = 0; current?.$ref !== undefined && i < 50; i += 1) {
      current =
        current.$ref === '#'
          ? schema
          : defs[current.$ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return current ?? {};
  };

  // The JSON type that decides how text converts. A float or double is an `anyOf` of a number and the strings INF,
  // -INF and NaN, or an `enum` of both: a number, and a string for those three.
  const jsonType = (s: JsonSchema, depth = 0): string => {
    const target = resolve(s);
    if (target.type) {
      return target.type;
    }
    if (target.anyOf && depth < 10) {
      const types = target.anyOf.map((branch) => jsonType(branch, depth + 1));
      if (types.includes('number') || types.includes('integer')) {
        return 'number';
      }
    }
    const values =
      target.enum ?? (target.const !== undefined ? [target.const] : s.const !== undefined ? [s.const] : []);
    return values.length > 0 ? typeof values[0] : 'string';
  };

  // A member of the `xml` annotation of a value: on the property itself or on the definition it refers to.
  const xmlOf = <K extends 'whiteSpace' | 'list' | 'type' | 'anyType' | 'decimal'>(
    s: JsonSchema,
    key: K,
  ): XmlAnnotation[K] | undefined => {
    let current: JsonSchema | undefined = s;
    for (let i = 0; current && i < 50; i += 1) {
      if (current.xml?.[key] !== undefined) {
        return current.xml[key];
      }
      const ref: string | undefined = current.$ref;
      current =
        ref === undefined
          ? undefined
          : ref === '#'
            ? schema
            : defs[ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return undefined;
  };

  // XML Schema Part 2, 4.3.6: replace turns tab, line feed and carriage return into spaces; collapse also joins runs
  // of spaces and drops them at both ends.
  const normalize = (raw: string, whiteSpace: 'replace' | 'collapse' | undefined): string => {
    if (whiteSpace === undefined) {
      return raw;
    }
    const replaced = raw.replace(/[\t\n\r]/g, ' ');
    return whiteSpace === 'collapse' ? xmlTrim(replaced.replace(/ {2,}/g, ' ')) : replaced;
  };

  // A union of string values: the text as the first member that accepts it normalizes it, trying the members in
  // order, each with its own whiteSpace. Undefined if the value is no such union or no member accepts the text.
  const memberText = (raw: string, s: JsonSchema): string | undefined => {
    const target = resolve(s);
    if (!target.anyOf || jsonType(target) !== 'string') {
      return undefined;
    }
    for (const member of target.anyOf) {
      // A member that is a union itself takes the text if one of its members does and its own facets allow it; one
      // of whose members takes it, none does. Its members aren't checked once more.
      const inner = memberText(raw, member);
      if (inner !== undefined) {
        if (memberAccepts(ownFacets(member), inner, defs)) {
          return inner;
        }
        continue;
      }
      if (jsonType(member) === 'string' && resolve(member).anyOf) {
        continue;
      }
      const text = normalize(raw, xmlOf(member, 'whiteSpace'));
      if (memberAccepts(member, text, defs)) {
        return text;
      }
    }
    return undefined;
  };

  // A union member without its own members: what it checks beyond them.
  const facetsOf = new WeakMap<JsonSchema, JsonSchema>();
  const ownFacets = (member: JsonSchema): JsonSchema => {
    let own = facetsOf.get(member);
    if (own === undefined) {
      own = { ...resolve(member) };
      delete own.anyOf;
      delete own.$ref;
      facetsOf.set(member, own);
    }
    return own;
  };

  const value = (text: string, s: JsonSchema): Json => {
    if (xmlOf(s, 'list')) {
      // A list collapses and splits at spaces; each item is a value of the item type.
      const items = resolve(s).items ?? {};
      const collapsed = normalize(text, 'collapse');
      return collapsed === '' ? [] : collapsed.split(' ').map((item) => value(item, items));
    }
    const raw = memberText(text, s) ?? normalize(text, xmlOf(s, 'whiteSpace'));
    const type = jsonType(s);
    const trimmed = xmlTrim(raw);
    if (type === 'integer' || type === 'number') {
      // Numbers collapse their white space; INF, -INF and NaN stay strings. A literal beyond the range of a double
      // is INF or -INF, as XML Schema 1.1 rounds it; JSON has no infinite number.
      if (!numberForm(s, type).test(trimmed)) {
        return trimmed;
      }
      const number = Number(trimmed);
      return Number.isFinite(number) ? number : number > 0 ? 'INF' : '-INF';
    }
    if (type === 'boolean') {
      if (trimmed === 'true' || trimmed === '1') {
        return true;
      }
      if (trimmed === 'false' || trimmed === '0') {
        return false;
      }
    }
    return raw;
  };

  // The lexical form of a number: a decimal (`xml.decimal`, or the built-in type `xml.type` names) has no exponent,
  // an integer type or a JSON integer has digits only, and any other number is a float or double, which may have one.
  const numberForm = (s: JsonSchema, type: string): RegExp => {
    const named = xmlOf(s, 'type');
    const builtin = named?.startsWith(`{${XS}}`) ? named.slice(XS.length + 2) : undefined;
    if (builtin === 'decimal' || xmlOf(s, 'decimal')) {
      return DECIMAL;
    }
    return (builtin !== undefined && INTEGER_TYPES.has(builtin)) || type === 'integer' ? INTEGER : NUMBER;
  };

  // An array of elements, not the items of a list.
  const isRepetition = (prop: JsonSchema): boolean => prop.type === 'array' && !prop.xml?.list;

  const entriesOf = (target: JsonSchema) =>
    Object.entries(target.properties ?? {}).flatMap(([key, p]) => (typeof p === 'object' ? [[key, p] as const] : []));

  // A property's local name is `xml.name` where the key differs from it, as for colliding names.
  const nameOf = (key: string, p: JsonSchema): string => p.xml?.name ?? key;

  const isFor = (key: string, p: JsonSchema, child: Element): boolean =>
    nameOf(key, p) === child.localName &&
    !(p.xml?.attribute || p.xml?.text || p.xml?.group) &&
    (p.xml?.namespace ?? '') === (child.namespaceURI ?? '');

  // Whether a repeated group declares the element, directly or in a repeated group of its own.
  const declares = (target: JsonSchema, child: Element): boolean =>
    entriesOf(target).some(([key, p]) => isFor(key, p, child) || (p.xml?.group && declares(p.items ?? {}, child)));

  // Whether an object can hold all these properties at once, going by what its choices exclude.
  const allows = (s: JsonSchema, keys: string[]): boolean =>
    keys.every((key) => !s.properties || !Object.hasOwn(s.properties, key) || s.properties[key] !== false) &&
    anchorsAllow(s, keys) &&
    (s.allOf ?? []).every((constraint) => allows(constraint, keys)) &&
    (!s.oneOf || s.oneOf.some((branch) => allows(branch, keys))) &&
    (!s.anyOf || s.anyOf.some((branch) => allows(branch, keys)));

  // A choice written with anchors: exactly one branch requires each anchor, and the other properties of a branch
  // need its anchor. Properties of two branches can't be there together.
  const anchorsAllow = (s: JsonSchema, keys: string[]): boolean => {
    const anchors = new Set(
      (s.oneOf ?? []).flatMap((branch) =>
        branch.required?.length === 1 && Object.keys(branch).length === 1 ? branch.required : [],
      ),
    );
    if (anchors.size === 0) {
      return true;
    }
    const own = (key: string) =>
      (s.dependentRequired && Object.hasOwn(s.dependentRequired, key) ? s.dependentRequired[key]?.[0] : undefined) ??
      key;
    return new Set(keys.map(own).filter((anchor) => anchors.has(anchor))).size <= 1;
  };

  // The position of a property in document order. The members of a substitution group and the branches of a choice
  // written with anchors share one particle: each starts at the position of the first.
  const positions = new WeakMap<JsonSchema, Map<string, number>>();
  const positionsOf = (target: JsonSchema): Map<string, number> => {
    let known = positions.get(target);
    if (known !== undefined) {
      return known;
    }
    const order = Object.keys(target.properties ?? {});
    known = new Map(order.map((key, i) => [key, i]));
    for (const constraint of [target, ...(target.allOf ?? [])]) {
      const branches = constraint.oneOf ?? constraint.anyOf;
      const single = (b: JsonSchema) => b.required?.length === 1 && Object.keys(b).length === 1;
      const none = (b: JsonSchema) =>
        Object.keys(b).length === 1 && Object.values(b.properties ?? {}).every((v) => v === false);
      if (!branches?.some(single) || !branches.every((b) => single(b) || none(b))) {
        continue;
      }
      // The first property of each branch; the others of a branch keep their places after it.
      const keys = branches.flatMap((b) => (single(b) ? (b.required ?? []) : [])).filter((key) => known.has(key));
      const first = Math.min(...keys.map((key) => known?.get(key) ?? Infinity));
      for (const key of keys) {
        known.set(key, first);
      }
    }
    positions.set(target, known);
    return known;
  };
  const positionOf = (target: JsonSchema, key: string): number => positionsOf(target).get(key) ?? -1;

  // Whether a property can still come in this occurrence of a repeated group, or has to start the next one.
  const fits = (out: { [key: string]: Json }, target: JsonSchema, key: string): boolean => {
    const position = positionOf(target, key);
    const last = Math.max(-1, ...Object.keys(out).map((other) => positionOf(target, other)));
    const prop = resolve(target.properties?.[key]);
    // A full repeated group can still finish its last occurrence.
    const room =
      isRepetition(prop) &&
      (prop.xml?.group === true || ((own(out, key) as Json[] | undefined)?.length ?? 0) < (prop.maxItems ?? Infinity));
    return (position > last || (position === last && room)) && allows(target, [...Object.keys(out), key]);
  };

  // Whether a repeated group has a wildcard that takes elements, directly or in a repeated group of its own.
  const wildIn = (target: JsonSchema): boolean =>
    target.xml?.anyElement === true || entriesOf(target).some(([, p]) => p.xml?.group && wildIn(p.items ?? {}));

  // The properties that can take a child element, most likely first, and the one that declares it directly.
  const candidatesOf = (out: JsonObject, target: JsonSchema, child: Element, occurrence: boolean) => {
    const last = Math.max(-1, ...Object.keys(out).map((other) => positionOf(target, other)));
    const declared = entriesOf(target).filter(
      ([key, p]) => isFor(key, p, child) || (p.xml?.group && declares(p.items ?? {}, child)),
    );
    const wild = entriesOf(target).filter(
      ([key, p]) => p.xml?.group && wildIn(p.items ?? {}) && !declared.some(([other]) => other === key),
    );
    const candidates = [...declared, ...wild];
    const inOrder = candidates.filter(([key]) => positionOf(target, key) >= last);
    const earlier = candidates.filter(([key]) => positionOf(target, key) < last);
    return {
      candidates: occurrence ? candidates.filter(([name]) => fits(out, target, name)) : [...inOrder, ...earlier],
      direct: declared.find(([, p]) => !p.xml?.group),
    };
  };

  // Whether the wildcard of an occurrence takes the child: one element per occurrence, not under a declared name.
  const occurrenceTakes = (out: JsonObject, target: JsonSchema, child: Element): boolean => {
    const key = wildKey(child);
    return (
      target.xml?.anyElement === true &&
      key !== textProperty &&
      !Object.hasOwn(target.properties ?? {}, key) &&
      Object.keys(out).every((other) => Object.hasOwn(target.properties ?? {}, other))
    );
  };

  // The most likely place of a child element, written into `out`; false if there is none. The same order as
  // `placements`, without copies, so that it takes linear time for many children.
  const placeFirst = (out: JsonObject, target: JsonSchema, child: Element, occurrence: boolean): boolean => {
    const { candidates, direct } = candidatesOf(out, target, child, occurrence);
    for (const [key, p] of candidates) {
      const prop = resolve(p);
      if (p.xml?.group) {
        const items = p.items ?? {};
        const list = (own(out, key) as JsonObject[] | undefined) ?? [];
        const current = list.at(-1);
        if (current && placeFirst(current, items, child, true)) {
          return true;
        }
        const next: JsonObject = {};
        if (list.length < (prop.maxItems ?? Infinity) && placeFirst(next, items, child, true)) {
          list.push(next);
          put(out, key, list);
          return true;
        }
        const joined = current && join(current, items, child);
        if (joined) {
          list[list.length - 1] = joined;
          return true;
        }
      } else if (isRepetition(prop)) {
        const list = (own(out, key) as Json[] | undefined) ?? [];
        list.push(element(child, prop.items ?? {}));
        put(out, key, list);
        return true;
      } else if (!Object.hasOwn(out, key)) {
        put(out, key, element(child, p));
        return true;
      }
    }
    if (occurrence && occurrenceTakes(out, target, child)) {
      put(out, wildKey(child), generic(child));
      return true;
    }
    if (direct && !occurrence && !target.xml?.anyElement) {
      put(out, `#unknown:repeated ${direct[0]}`, true);
      return true;
    }
    return false;
  };

  // The ways to put a child element into the JSON of `target`, most likely first, each as a new object; `out` stays as
  // it is. The schema lists properties in document order: the first one not before what is already there comes
  // first. A repeated group continues its last occurrence before it starts the next one. Inside an occurrence, an
  // element no declared property takes goes to the wildcard of the occurrence, one per occurrence.
  function* placements(
    out: JsonObject,
    target: JsonSchema,
    child: Element,
    occurrence: boolean,
  ): Generator<JsonObject> {
    const { candidates, direct } = candidatesOf(out, target, child, occurrence);
    let found = false;
    for (const [key, p] of candidates) {
      const prop = resolve(p);
      if (p.xml?.group) {
        const items = p.items ?? {};
        const list = (own(out, key) as JsonObject[] | undefined) ?? [];
        const current = list.at(-1);
        if (current) {
          for (const next of placements(current, items, child, true)) {
            found = true;
            yield { ...out, [key]: [...list.slice(0, -1), next] };
          }
        }
        if (list.length < (prop.maxItems ?? Infinity)) {
          for (const next of placements({}, items, child, true)) {
            found = true;
            yield { ...out, [key]: [...list, next] };
          }
        }
        // Last, the wildcard of the last occurrence may take more than one element.
        const joined = current && join(current, items, child);
        if (joined) {
          found = true;
          yield { ...out, [key]: [...list.slice(0, -1), joined] };
        }
      } else if (isRepetition(prop)) {
        found = true;
        yield { ...out, [key]: [...((own(out, key) as Json[] | undefined) ?? []), element(child, prop.items ?? {})] };
      } else if (!Object.hasOwn(out, key)) {
        found = true;
        yield { ...out, [key]: element(child, p) };
      }
    }
    if (occurrence && occurrenceTakes(out, target, child)) {
      found = true;
      yield { ...out, [wildKey(child)]: generic(child) };
    }
    // An element no declared property takes any more goes to a wildcard, if there is one.
    if (!found && direct && !occurrence && !target.xml?.anyElement) {
      yield { ...out, [`#unknown:repeated ${direct[0]}`]: true };
    }
  }

  // The occurrence with one more element its wildcard takes: under the local name, an array for several of one name.
  const join = (out: JsonObject, target: JsonSchema, child: Element): JsonObject | undefined => {
    const key = wildKey(child);
    if (!target.xml?.anyElement || key === textProperty || Object.hasOwn(target.properties ?? {}, key)) {
      return undefined;
    }
    const existing = own(out, key);
    const value = generic(child);
    return {
      ...out,
      [key]: existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value],
    };
  };

  // Checks a reading of an object against its schema. The schema may refer to the definitions and to the root, so it
  // is compiled next to the whole schema, with its references made absolute.
  const readingChecks = new WeakMap<JsonSchema, ValidateFunction>();
  const accepts = (target: JsonSchema, json: JsonObject): boolean => {
    // A schema or JSON nested deeper than Ajv's stack reaches can't be checked here; the first reading stands.
    try {
      let check = readingChecks.get(target);
      if (check === undefined) {
        check = ajvFor(schema).compile(absolute(target) as JsonSchema);
        readingChecks.set(target, check);
      }
      return check(json);
    } catch (e) {
      if (e instanceof RangeError) {
        return true;
      }
      throw e;
    }
  };

  const isControl = (a: Attr): boolean => a.name === 'xmlns' || a.prefix === 'xmlns' || a.namespaceURI === XSI;
  const isTrue = (value: string | null): boolean => value !== null && ['true', '1'].includes(xmlTrim(value));

  // The attributes of an element into `out`: declared ones by the schema, others under their local name as strings
  // if xs:anyAttribute takes them, else as `#unknown`.
  const attributes = (node: Element, target: JsonSchema, out: { [key: string]: Json }): void => {
    const entries = entriesOf(target);
    for (const a of [...node.attributes].filter((attribute) => !isControl(attribute))) {
      const match = entries.find(
        ([key, p]) =>
          nameOf(key, p) === a.localName && p.xml?.attribute && (p.xml.namespace ?? '') === (a.namespaceURI ?? ''),
      );
      if (match) {
        put(out, match[0], value(a.value, match[1]));
      } else if (target.xml?.anyAttribute) {
        claim(out, target, wildKey(a), a);
        put(out, wildKey(a), a.value);
      } else {
        put(out, `#unknown:@${a.name}`, a.value);
      }
    }
  };

  // The key of content a wildcard takes: its local name. The name of the text property is reserved in every object:
  // an element of that name is `{namespace}local`, an attribute `@local`.
  const wildKey = (node: Element | Attr): string => {
    const local = node.localName ?? node.nodeName;
    if (local !== textProperty) {
      return local;
    }
    return node.nodeType === 2 ? `@${local}` : `{${node.namespaceURI ?? ''}}${local}`;
  };

  // A name wildcard content takes may not collide with a declared property, the text property or another name.
  const claim = (out: { [key: string]: Json }, target: JsonSchema, key: string, node: Node): void => {
    if (key === textProperty || Object.hasOwn(target.properties ?? {}, key) || Object.hasOwn(out, key)) {
      throw new MappingError('name-collision', `${key} is already a property of the object`, pathOf(node));
    }
  };

  // The children of wildcard content under their local names: one value, or an array for several of one name.
  const children = (elements: Element[], target: JsonSchema, out: { [key: string]: Json }): void => {
    const groups = new Map<string, Element[]>();
    for (const child of elements) {
      const key = wildKey(child);
      const group = groups.get(key) ?? [];
      if (group[0] && (group[0].namespaceURI ?? '') !== (child.namespaceURI ?? '')) {
        throw new MappingError('name-collision', `${key} comes from two namespaces`, pathOf(child));
      }
      groups.set(key, [...group, child]);
    }
    for (const [key, group] of groups) {
      claim(out, target, key, group[0] as Element);
      const values = group.map(generic);
      put(out, key, values.length === 1 ? (values[0] ?? '') : values);
    }
  };

  // Content a wildcard takes, without a schema: text, or an object with attributes, children and text.
  const generic = (node: Element): Json => {
    const own = [...node.attributes].filter((a) => !isControl(a));
    const elements = [...node.childNodes].filter(isElement);
    const text = [...node.childNodes]
      .filter((child) => child.nodeType === 3 || child.nodeType === 4)
      .map((child) => child.nodeValue ?? '')
      .join('');
    if (own.length === 0 && elements.length === 0) {
      return text;
    }
    const out: { [key: string]: Json } = {};
    const open: JsonSchema = {};
    for (const a of own) {
      claim(out, open, wildKey(a), a);
      put(out, wildKey(a), a.value);
    }
    if (elements.length === 0) {
      // Only attributes: the text property only where there is text.
      if (text !== '') {
        put(out, textProperty, text);
      }
    } else if (xmlTrim(text) !== '') {
      put(
        out,
        textProperty,
        [...node.childNodes].map((child) => markup(child, isElement(child) ? declarationsOf(child) : [])).join(''),
      );
    } else {
      // Whitespace between children is formatting.
      children(elements, open, out);
    }
    return out;
  };

  // A nillable element: null or an object with its attributes and the text property null, if xsi:nil says so.
  const nilled = (node: Element, s: JsonSchema): Json => {
    if ([...node.childNodes].some((child) => isElement(child) || child.nodeType === 3 || child.nodeType === 4)) {
      throw new MappingError('nil-content', 'the element is nil and has content', pathOf(node));
    }
    const written = node.getAttributeNS(XSI, 'type');
    const type = written !== null && written !== '' ? typeName(node, xmlTrim(written)) : undefined;
    if (type === undefined && ![...node.attributes].some((a) => !isControl(a))) {
      return null;
    }
    // The nil form of the type xsi:type names, or one that needs no `#type`.
    const objects = (s.anyOf ?? []).filter((branch) => branch.type === 'object');
    const form = (type === undefined
      ? objects.find((branch) => !branch.required?.includes('#type'))
      : objects.find((branch) => {
          const property = branch.properties?.['#type'];
          return typeof property === 'object' && (property.const === type || property.enum?.includes(type));
        })) ??
      objects[0] ?? { properties: {} };
    const out: { [key: string]: Json } = type === undefined ? {} : { '#type': type };
    attributes(node, form, out);
    const text = entriesOf(form).find(([, p]) => p.xml?.text);
    put(out, text?.[0] ?? textProperty, null);
    return out;
  };

  // The schemas for an element that name its type in `#type`, found through references and `anyOf`.
  const typed = (s: JsonSchema, depth = 0): JsonSchema[] => {
    const target = resolve(s);
    const property = target.properties?.['#type'];
    if (typeof property === 'object' && property.xml?.xsiType) {
      return [s];
    }
    return depth < 3 ? (target.anyOf ?? []).flatMap((branch) => typed(branch, depth + 1)) : [];
  };

  // Whether every reading of a schema requires `#type`: a derived type, or an abstract one.
  const requiresType = (s: JsonSchema): boolean => {
    const target = resolve(s);
    if (s.required?.includes('#type') || target.required?.includes('#type')) {
      return true;
    }
    return !target.properties?.['#type'] && target.anyOf !== undefined && target.anyOf.every(requiresType);
  };

  // The expanded name `{namespace}local` of the type that xsi:type names, resolved where it is written.
  const typeName = (node: Element, qname: string): string => {
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? null : qname.slice(0, colon);
    const ns =
      prefix === null ? node.lookupNamespaceURI('') || node.lookupNamespaceURI(null) : node.lookupNamespaceURI(prefix);
    if (prefix !== null && !ns) {
      throw new MappingError('undeclared-prefix', `the prefix of xsi:type ${qname} is not declared`, pathOf(node));
    }
    return `{${ns ?? ''}}${qname.slice(colon + 1)}`;
  };

  // The schema for the type an element has: the alternative xsi:type names, or the declared type without it.
  const typeOf = (node: Element, s: JsonSchema): { schema: JsonSchema; type?: string } => {
    const alternatives = typed(s);
    const written = node.getAttributeNS(XSI, 'type');
    if (written !== null && written !== '') {
      const type = typeName(node, xmlTrim(written));
      const match = alternatives.find((alternative) => {
        const property = resolve(alternative).properties?.['#type'];
        return typeof property === 'object' && (property.const === type || property.enum?.includes(type));
      });
      if (!match) {
        // A simple type has no object form: xsi:type may only name the declared type, which changes nothing.
        const declared = xmlOf(s, 'type');
        if (alternatives.length === 0 && declared === type) {
          return { schema: s };
        }
        // An element of a simple type has no object form; for a complex type, xsi:type names no type it may select.
        throw alternatives.length === 0
          ? new MappingError('xsi-type-simple', `xsi:type ${written} on an element of a simple type`, pathOf(node), {
              ...(declared === undefined ? {} : { declared }),
              requested: type,
            })
          : new MappingError('unknown-type', `xsi:type ${written} names no type the element may have`, pathOf(node), {
              requested: type,
            });
      }
      return { schema: match, type };
    }
    const target = resolve(s);
    if (alternatives.length > 0 && !target.properties?.['#type'] && target.anyOf) {
      return { schema: target.anyOf.find((branch) => !requiresType(branch)) ?? target.anyOf[0] ?? {} };
    }
    return { schema: s };
  };

  // `nillable`: the declaration is nillable and xsi:nil, if written, is false.
  const element = (node: Element, s: JsonSchema, nillable = false): Json => {
    const written = node.hasAttributeNS(XSI, 'nil') ? node.getAttributeNS(XSI, 'nil') : null;
    if (s.xml?.nillable) {
      if (written !== null && !['true', 'false', '1', '0'].includes(xmlTrim(written))) {
        throw new MappingError('invalid-nil', `xsi:nil="${written}" is no boolean`, pathOf(node));
      }
      return isTrue(written) ? nilled(node, s) : element(node, s.anyOf?.[0] ?? {}, true);
    }
    // Any xsi:nil, also "false", needs a nillable element (XML Schema Part 1, cvc-elt 3.1).
    if (written !== null && !nillable) {
      throw new MappingError('not-nillable', 'xsi:nil on an element that is not nillable', pathOf(node));
    }
    if (xmlOf(s, 'anyType')) {
      return anyContent(node, s);
    }
    const { schema, type } = typeOf(node, s);
    const json = content(node, schema);
    if (type === undefined) {
      return json;
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new MappingError('xsi-type-simple', `the type ${type} has no object form`, pathOf(node), {
        requested: type,
      });
    }
    return { '#type': type, ...json };
  };

  // An element of xs:anyType: its content without a schema, like content a wildcard takes. xsi:type may select a
  // complex type: `#type` and the content as its definition gives it, or without a schema if the schema has none. A
  // simple type has no object form.
  const anyContent = (node: Element, s: JsonSchema): Json => {
    const written = node.getAttributeNS(XSI, 'type');
    if (written === null || written === '' || typeName(node, xmlTrim(written)) === `{${XS}}anyType`) {
      return valueConstraint(node, s)?.value ?? generic(node);
    }
    const type = typeName(node, xmlTrim(written));
    const definitions = Object.values(defs);
    const complex = definitions.find((d) => {
      const property = d.properties?.['#type'];
      return typeof property === 'object' && property.const === type;
    });
    if (complex) {
      const json = content(node, complex);
      if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
        return { '#type': type, ...json };
      }
    }
    if (type.startsWith(`{${XS}}`) || definitions.some((d) => d.xml?.type === type) || complex) {
      throw new MappingError('xsi-type-simple', `xsi:type ${written} on an element of xs:anyType`, pathOf(node), {
        declared: `{${XS}}anyType`,
        requested: type,
      });
    }
    const json = generic(node);
    return json !== null && typeof json === 'object' && !Array.isArray(json)
      ? { '#type': type, ...json }
      : { '#type': type, [textProperty]: json };
  };

  // The fixed or default value of a declaration, which an element without element or character children takes
  // (XML Schema Part 1, cvc-elt 5.1).
  const valueConstraint = (node: Element, s: JsonSchema): { value: Json } | undefined => {
    if ([...node.childNodes].some((child) => isElement(child) || child.nodeType === 3 || child.nodeType === 4)) {
      return undefined;
    }
    if (s.const !== undefined) {
      return { value: s.const as Json };
    }
    return s.default !== undefined ? { value: s.default as Json } : undefined;
  };

  const content = (node: Element, s: JsonSchema): Json => {
    const target = resolve(s);
    if (target.type !== 'object' && !target.properties) {
      const elements = [...node.childNodes].filter(isElement);
      if (elements.length > 0) {
        return { '#unknown:children': elements.length };
      }
      // A simple type has no attributes: one written there has no place.
      const unknown = [...node.attributes].filter((a) => !isControl(a));
      if (unknown.length > 0) {
        const out: JsonObject = {};
        for (const a of unknown) {
          put(out, `#unknown:@${a.name}`, a.value);
        }
        return out;
      }
      return valueConstraint(node, s)?.value ?? value(node.textContent ?? '', s);
    }
    const entries = entriesOf(target);
    const out: { [key: string]: Json } = {};
    attributes(node, target, out);
    const textProp = entries.find(([, p]) => p.xml?.text);
    if (textProp?.[1].xml?.mixed) {
      put(
        out,
        textProp[0],
        [...node.childNodes].map((child) => markup(child, isElement(child) ? declarationsOf(child) : [])).join(''),
      );
      return out;
    }
    let text = '';
    const elements: Element[] = [];
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        text += child.textContent ?? '';
      } else if (isElement(child)) {
        elements.push(child);
      }
    }
    // White space between child elements is formatting; empty content has no room even for that.
    const empty =
      !target.xml?.anyElement && entries.every(([, p]) => p.xml?.attribute === true || p.xml?.xsiType === true);
    if (textProp) {
      put(out, textProp[0], valueConstraint(node, textProp[1])?.value ?? value(text, textProp[1]));
    } else if (xmlTrim(text) !== '' || (empty && text !== '')) {
      put(out, '#unknown:text', xmlTrim(text) === '' ? text : xmlTrim(text));
    }
    // The readings of the children, most likely first. Repeated groups can split the same elements into occurrences
    // in more than one way; the first reading the schema accepts counts, else the first one (XML Schema Part 1,
    // cvc-particle 2: some partition into occurrences within the bounds).
    // A depth-first search with a stack of its own, one level per child: documents can have many children.
    type Reading = [JsonObject, Element[]];
    function* choices(current: JsonObject, others: Element[], child: Element): Generator<Reading> {
      let found = false;
      for (const next of placements(current, target, child, false)) {
        found = true;
        yield [next, others];
      }
      if (!found) {
        yield target.xml?.anyElement
          ? [current, [...others, child]]
          : [{ ...current, [`#unknown:${child.nodeName}`]: true }, others];
      }
    }
    const finish = ([current, others]: Reading): JsonObject => {
      const json = { ...current };
      children(others, target, json);
      return json;
    };
    const first = elements[0];
    if (first === undefined) {
      return finish([out, []]);
    }
    // The most likely reading, in place; most objects have no other.
    const likely: JsonObject = { ...out };
    const unplaced: Element[] = [];
    for (const child of elements) {
      if (!placeFirst(likely, target, child, false)) {
        if (target.xml?.anyElement) {
          unplaced.push(child);
        } else {
          put(likely, `#unknown:${child.nodeName}`, true);
        }
      }
    }
    const reading = finish([likely, unplaced]);
    const grouped = entriesOf(target).some(([, p]) => p.xml?.group);
    if (!grouped || accepts(target, reading)) {
      return reading;
    }
    // Other readings can't be sought among so many children: say so instead of a reading that may be wrong.
    if (elements.length > MAX_SEARCH_CHILDREN) {
      throw new MappingError(
        'reading-limit',
        `the schema rejects the first reading of ${elements.length} children in repeated groups, and other readings are only sought among ${MAX_SEARCH_CHILDREN}`,
        pathOf(node),
      );
    }
    const stack: Iterator<Reading>[] = [choices(out, [], first)];
    let firstReading: JsonObject | undefined;
    let tried = 0;
    // The first reading takes one step per child; the limit counts what the search tries beyond.
    for (let steps = 0; stack.length > 0 && steps < elements.length + MAX_STEPS; steps += 1) {
      const next = stack[stack.length - 1]?.next();
      if (!next || next.done) {
        stack.pop();
        continue;
      }
      const child = elements[stack.length];
      if (child !== undefined) {
        stack.push(choices(next.value[0], next.value[1], child));
        continue;
      }
      const reading = finish(next.value);
      firstReading ??= reading;
      if (!grouped || accepts(target, reading)) {
        return reading;
      }
      if ((tried += 1) >= MAX_READINGS) {
        break;
      }
    }
    // Every reading tried: the schema accepts none, the document is invalid. Otherwise the search gave up.
    if (stack.length > 0) {
      throw new MappingError(
        'reading-limit',
        'the schema rejects every reading of the repeated groups the search could try within its limits',
        pathOf(node),
      );
    }
    return firstReading ?? reading;
  };

  const root = doc.documentElement;
  if (!root) {
    return { '#unknown:root': null };
  }
  const xml = schema.xml ?? {};
  if (root.localName !== xml.name || (root.namespaceURI ?? '') !== (xml.namespace ?? '')) {
    return { '#unknown:root': root.nodeName };
  }
  return element(root, schema);
}
