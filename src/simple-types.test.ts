import { describe, expect, it } from 'vitest';
import { convert } from './index.js';
import type { JsonSchema } from './json-schema.js';
import { Problems } from './problems.js';
import { SchemaSet } from './schema-set.js';
import { lexicalToJson, SimpleTypes, type SimpleTypeOptions } from './simple-types.js';
import { ajvFor } from './test-support/oracle.js';

const XS = 'http://www.w3.org/2001/XMLSchema';

function types(body: string, options: SimpleTypeOptions = { dateTime: 'format' }) {
  const problems = new Problems();
  const set = new SchemaSet(
    { 't.xsd': `<xs:schema xmlns:xs="${XS}" xmlns="urn:t" targetNamespace="urn:t">${body}</xs:schema>` },
    problems,
  );
  set.load('t.xsd');
  const simple = new SimpleTypes(set, problems, options);
  // The facet tests leave out `xml.decimal`, which a test of its own checks.
  const plain = (schema: JsonSchema): JsonSchema => {
    if (!schema.xml?.decimal) {
      return schema;
    }
    const xml = { ...schema.xml };
    delete xml.decimal;
    const out: JsonSchema = { ...schema, xml };
    if (Object.keys(xml).length === 0) {
      delete out.xml;
    }
    return out;
  };
  return {
    schema: (local: string) => plain(simple.schema({ ns: 'urn:t', local })),
    builtin: (local: string) => plain(simple.schema({ ns: XS, local })),
    marked: (local: string) => simple.schema({ ns: 'urn:t', local }),
    codes: () => problems.list.map((p) => p.code),
  };
}

const restriction = (name: string, base: string, facets: string) =>
  `<xs:simpleType name="${name}"><xs:restriction base="${base}">${facets}</xs:restriction></xs:simpleType>`;

const enumeration = (value: string) => `<xs:enumeration value="${value}"/>`;
const pattern = (value: string) => `<xs:pattern value="${value}"/>`;
const union = (name: string, members: string) =>
  `<xs:simpleType name="${name}"><xs:union memberTypes="${members}"/></xs:simpleType>`;

function expectValues(schema: JsonSchema, accepted: unknown[], rejected: unknown[]): void {
  const validate = ajvFor(schema);
  for (const value of accepted) {
    expect(validate(value), JSON.stringify(value)).toBe(true);
  }
  for (const value of rejected) {
    expect(validate(value), JSON.stringify(value)).toBe(false);
  }
}

