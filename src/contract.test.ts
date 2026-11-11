// The JSON contract: each case in test-support/contract has a schema.xsd and documents.
//
// - valid*.xml is valid; the oracle maps it to exactly valid*.json, and the generated schema accepts that.
// - invalid-*.xml is invalid; the schema rejects the oracle's JSON, or the oracle reports an error.
// - mapping-error-*.xml is valid XML the JSON form can't hold; the oracle reports an error.
//
// libxml2 confirms the XML verdict of every document.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';
import { convert } from './convert.js';
import { ajvFor } from './test-support/oracle.js';
import { MappingError, xmlToJson } from './test-support/xml-to-json.js';

const DIR = new URL('./test-support/contract/', import.meta.url);
/** The cases the converter supports. */
const CASES = [
  'lists',
  'nil',
  'wildcard',
  'polymorphism',
  'union-whitespace',
  'collisions',
  'special-floats',
  'anytype',
  'redefine',
  'xml-whitespace',
  'mixed',
  'substitution-reading',
];
/** Documents libxml2 judges against XML Schema 1.0, as the case's README says; the contract follows the standard. */
const LIBXML2_WRONG = new Set(['special-floats/invalid-nan-below-bound.xml']);

const read = (name: string, file: string) => readFileSync(new URL(`${name}/${file}`, DIR), 'utf8');

/** All schema documents of a case, schema.xsd being the entry. */
const schemas = (name: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(new URL(`${name}/`, DIR))
      .filter((file) => file.endsWith('.xsd'))
      .map((file) => [file, read(name, file)]),
  );

async function libxml2Accepts(files: Record<string, string>, xml: string): Promise<boolean> {
  const result = await validateXML({
    xml: [{ fileName: 'doc.xml', contents: xml }],
    schema: [{ fileName: 'schema.xsd', contents: files['schema.xsd'] ?? '' }],
    preload: Object.entries(files)
      .filter(([file]) => file !== 'schema.xsd')
      .map(([fileName, contents]) => ({ fileName, contents })),
  });
  if (/failed to compile|Schemas parser error/.test(result.rawOutput)) {
    throw new Error(`the XML Schema does not compile: ${result.rawOutput}`);
  }
  return result.valid;
}

describe('the oracle', () => {
  it('loads with the type stripping of Node', () => {
    const file = fileURLToPath(new URL('./test-support/xml-to-json.ts', import.meta.url));
    const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(typeof m.xmlToJson);`;
    expect(
      execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('function');
  });

  it('says why a document has no JSON form: the cause, the path and, for xsi:type, the types', () => {
    const xsd = schemas('polymorphism');
    const xml = read('polymorphism', 'mapping-error-xsitype-simple-type.xml');
    const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement?.localName ?? undefined;
    const { schema } = convert({ files: xsd, entry: 'schema.xsd', root });
    let error: unknown;
    try {
      xmlToJson(schema ?? {}, xml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MappingError);
    const mapping = error as MappingError;
    expect(mapping.code).toBe('xsi-type-simple');
    expect(mapping.limit).toBe(true);
    expect(mapping.path).toMatch(/^\/[^/]+\/[^/]+$/);
    expect(mapping.types.requested).toMatch(/^\{.*\}.+$/);
  });
});

describe.each(CASES)('the JSON contract case %s', (name) => {
  const xsd = schemas(name);
  const documents = readdirSync(new URL(`${name}/`, DIR)).filter((file) => file.endsWith('.xml'));
  const schemaFor = (xml: string) => {
    const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement?.localName ?? undefined;
    const { schema, problems } = convert({ files: xsd, entry: 'schema.xsd', root });
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
    expect(await libxml2Accepts(xsd, xml)).toBe(LIBXML2_WRONG.has(`${name}/${file}`));
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
