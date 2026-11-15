import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeSchema, EncodingError } from './encoding.js';
import { convertFile } from './node.js';
import { ajvFor } from './test-support/oracle.js';
import { xmlToJson } from './test-support/xml-to-json.js';

// The encoding cases: each schema enumerates one name for the root element Name.
const CASES = join(dirname(fileURLToPath(import.meta.url)), 'test-support', 'encoding');
const files = readdirSync(CASES).filter((file) => file.endsWith('.xsd'));

describe('the encoding of schema files', () => {
  it.each([
    ['latin1.xsd', 'Müller'],
    ['utf16-bom.xsd', 'Müller'],
    ['utf16be-bom.xsd', 'Müller'],
    ['utf8-without-declaration.xsd', 'Müller'],
    ['latin1-c1-range.xsd', 'M\u0080ller'],
  ])('reads %s with the characters its encoding gives', (file, name) => {
    const { schema, problems } = convertFile(join(CASES, file));
    expect(problems).toEqual([]);
    expect(JSON.stringify(schema)).toContain(JSON.stringify(name).slice(1, -1));
    expect(JSON.stringify(schema)).not.toContain('�');
    if (name === 'Müller') {
      const sample = readFileSync(join(CASES, 'sample-utf8.xml'), 'utf8');
      expect(ajvFor(schema ?? {})(xmlToJson(schema ?? {}, sample))).toBe(true);
    }
  });

  it.each(files.filter((file) => file.startsWith('unsupported-')))('reports %s as unsupported-encoding', (file) => {
    const { schema, problems } = convertFile(join(CASES, file));
    expect(schema).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['unsupported-encoding']);
  });

  it.each(files.filter((file) => file.startsWith('malformed-')))('reports %s as invalid-xml', (file) => {
    const { schema, problems } = convertFile(join(CASES, file));
    expect(schema).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['invalid-xml']);
  });

  it('cover every case', () => {
    expect(files).toHaveLength(9);
  });

  it('decode Latin-1 as itself, not as Windows-1252, and refuse UTF-16 without a byte order mark', () => {
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="latin1"?><a>'),
      0x80,
      0xe9,
    ]);
    expect(decodeSchema(latin1).endsWith('\u0080é')).toBe(true);
    const utf16 = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-16"?><a/>');
    expect(() => decodeSchema(utf16)).toThrow(EncodingError);
    // The byte order mark stays: the loader refuses a second one.
    expect(decodeSchema(new TextEncoder().encode('\uFEFF<a/>'))).toBe('\uFEFF<a/>');
  });

  it('read the encoding of an XML declaration of any length, and refuse one without its end', () => {
    // Bytes C3 BC are ü in UTF-8, but Ã¼ in the ISO-8859-1 the declaration names after 600 spaces.
    const declaration = `<?xml version="1.0"${' '.repeat(600)}encoding="ISO-8859-1"?>`;
    const ascii = (text: string) => [...new TextEncoder().encode(text)];
    const bytes = new Uint8Array([...ascii(`${declaration}<a>`), 0xc3, 0xbc, ...ascii('</a>')]);
    expect(decodeSchema(bytes).endsWith('<a>\u00c3\u00bc</a>')).toBe(true);
    const unterminated = new TextEncoder().encode(`<?xml version="1.0"${' '.repeat(600)}<a/>`);
    expect(() => decodeSchema(unterminated)).toThrow(EncodingError);
  });
});
