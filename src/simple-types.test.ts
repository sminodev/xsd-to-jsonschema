import { describe, expect, it } from 'vitest';
import { Problems } from './problems.js';
import { SchemaSet } from './schema-set.js';
import { lexicalToJson, SimpleTypes, type SimpleTypeOptions } from './simple-types.js';

const XS = 'http://www.w3.org/2001/XMLSchema';

function types(body: string, options: SimpleTypeOptions = { dateTime: 'format' }) {
  const problems = new Problems();
  const set = new SchemaSet(
    { 't.xsd': `<xs:schema xmlns:xs="${XS}" xmlns="urn:t" targetNamespace="urn:t">${body}</xs:schema>` },
    problems,
  );
  set.load('t.xsd');
  const simple = new SimpleTypes(set, problems, options);
  return {
    schema: (local: string) => simple.schema({ ns: 'urn:t', local }),
    builtin: (local: string) => simple.schema({ ns: XS, local }),
    codes: () => problems.list.map((p) => p.code),
  };
}

const restriction = (name: string, base: string, facets: string) =>
  `<xs:simpleType name="${name}"><xs:restriction base="${base}">${facets}</xs:restriction></xs:simpleType>`;

describe('SimpleTypes', () => {
  it('maps built-in types', () => {
    const t = types('');
    expect(t.builtin('string')).toEqual({ type: 'string' });
    expect(t.builtin('boolean')).toEqual({ type: 'boolean' });
    expect(t.builtin('decimal')).toEqual({ type: 'number' });
    expect(t.builtin('unsignedByte')).toEqual({ type: 'integer', minimum: 0, maximum: 255 });
    expect(t.builtin('base64Binary')).toEqual({ type: 'string', contentEncoding: 'base64' });
    expect(t.builtin('date')).toEqual({ type: 'string', format: 'date' });
  });

  it('writes dates as XML Schema patterns on request', () => {
    const date = types('', { dateTime: 'pattern' }).builtin('dateTime');
    expect(date.format).toBeUndefined();
    const re = new RegExp(date.pattern ?? '', 'u');
    expect(re.test('2026-11-04T08:30:00')).toBe(true);
    expect(re.test('2026-11-04T08:30:00+01:00')).toBe(true);
    expect(re.test('2026-11-04')).toBe(false);
  });

  it('merges a restriction chain into one schema', () => {
    const t = types(
      restriction('Name', 'xs:string', '<xs:maxLength value="45"/>') +
        restriction('Short', 'Name', '<xs:maxLength value="20"/><xs:minLength value="1"/>'),
    );
    expect(t.schema('Short')).toEqual({ type: 'string', maxLength: 20, minLength: 1 });
  });

  it('applies patterns of one step as alternatives and patterns of all steps together', () => {
    const t = types(
      restriction('Code', 'xs:string', '<xs:pattern value="[A-Z]{2}"/><xs:pattern value="\\d{3}"/>') +
        restriction('Narrow', 'Code', '<xs:pattern value="A.|9.."/>'),
    );
    const re = new RegExp(t.schema('Narrow').pattern ?? '', 'u');
    expect(['AB', '912'].every((v) => re.test(v))).toBe(true);
    expect(['BA', '9X'].some((v) => re.test(v))).toBe(false);
  });

  it('keeps the tightest numeric bounds', () => {
    const t = types(
      restriction('Count', 'xs:unsignedByte', '<xs:minExclusive value="0"/><xs:maxInclusive value="99"/>'),
    );
    expect(t.schema('Count')).toEqual({ type: 'integer', exclusiveMinimum: 0, maximum: 99 });
  });

  it('turns fractionDigits into multipleOf and totalDigits into bounds', () => {
    const t = types(
      restriction('Amount', 'xs:decimal', '<xs:fractionDigits value="2"/>') +
        restriction('Whole', 'xs:decimal', '<xs:fractionDigits value="0"/><xs:totalDigits value="3"/>') +
        restriction('Money', 'xs:decimal', '<xs:fractionDigits value="2"/><xs:totalDigits value="6"/>'),
    );
    expect(t.schema('Amount')).toEqual({ type: 'number', multipleOf: 0.01 });
    expect(t.schema('Whole')).toEqual({ type: 'integer', exclusiveMinimum: -1000, exclusiveMaximum: 1000 });
    expect(t.codes()).toEqual([]);
    expect(t.schema('Money')).toEqual({
      type: 'number',
      multipleOf: 0.01,
      exclusiveMinimum: -1000000,
      exclusiveMaximum: 1000000,
    });
    expect(t.codes()).toEqual(['approximated-total-digits']);
  });

  it('gives enumeration values their JSON type and drops values other facets rule out', () => {
    const t = types(
      restriction('Level', 'xs:integer', '<xs:enumeration value="1"/><xs:enumeration value="2"/>') +
        restriction(
          'Flag',
          'xs:string',
          '<xs:length value="1"/><xs:enumeration value="0"/><xs:enumeration value="1"/><xs:enumeration value="10"/>',
        ),
    );
    expect(t.schema('Level')).toEqual({ type: 'integer', enum: [1, 2] });
    expect(t.schema('Flag')).toEqual({ type: 'string', enum: ['0', '1'] });
    expect(t.codes()).toEqual(['unreachable-enumeration']);
  });

  it('reports what JSON Schema cannot express', () => {
    const t = types(
      '<xs:simpleType name="L"><xs:list itemType="xs:integer"/></xs:simpleType>' +
        '<xs:simpleType name="U"><xs:union memberTypes="xs:integer xs:date"/></xs:simpleType>' +
        restriction('Digits', 'xs:integer', '<xs:pattern value="\\d{4}"/>') +
        restriction('After', 'xs:date', '<xs:minInclusive value="2000-01-01"/>'),
    );
    expect(t.schema('L')).toEqual({ type: 'string' });
    expect(t.schema('U')).toEqual({ type: 'string' });
    expect(t.schema('Digits')).toEqual({ type: 'integer' });
    expect(t.schema('After')).toEqual({ type: 'string', format: 'date' });
    expect(t.schema('Missing')).toEqual({});
    expect(t.codes()).toEqual([
      'unsupported-list',
      'unsupported-union',
      'lexical-pattern',
      'unsupported-bound',
      'unknown-type',
    ]);
  });
});

describe('lexicalToJson', () => {
  it('converts lexical values to the JSON type', () => {
    expect(lexicalToJson('integer', ' 7 ')).toEqual({ value: 7 });
    expect(lexicalToJson('number', '1.50')).toEqual({ value: 1.5 });
    expect(lexicalToJson('integer', '1.5')).toEqual({ error: '1.5 is no integer' });
    expect(lexicalToJson('boolean', '1')).toEqual({ value: true });
    expect(lexicalToJson('boolean', 'yes')).toEqual({ error: 'yes is no boolean' });
    expect(lexicalToJson('string', ' a ')).toEqual({ value: ' a ' });
  });
});
