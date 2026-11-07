// Maps an XML document to JSON with nothing but a schema written by convert(): the property names, the `xml`
// annotations and the JSON types. Anything the schema has no place for is kept under a key the schema rejects
// (`#unknown:...`), so the JSON fails validation wherever the XML has something the schema does not describe.

import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import type { JsonSchema } from '../json-schema.js';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const NUMBER = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isElement = (node: Node): node is Element => node.nodeType === 1;

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

  const element = (node: Element, s: JsonSchema): Json => {
    const target = resolve(s);
    if (target.type !== 'object' && !target.properties) {
      const children = [...node.childNodes].filter(isElement);
      return children.length > 0 ? { '#unknown:children': children.length } : value(node.textContent ?? '', s);
    }
    const entries = Object.entries(target.properties ?? {}).flatMap(([key, p]) =>
      typeof p === 'object' ? [[key, p] as const] : [],
    );
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
    let text = '';
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        text += child.textContent ?? '';
        continue;
      }
      if (!isElement(child)) {
        continue;
      }
      const match = entries.find(
        ([key, p]) =>
          key === child.localName &&
          !(p.xml?.attribute || p.xml?.text) &&
          (p.xml?.namespace ?? '') === (child.namespaceURI ?? ''),
      );
      if (!match) {
        out[`#unknown:${child.nodeName}`] = true;
        continue;
      }
      const [key, p] = match;
      const prop = resolve(p);
      if (prop.type === 'array') {
        const list = (out[key] ??= []) as Json[];
        list.push(element(child, prop.items ?? {}));
      } else if (out[key] !== undefined) {
        out[`#unknown:repeated ${key}`] = true;
      } else {
        out[key] = element(child, p);
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
