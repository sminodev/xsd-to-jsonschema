// Maps an XML document to JSON with nothing but a schema written by convert(): the property names, the `xml`
// annotations and the JSON types. Anything the schema has no place for is kept under a key the schema rejects
// (`#unknown:...`), so the JSON fails validation wherever the XML has something the schema does not describe.

import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import type { JsonSchema } from '../json-schema.js';

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

export function xmlToJson(schema: JsonSchema, text: string): Json {
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

  const value = (raw: string, s: JsonSchema): Json => {
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
      prop.type === 'array' &&
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
      } else if (prop.type === 'array') {
        const list = (out[key] ??= []) as Json[];
        list.push(element(child, prop.items ?? {}));
        return true;
      } else if (out[key] === undefined) {
        out[key] = element(child, p);
        return true;
      }
    }
    const direct = candidates.find(([, p]) => !p.xml?.group);
    if (direct && !occurrence) {
      out[`#unknown:repeated ${direct[0]}`] = true;
      return true;
    }
    return false;
  };

  const element = (node: Element, s: JsonSchema): Json => {
    const target = resolve(s);
    if (target.type !== 'object' && !target.properties) {
      const children = [...node.childNodes].filter(isElement);
      return children.length > 0 ? { '#unknown:children': children.length } : value(node.textContent ?? '', s);
    }
    const entries = entriesOf(target);
    const out: { [key: string]: Json } = {};
    for (const a of [...node.attributes]) {
      if (a.name === 'xmlns' || a.prefix === 'xmlns' || a.namespaceURI === XSI) {
        continue;
      }
      const match = entries.find(
        ([key, p]) => key === a.localName && p.xml?.attribute && (p.xml.namespace ?? '') === (a.namespaceURI ?? ''),
      );
      if (match) {
        out[match[0]] = value(a.value, match[1]);
      } else {
        out[`#unknown:@${a.name}`] = a.value;
      }
    }
    const textProp = entries.find(([, p]) => p.xml?.text);
    if (textProp?.[1].xml?.mixed) {
      out[textProp[0]] = [...node.childNodes]
        .map((child) => markup(child, isElement(child) ? declarationsOf(child) : []))
        .join('');
      return out;
    }
    let text = '';
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        text += child.textContent ?? '';
        continue;
      }
      if (isElement(child) && !place(out, target, child, false)) {
        out[`#unknown:${child.nodeName}`] = true;
      }
    }
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
