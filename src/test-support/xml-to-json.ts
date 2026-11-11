// Maps an XML document to JSON with nothing but a schema written by convert(): the property names, the `xml`
// annotations and the JSON types. Anything the schema has no place for is kept under a key the schema rejects
// (`#unknown:...`), so the JSON fails validation wherever the XML has something the schema does not describe.

import { type Attr, DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JsonSchema, XmlAnnotation } from '../json-schema.js';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const NUMBER = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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

// Checks a value against one member of a union, to find the member that takes the text. A member may refer to the
// definitions of the schema, so it is compiled with them.
const memberAjv = new Ajv2020({ strict: false });
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

  const jsonType = (s: JsonSchema): string => {
    const target = resolve(s);
    if (target.type) {
      return target.type;
    }
    const values =
      target.enum ?? (target.const !== undefined ? [target.const] : s.const !== undefined ? [s.const] : []);
    return values.length > 0 ? typeof values[0] : 'string';
  };

  // A member of the `xml` annotation of a value: on the property itself or on the definition it refers to.
  const xmlOf = <K extends 'whiteSpace' | 'list' | 'type'>(s: JsonSchema, key: K): XmlAnnotation[K] | undefined => {
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
    return whiteSpace === 'collapse' ? replaced.replace(/ {2,}/g, ' ').trim() : replaced;
  };

  // A union of string values: the text as the first member that accepts it normalizes it, trying the members in
  // order, each with its own whiteSpace. Undefined if the value is no such union or no member accepts the text.
  const memberText = (raw: string, s: JsonSchema): string | undefined => {
    const target = resolve(s);
    if (!target.anyOf || jsonType(target) !== 'string') {
      return undefined;
    }
    for (const member of target.anyOf) {
      const text = memberText(raw, member) ?? normalize(raw, member.xml?.whiteSpace);
      if (memberAccepts(member, text, defs)) {
        return text;
      }
    }
    return undefined;
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
    const trimmed = raw.trim();
    if ((type === 'integer' || type === 'number') && NUMBER.test(trimmed)) {
      return Number(trimmed);
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

  // An array of elements, not the items of a list.
  const isRepetition = (prop: JsonSchema): boolean => prop.type === 'array' && !prop.xml?.list;

  const entriesOf = (target: JsonSchema) =>
    Object.entries(target.properties ?? {}).flatMap(([key, p]) => (typeof p === 'object' ? [[key, p] as const] : []));

  const isFor = (key: string, p: JsonSchema, child: Element): boolean =>
    key === child.localName &&
    !(p.xml?.attribute || p.xml?.text || p.xml?.group) &&
    (p.xml?.namespace ?? '') === (child.namespaceURI ?? '');

  // Whether a repeated group declares the element, directly or in a repeated group of its own.
  const declares = (target: JsonSchema, child: Element): boolean =>
    entriesOf(target).some(([key, p]) => isFor(key, p, child) || (p.xml?.group && declares(p.items ?? {}, child)));

  // Whether an object can hold all these properties at once, going by what its choices exclude.
  const allows = (s: JsonSchema, keys: string[]): boolean =>
    keys.every((key) => s.properties?.[key] !== false) &&
    (s.allOf ?? []).every((constraint) => allows(constraint, keys)) &&
    (!s.oneOf || s.oneOf.some((branch) => allows(branch, keys))) &&
    (!s.anyOf || s.anyOf.some((branch) => allows(branch, keys)));

  // Whether a property can still come in this occurrence of a repeated group, or has to start the next one.
  const fits = (out: { [key: string]: Json }, target: JsonSchema, key: string): boolean => {
    const order = Object.keys(target.properties ?? {});
    const position = order.indexOf(key);
    const last = Math.max(-1, ...Object.keys(out).map((other) => order.indexOf(other)));
    const prop = resolve(target.properties?.[key]);
    // A full repeated group can still finish its last occurrence.
    const room =
      isRepetition(prop) &&
      (prop.xml?.group === true || ((out[key] as Json[] | undefined)?.length ?? 0) < (prop.maxItems ?? Infinity));
    return (position > last || (position === last && room)) && allows(target, [...Object.keys(out), key]);
  };

  // Puts a child element into the JSON of `target`, and says if it found a place for it. The schema lists properties
  // in document order: when several can hold the element, the first one not before what is already there takes it.
  const place = (out: { [key: string]: Json }, target: JsonSchema, child: Element, occurrence: boolean): boolean => {
    const order = Object.keys(target.properties ?? {});
    const last = Math.max(-1, ...Object.keys(out).map((other) => order.indexOf(other)));
    const candidates = entriesOf(target).filter(
      ([key, p]) => isFor(key, p, child) || (p.xml?.group && declares(p.items ?? {}, child)),
    );
    const inOrder = candidates.filter(([key]) => order.indexOf(key) >= last);
    const earlier = candidates.filter(([key]) => order.indexOf(key) < last);
    for (const [key, p] of occurrence
      ? candidates.filter(([name]) => fits(out, target, name))
      : [...inOrder, ...earlier]) {
      const prop = resolve(p);
      if (p.xml?.group) {
        const items = p.items ?? {};
        const list = out[key] as { [key: string]: Json }[] | undefined;
        const current = list?.at(-1);
        if (current && place(current, items, child, true)) {
          return true;
        }
        const next: { [key: string]: Json } = {};
        if ((list?.length ?? 0) < (prop.maxItems ?? Infinity) && place(next, items, child, true)) {
          out[key] = [...(list ?? []), next];
          return true;
        }
      } else if (isRepetition(prop)) {
        const list = (out[key] ??= []) as Json[];
        list.push(element(child, prop.items ?? {}));
        return true;
      } else if (out[key] === undefined) {
        out[key] = element(child, p);
        return true;
      }
    }
    // An element no declared property takes any more goes to a wildcard, if there is one.
    const direct = candidates.find(([, p]) => !p.xml?.group);
    if (direct && !occurrence && !target.xml?.anyElement) {
      out[`#unknown:repeated ${direct[0]}`] = true;
      return true;
    }
    return false;
  };

  const isControl = (a: Attr): boolean => a.name === 'xmlns' || a.prefix === 'xmlns' || a.namespaceURI === XSI;
  const isTrue = (value: string | null): boolean => value !== null && ['true', '1'].includes(value.trim());

  // The attributes of an element into `out`: declared ones by the schema, others under their local name as strings
  // if xs:anyAttribute takes them, else as `#unknown`.
  const attributes = (node: Element, target: JsonSchema, out: { [key: string]: Json }): void => {
    const entries = entriesOf(target);
    for (const a of [...node.attributes].filter((attribute) => !isControl(attribute))) {
      const match = entries.find(
        ([key, p]) => key === a.localName && p.xml?.attribute && (p.xml.namespace ?? '') === (a.namespaceURI ?? ''),
      );
      if (match) {
        out[match[0]] = value(a.value, match[1]);
      } else if (target.xml?.anyAttribute) {
        claim(out, target, a.localName ?? a.name, `attribute ${a.name}`);
        out[a.localName ?? a.name] = a.value;
      } else {
        out[`#unknown:@${a.name}`] = a.value;
      }
    }
  };

  // A name wildcard content takes may not collide with a declared property, the text property or another name.
  const claim = (out: { [key: string]: Json }, target: JsonSchema, key: string, what: string): void => {
    if (key === textProperty || Object.hasOwn(target.properties ?? {}, key) || Object.hasOwn(out, key)) {
      throw new Error(`${what} has no JSON form: ${key} is already a property of the object`);
    }
  };

  // The children of wildcard content under their local names: one value, or an array for several of one name.
  const children = (elements: Element[], target: JsonSchema, out: { [key: string]: Json }): void => {
    const groups = new Map<string, Element[]>();
    for (const child of elements) {
      const key = child.localName ?? child.nodeName;
      const group = groups.get(key) ?? [];
      if (group[0] && (group[0].namespaceURI ?? '') !== (child.namespaceURI ?? '')) {
        throw new Error(`element ${child.nodeName} has no JSON form: ${key} comes from two namespaces`);
      }
      groups.set(key, [...group, child]);
    }
    for (const [key, group] of groups) {
      claim(out, target, key, `element ${group[0]?.nodeName ?? key}`);
      const values = group.map(generic);
      out[key] = values.length === 1 ? (values[0] ?? '') : values;
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
      claim(out, open, a.localName ?? a.name, `attribute ${a.name}`);
      out[a.localName ?? a.name] = a.value;
    }
    if (elements.length === 0) {
      out[textProperty] = text;
    } else if (text.trim() !== '') {
      out[textProperty] = [...node.childNodes]
        .map((child) => markup(child, isElement(child) ? declarationsOf(child) : []))
        .join('');
    } else {
      // Whitespace between children is formatting.
      children(elements, open, out);
    }
    return out;
  };

  // A nillable element: null or an object with its attributes and the text property null, if xsi:nil says so.
  const nilled = (node: Element, s: JsonSchema): Json => {
    if ([...node.childNodes].some((child) => isElement(child) || child.nodeType === 3 || child.nodeType === 4)) {
      throw new Error(`${node.nodeName} is nil and has content`);
    }
    const written = node.getAttributeNS(XSI, 'type');
    const type = written !== null && written !== '' ? typeName(node, written.trim()) : undefined;
    if (type === undefined && ![...node.attributes].some((a) => !isControl(a))) {
      return null;
    }
    const form = (s.anyOf ?? []).find((branch) => branch.type === 'object') ?? { properties: {} };
    const out: { [key: string]: Json } = type === undefined ? {} : { '#type': type };
    attributes(node, form, out);
    const text = entriesOf(form).find(([, p]) => p.xml?.text);
    out[text?.[0] ?? textProperty] = null;
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
      throw new Error(`the prefix of xsi:type ${qname} is not declared`);
    }
    return `{${ns ?? ''}}${qname.slice(colon + 1)}`;
  };

  // The schema for the type an element has: the alternative xsi:type names, or the declared type without it.
  const typeOf = (node: Element, s: JsonSchema): { schema: JsonSchema; type?: string } => {
    const alternatives = typed(s);
    const written = node.getAttributeNS(XSI, 'type');
    if (written !== null && written !== '') {
      const type = typeName(node, written.trim());
      const match = alternatives.find((alternative) => {
        const property = resolve(alternative).properties?.['#type'];
        return typeof property === 'object' && (property.const === type || property.enum?.includes(type));
      });
      if (!match) {
        // A simple type has no object form: xsi:type may only name the declared type, which changes nothing.
        if (alternatives.length === 0 && xmlOf(s, 'type') === type) {
          return { schema: s };
        }
        throw new Error(`${node.nodeName}: xsi:type ${written} has no JSON form here`);
      }
      return { schema: match, type };
    }
    const target = resolve(s);
    if (alternatives.length > 0 && !target.properties?.['#type'] && target.anyOf) {
      return { schema: target.anyOf.find((branch) => !requiresType(branch)) ?? target.anyOf[0] ?? {} };
    }
    return { schema: s };
  };

  const element = (node: Element, s: JsonSchema): Json => {
    const nil = isTrue(node.getAttributeNS(XSI, 'nil'));
    if (s.xml?.nillable) {
      return nil ? nilled(node, s) : element(node, s.anyOf?.[0] ?? {});
    }
    if (nil) {
      throw new Error(`${node.nodeName} has xsi:nil but is not nillable`);
    }
    const { schema, type } = typeOf(node, s);
    const json = content(node, schema);
    if (type === undefined) {
      return json;
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error(`${node.nodeName}: the type ${type} has no object form`);
    }
    return { '#type': type, ...json };
  };

  const content = (node: Element, s: JsonSchema): Json => {
    const target = resolve(s);
    if (target.type !== 'object' && !target.properties) {
      const elements = [...node.childNodes].filter(isElement);
      return elements.length > 0 ? { '#unknown:children': elements.length } : value(node.textContent ?? '', s);
    }
    const entries = entriesOf(target);
    const out: { [key: string]: Json } = {};
    attributes(node, target, out);
    const textProp = entries.find(([, p]) => p.xml?.text);
    if (textProp?.[1].xml?.mixed) {
      out[textProp[0]] = [...node.childNodes]
        .map((child) => markup(child, isElement(child) ? declarationsOf(child) : []))
        .join('');
      return out;
    }
    let text = '';
    const others: Element[] = [];
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        text += child.textContent ?? '';
        continue;
      }
      if (isElement(child) && !place(out, target, child, false)) {
        if (target.xml?.anyElement) {
          others.push(child);
        } else {
          out[`#unknown:${child.nodeName}`] = true;
        }
      }
    }
    children(others, target, out);
    if (textProp) {
      out[textProp[0]] = value(text, textProp[1]);
    } else if (text.trim() !== '') {
      out['#unknown:text'] = text.trim();
    }
    return out;
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