describe('SimpleTypes', () => {
  it('maps built-in types', () => {
    const t = types('');
    expect(t.builtin('string')).toEqual({ type: 'string' });
    expect(t.builtin('boolean')).toEqual({ type: 'boolean' });
    expect(t.builtin('decimal')).toEqual({ type: 'number' });
    expect(t.builtin('unsignedByte')).toEqual({ type: 'integer', minimum: 0, maximum: 255 });
    expect(t.builtin('base64Binary')).toEqual({
      type: 'string',
      contentEncoding: 'base64',
      pattern: expect.any(String) as string,
      xml: { whiteSpace: 'collapse' },
    });
    expect(t.builtin('date')).toEqual({ type: 'string', format: 'date', xml: { whiteSpace: 'collapse' } });
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

  it('marks numbers of xs:decimal and its restrictions with xml.decimal, not integer, float or double', () => {
    const t = types(
      restriction('Amount', 'xs:decimal', '<xs:minInclusive value="0"/>') +
        restriction('Whole', 'xs:decimal', '<xs:fractionDigits value="0"/>') +
        restriction('Count', 'xs:int', '<xs:minInclusive value="0"/>') +
        restriction('Ratio', 'xs:double', '<xs:minInclusive value="0"/>'),
    );
    expect(t.marked('Amount').xml).toEqual({ decimal: true });
    expect(t.marked('Whole')).toMatchObject({ type: 'integer', xml: { decimal: true } });
    expect(t.marked('Count').xml).toBeUndefined();
    expect(JSON.stringify(t.marked('Ratio'))).not.toContain('decimal');
  });

  it('turns fractionDigits into multipleOf and finite decimal digit limits into alternatives', () => {
    const t = types(
      restriction('Amount', 'xs:decimal', '<xs:fractionDigits value="2"/>') +
        restriction('Whole', 'xs:decimal', '<xs:fractionDigits value="0"/><xs:totalDigits value="3"/>') +
        restriction('Money', 'xs:decimal', '<xs:fractionDigits value="2"/><xs:totalDigits value="6"/>'),
    );
    expect(t.schema('Amount')).toEqual({ type: 'number', multipleOf: 0.01 });
    expect(t.schema('Whole')).toEqual({ type: 'integer', exclusiveMinimum: -1000, exclusiveMaximum: 1000 });
    // Amount allows values with more than 15 significant digits, which JSON numbers round before the check.
    expect(t.codes()).toEqual(['rounded-number']);
    expect(t.schema('Money')).toEqual({
      type: 'number',
      multipleOf: 0.01,
      anyOf: [
        { multipleOf: 1, exclusiveMinimum: -1000000, exclusiveMaximum: 1000000 },
        { multipleOf: 0.1, exclusiveMinimum: -100000, exclusiveMaximum: 100000 },
        { multipleOf: 0.01, exclusiveMinimum: -10000, exclusiveMaximum: 10000 },
      ],
      exclusiveMinimum: -1000000,
      exclusiveMaximum: 1000000,
    });
    expect(t.codes()).toEqual(['rounded-number']);
  });

  it('reports the remaining approximation when totalDigits has no fractionDigits limit', () => {
    const t = types(restriction('Amount', 'xs:decimal', '<xs:totalDigits value="6"/>'));
    expect(t.schema('Amount')).toEqual({ type: 'number', exclusiveMinimum: -1000000, exclusiveMaximum: 1000000 });
    expect(t.codes()).toEqual(['approximated-total-digits']);
  });

  it('filters inherited enumeration values using exact decimal digit limits', () => {
    const t = types(
      restriction(
        'Base',
        'xs:decimal',
        '<xs:totalDigits value="8"/><xs:fractionDigits value="4"/>' +
          '<xs:enumeration value="999999"/><xs:enumeration value="999999.5"/><xs:enumeration value="9999.99"/>',
      ) + restriction('Amount', 'Base', '<xs:totalDigits value="6"/><xs:fractionDigits value="2"/>'),
    );
    expect(t.schema('Amount')).toEqual({ type: 'number', enum: [999999, 9999.99] });
    expect(t.codes()).toEqual(['unreachable-enumeration']);
  });

  it('checks union enumeration values against the member types', () => {
    const t = types(
      restriction('Small', 'xs:integer', '<xs:maxInclusive value="5"/>') +
        '<xs:simpleType name="Numeric"><xs:union memberTypes="Small xs:byte"/></xs:simpleType>' +
        restriction('Narrow', 'Numeric', '<xs:enumeration value="4"/><xs:enumeration value="128"/>'),
    );
    expect(t.schema('Narrow')).toEqual({ type: 'integer', enum: [4] });
    expect(t.codes()).toEqual(['unreachable-enumeration']);
  });

  it('checks union enumeration values against exact decimal alternatives', () => {
    const t = types(
      restriction('Amount', 'xs:decimal', '<xs:totalDigits value="6"/><xs:fractionDigits value="2"/>') +
        '<xs:simpleType name="Numeric"><xs:union memberTypes="Amount xs:negativeInteger"/></xs:simpleType>' +
        restriction(
          'Narrow',
          'Numeric',
          '<xs:enumeration value="999999"/><xs:enumeration value="9999.99"/><xs:enumeration value="999999.5"/>',
        ),
    );
    expect(t.schema('Narrow')).toEqual({ type: 'number', enum: [999999, 9999.99] });
    expect(t.codes()).toEqual(['unreachable-enumeration']);
  });

  it.each([
    {
      label: 'underflowing fractionDigits',
      facets: '<xs:fractionDigits value="324"/>',
      expected: { type: 'number' },
      codes: ['rounded-number', 'unsupported-facet'],
    },
    {
      label: 'overflowing totalDigits',
      facets: '<xs:totalDigits value="309"/>',
      expected: { type: 'number' },
      codes: ['unsupported-facet'],
    },
    {
      label: 'both unrepresentable digit facets',
      facets: '<xs:totalDigits value="324"/><xs:fractionDigits value="324"/>',
      expected: { type: 'number' },
      codes: ['rounded-number', 'unsupported-facet', 'unsupported-facet'],
    },
    {
      label: 'an unrepresentable scale with a representable bound',
      facets: '<xs:totalDigits value="6"/><xs:fractionDigits value="324"/>',
      expected: { type: 'number', exclusiveMinimum: -1000000, exclusiveMaximum: 1000000 },
      codes: ['rounded-number', 'unsupported-facet', 'approximated-total-digits'],
    },
  ])('reports $label without writing invalid numeric constraints', ({ facets, expected, codes }) => {
    const t = types(restriction('Amount', 'xs:decimal', facets));
    expect(t.schema('Amount')).toEqual(expected);
    expect(t.codes()).toEqual(codes);
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
        '<xs:simpleType name="U"><xs:union memberTypes="xs:int xs:date"/></xs:simpleType>' +
        restriction('Digits', 'xs:integer', '<xs:pattern value="\\d{4}"/>') +
        restriction('After', 'xs:date', '<xs:minInclusive value="2000-01-01"/>'),
    );
    expect(t.schema('L')).toEqual({ type: 'array', items: { type: 'integer' }, xml: { list: true } });
    // The members are checked as text; the range of xs:int is not.
    expect(t.schema('U')).toEqual({
      type: 'string',
      anyOf: [
        { type: 'string', pattern: '^(?:[+\\-]?[0-9]+)$', xml: { whiteSpace: 'collapse' } },
        { type: 'string', format: 'date', xml: { whiteSpace: 'collapse' } },
      ],
      xml: { whiteSpace: 'collapse' },
    });
    expect(t.schema('Digits')).toEqual({ type: 'integer' });
    expect(t.schema('After')).toEqual({ type: 'string', format: 'date', xml: { whiteSpace: 'collapse' } });
    expect(t.schema('Missing')).toEqual({});
    expect(t.codes()).toEqual(['unsupported-union', 'lexical-pattern', 'unsupported-bound', 'unknown-type']);
  });

  it('counts the length of hexBinary in octets, of lists in items, and leaves out lengths in base64 octets', () => {
    const t = types(
      restriction('Hash', 'xs:hexBinary', '<xs:length value="20"/>') +
        restriction('Blob', 'xs:base64Binary', '<xs:maxLength value="1024"/>') +
        restriction('Tokens', 'xs:NMTOKENS', '<xs:maxLength value="3"/>'),
    );
    expect(t.schema('Hash')).toMatchObject({ minLength: 40, maxLength: 40 });
    expect(t.schema('Blob')).toEqual({
      type: 'string',
      contentEncoding: 'base64',
      pattern: expect.any(String) as string,
      xml: { whiteSpace: 'collapse' },
    });
    expect(t.schema('Tokens')).toMatchObject({ type: 'array', minItems: 1, maxItems: 3 });
    expect(t.codes()).toEqual(['unsupported-length']);
  });

  it.each([
    { base: 'xs:hexBinary', named: '0a', lexical: '[0-9A-F]{2}', valid: '0A', invalid: '0B' },
    {
      base: 'xs:dateTime',
      named: '2002-01-01T12:00:00Z',
      lexical: '.*\\+00:00',
      valid: '2002-01-01T12:00:00+00:00',
      invalid: '2002-01-01T12:00:01+00:00',
    },
    { base: 'Mixed', named: '042', lexical: '42', valid: '42', invalid: '43' },
  ])(
    'matches the instance pattern independently of the $base enumeration spelling',
    ({ base, named, lexical, valid, invalid }) => {
      const t = types(
        union('Mixed', 'xs:integer xs:string') +
          restriction('Together', base, enumeration(named) + pattern(lexical)) +
          restriction('Base', base, enumeration(named)) +
          restriction('Later', 'Base', pattern(lexical)),
        { dateTime: 'pattern' },
      );
      for (const type of ['Together', 'Later']) {
        expectValues(t.schema(type), [valid], [named, invalid]);
      }
      expect(t.codes()).toEqual([]);
    },
  );

  it.each([
    { base: 'xs:hexBinary', named: '0a', spelling: '0A', invalid: '0B', valid: ['0A', '0a'] },
    {
      base: 'xs:date',
      named: '2002-01-01Z',
      spelling: '2002-01-01+00:00',
      invalid: '2002-01-02+00:00',
      valid: ['2002-01-01Z', '2002-01-01-00:00'],
    },
    {
      base: 'xs:time',
      named: '12:00:00.10Z',
      spelling: '12:00:00.100+00:00',
      invalid: '12:00:00.12+00:00',
      valid: ['12:00:00.1Z', '12:00:00.100-00:00'],
    },
    {
      base: 'xs:float',
      named: '0.1',
      spelling: '0.10000000149011612',
      invalid: '0.10001',
      valid: [0.1, 0.10000000149011612],
    },
    { base: 'xs:float', named: 'INF', spelling: '1e39', invalid: '-1e39', valid: ['INF', 1e39] },
  ])(
    'recognizes the same $base value when a derived enumeration uses $spelling',
    ({ base, named, spelling, valid, invalid }) => {
      const t = types(
        restriction('Base', base, enumeration(named)) +
          restriction('Derived', 'Base', enumeration(spelling)) +
          restriction('Different', 'Base', enumeration(invalid)),
        { dateTime: 'pattern' },
      );
      expectValues(t.schema('Derived'), valid, [base === 'xs:float' ? Number(invalid) : invalid]);
      expect(t.codes()).toEqual([]);
      expectValues(t.schema('Different'), [], valid);
      expect(t.codes()).toEqual(['invalid-facet']);
    },
  );

  it('uses the first accepting union member to compare a derived enumeration with its base', () => {
    const t = types(
      union('BooleanFirst', 'xs:boolean xs:token') +
        restriction('BooleanBase', 'BooleanFirst', enumeration('true')) +
        restriction('BooleanDerived', 'BooleanBase', enumeration('1')) +
        union('TokenFirst', 'xs:token xs:boolean') +
        restriction('TokenBase', 'TokenFirst', enumeration('true')) +
        restriction('TokenDerived', 'TokenBase', enumeration('1')),
    );
    expectValues(t.schema('BooleanDerived'), ['1', 'true'], ['0', 'TRUE']);
    expect(t.codes()).toEqual([]);
    expectValues(t.schema('TokenDerived'), [], ['1', 'true']);
    expect(t.codes()).toEqual(['invalid-facet']);
  });

  it('keeps a spelling only if its first accepting union member assigns the enumerated value', () => {
    const t = types(
      restriction('Padded', 'xs:integer', pattern('0[0-9]+')) +
        union('PaddedOrString', 'Padded xs:string') +
        union('PaddedOrIntegerOrString', 'Padded xs:integer xs:string') +
        union('StringFirst', 'xs:string xs:integer') +
        union('IntegerFirst', 'xs:integer xs:boolean') +
        restriction('PaddedValue', 'PaddedOrString', enumeration('042')) +
        restriction('IntegerValue', 'PaddedOrIntegerOrString', enumeration('042') + pattern('42')) +
        restriction('StringValue', 'StringFirst', enumeration('042')) +
        restriction('Flag', 'IntegerFirst', enumeration('true')),
    );
    expectValues(t.schema('PaddedValue'), ['042', '0042'], ['42', '43']);
    expectValues(t.schema('IntegerValue'), ['42'], ['042', '43']);
    expectValues(t.schema('StringValue'), ['042'], ['42', '0042']);
    expectValues(t.schema('Flag'), ['true'], ['1', '0', 'false']);
  });

  it('uses float32 equality in a numeric union only for values selected as floats', () => {
    const t = types(
      union('FloatFirst', 'xs:float xs:integer') +
        union('IntegerFirst', 'xs:integer xs:float') +
        union('DecimalFirst', 'xs:decimal xs:float') +
        restriction('UnitFloat', 'xs:float', '<xs:maxInclusive value="1"/>') +
        union('SmallFloatFirst', 'UnitFloat xs:integer') +
        restriction('Fraction', 'FloatFirst', enumeration('0.1')) +
        restriction('Decimal', 'DecimalFirst', enumeration('0.1')) +
        restriction('Float', 'FloatFirst', enumeration('16777217')) +
        restriction('Integer', 'IntegerFirst', enumeration('16777217')) +
        restriction('OutsideFloat', 'SmallFloatFirst', enumeration('16777217')) +
        restriction('Overflow', 'FloatFirst', enumeration('1e39')),
    );
    expectValues(t.schema('Fraction'), [0.1, 0.10000000149011612], [0.10001, 0, '0.1']);
    expectValues(t.schema('Decimal'), [0.1], [0.10000000149011612, 0.10001]);
    expectValues(t.schema('Float'), [16777216, 16777217], [16777218]);
    expectValues(t.schema('Integer'), [16777217], [16777216, 16777218]);
    expectValues(t.schema('OutsideFloat'), [16777217], [16777216, 16777218]);
    expectValues(t.schema('Overflow'), ['INF', 1e39], [-1e39, 1e30]);
    expect(t.codes()).toEqual([]);
  });

  it.each([
    { item: 'xs:hexBinary', named: '0a ff', spelling: '0A FF', valid: ['0A', 'fF'], invalid: ['0a', 'fe'] },
    {
      item: 'xs:date',
      named: '2002-01-01Z 2002-01-02Z',
      spelling: '2002-01-01+00:00 2002-01-02-00:00',
      valid: ['2002-01-01-00:00', '2002-01-02Z'],
      invalid: ['2002-01-01Z', '2002-01-03Z'],
    },
  ])('compares enumerated and fixed lists of $item by item value', ({ item, named, spelling, valid, invalid }) => {
    const declarations =
      `<xs:simpleType name="List"><xs:list itemType="${item}"/></xs:simpleType>` +
      restriction('Base', 'List', enumeration(named)) +
      restriction('Derived', 'Base', enumeration(spelling));
    const t = types(declarations, { dateTime: 'pattern' });
    for (const type of ['Base', 'Derived']) {
      expectValues(t.schema(type), [valid], [invalid, [valid[0]], [...valid].reverse()]);
    }
    expect(t.codes()).toEqual([]);
    const { schema, problems } = convert({
      files: {
        't.xsd': `<xs:schema xmlns:xs="${XS}">${declarations}
          <xs:element name="Root" type="List" fixed="${named}"/>
        </xs:schema>`,
      },
      entry: 't.xsd',
    });
    expect(problems).toEqual([]);
    expect(schema).toBeDefined();
    expectValues(schema ?? {}, [valid], [invalid, [...valid].reverse()]);
  });

  it('checks each item pattern in a list with one enumerated value', () => {
    const t = types(
      restriction('UpperHex', 'xs:hexBinary', pattern('[0-9A-F]+') + '<xs:length value="1"/>') +
        '<xs:simpleType name="List"><xs:list itemType="UpperHex"/></xs:simpleType>' +
        restriction('OnlyOne', 'List', enumeration('0A')),
    );
    expectValues(t.schema('OnlyOne'), [['0A']], [['0a'], ['0B'], ['0A0A'], ['0A', '0A']]);
    expect(t.codes()).toEqual([]);
  });

  it('reports that numbers and booleans lose their lexical pattern even with an enumeration', () => {
    const t = types(
      union('Numeric', 'xs:integer xs:decimal') +
        restriction('Count', 'xs:integer', pattern('0[0-9]') + enumeration('05')) +
        restriction('Flag', 'xs:boolean', pattern('1') + enumeration('true')) +
        restriction('Amount', 'Numeric', pattern('0[0-9]') + enumeration('05')),
    );
    expectValues(t.schema('Count'), [5], [4, '05']);
    expectValues(t.schema('Flag'), [true], [false, '1']);
    expectValues(t.schema('Amount'), [5], [4, '05']);
    expect(t.codes()).toEqual(['lexical-pattern', 'lexical-pattern', 'lexical-pattern']);
  });

  it.each(['xs:integer', 'xs:decimal', 'xs:boolean', 'xs:date', 'xs:time', 'xs:duration'])(
    'reports length facets on %s and omits them',
    (base) => {
      const t = types(
        restriction('Bound', base, '<xs:length value="2"/><xs:minLength value="1"/><xs:maxLength value="3"/>'),
      );
      const out = t.schema('Bound');
      expect(out).not.toHaveProperty('minLength');
      expect(out).not.toHaveProperty('maxLength');
      expect(() => ajvFor(out)).not.toThrow();
      expect(t.codes()).toEqual(['invalid-facet', 'invalid-facet', 'invalid-facet']);
    },
  );

  it('reports fractionDigits precision loss when a bound is printed in exponential notation', () => {
    const t = types(
      restriction(
        'Amount',
        'xs:decimal',
        '<xs:minInclusive value="0"/><xs:maxInclusive value="1000000000000000000000"/><xs:fractionDigits value="2"/>',
      ),
    );
    expect(t.schema('Amount')).toMatchObject({ minimum: 0, maximum: 1e21, multipleOf: 0.01 });
    expect(t.codes()).toEqual(['rounded-number', 'rounded-number']);
  });
});

describe('lexicalToJson', () => {
  it('converts lexical values to the JSON type', () => {
    expect(lexicalToJson('integer', ' 7 ')).toEqual({ value: 7 });
    expect(lexicalToJson('number', '1.50')).toEqual({ value: 1.5 });
    expect(lexicalToJson('number', '1e999')).toHaveProperty('error');
    expect(lexicalToJson('integer', '1.5')).toEqual({ error: '1.5 is no integer' });
    expect(lexicalToJson('boolean', '1')).toEqual({ value: true });
    expect(lexicalToJson('boolean', 'yes')).toEqual({ error: 'yes is no boolean' });
    expect(lexicalToJson('string', ' a ')).toEqual({ value: ' a ' });
  });
});
