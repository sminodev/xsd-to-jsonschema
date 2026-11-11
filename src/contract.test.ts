// The JSON contract shared with xsd-faker: each case in test-support/contract has a schema.xsd and documents.
//
// - valid*.xml is valid; the oracle maps it to exactly valid*.json, and the generated schema accepts that.
// - invalid-*.xml is invalid; the schema rejects the oracle's JSON, or the oracle reports an error.
// - mapping-error-*.xml is valid XML the JSON form can't hold; the oracle reports an error.
//
// libxml2 confirms the XML verdict of every document.

import { readdirSync, readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';
import { convert } from './convert.js';
import { ajvFor } from './test-support/oracle.js';
import { xmlToJson } from './test-support/xml-to-json.js';

const DIR = new URL('./test-support/contract/', import.meta.url);
/** The cases the converter supports. */
const CASES = ['lists', 'nil', 'wildcard', 'polymorphism', 'union-whitespace'];

const read = (name: string, file: string) => readFileSync(new URL(`${name}/${file}`, DIR), 'utf8');

async function libxml2Accepts(xsd: string, xml: string): Promise<boolean> {
  const result = await validateXML({
    xml: [{ fileName: 'doc.xml', contents: xml }],
    schema: [{ fileName: 'schema.xsd', contents: xsd }],
  });
  if (/failed to compile|Schemas parser error/.test(result.rawOutput)) {
    throw new Error(`the XML Schema does not compile: ${result.rawOutput}`);
  }
  return result.valid;
}

describe.each(CASES)('the JSON contract case %s', (name) => {
  const xsd = read(name, 'schema.xsd');
  const documents = readdirSync(new URL(`${name}/`, DIR)).filter((file) => file.endsWith('.xml'));
  const schemaFor = (xml: string) => {
    const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement?.localName ?? undefined;
    const { schema, problems } = convert({ files: { 'schema.xsd': xsd }, entry: 'schema.xsd', root });
    expect(schema, JSON.stringify(problems)).toBeDefined();
    return schema ?? {};
  };

  it.each(documents.filter((file) => file.startsWith('valid')))('maps %s to its JSON', async (file) => {
    const xml = read(name, file);
    expect(await libxml2Accepts(xsd, xml)).toBe(true);
    const schema = schemaFor(xml);
    const value = xmlToJson(schema, xml);
    expect(value).toEqual(JSON.parse(read(name, file.replace(/\.xml$/, '.json'))));
    const validate = ajvFor(schema);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(documents.filter((file) => file.startsWith('invalid-')))('rejects %s', async (file) => {
    const xml = read(name, file);
    expect(await libxml2Accepts(xsd, xml)).toBe(false);
    const schema = schemaFor(xml);
    let value: unknown;
    try {
      value = xmlToJson(schema, xml);
    } catch {
      return;
    }
    expect(ajvFor(schema)(value), JSON.stringify(value)).toBe(false);
  });

  it.each(documents.filter((file) => file.startsWith('mapping-error-')))(
    'reports a mapping error for %s',
    async (file) => {
      const xml = read(name, file);
      expect(await libxml2Accepts(xsd, xml)).toBe(true);
      expect(() => xmlToJson(schemaFor(xml), xml)).toThrow();
    },
  );
});
