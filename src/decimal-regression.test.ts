import { describe, expect, it } from 'vitest';
import { compare, disagreements } from './test-support/oracle.js';

const XS = 'http://www.w3.org/2001/XMLSchema';
const restriction = (name: string, base: string, facets: string) =>
  `<xs:simpleType name="${name}"><xs:restriction base="${base}">${facets}</xs:restriction></xs:simpleType>`;
const digits = (total: number, fraction: number) =>
  `<xs:totalDigits value="${total}"/><xs:fractionDigits value="${fraction}"/>`;
const schema = (types: string) =>
  `<xs:schema xmlns:xs="${XS}" xmlns="urn:digits" targetNamespace="urn:digits">
    <xs:element name="Value" type="ValueType"/>${types}
  </xs:schema>`;

async function check(types: string, values: readonly (readonly [string, boolean])[]): Promise<void> {
  const result = await compare({
    files: { 'digits.xsd': schema(types) },
    entry: 'digits.xsd',
    instances: Object.fromEntries(
      values.map(([value], index) => [`case-${index}`, `<Value xmlns="urn:digits">${value}</Value>`]),
    ),
  });
  expect(result.verdicts.map((verdict) => verdict.xsd)).toEqual(values.map(([, valid]) => valid));
  expect(disagreements(result.verdicts)).toEqual([]);
  expect(result.problems).toEqual([]);
}

describe('self-contained decimal digit regressions', () => {
  it('limits quantities to six total digits and two fraction digits', async () => {
    await check(restriction('ValueType', 'xs:decimal', digits(6, 2)), [
      ['0', true],
      ['1.12', true],
      ['999999', true],
      ['-999999', true],
      ['999999.00', true],
      ['99999.9', true],
      ['9999.99', true],
      ['99999.99', false],
      ['999999.5', false],
      ['-999999.5', false],
      ['1000000', false],
      ['1.125', false],
    ]);
  });

  it('limits point values across all five allowed decimal scales', async () => {
    await check(restriction('ValueType', 'xs:decimal', digits(6, 5)), [
      ['999999', true],
      ['99999.9', true],
      ['9999.99', true],
      ['999.999', true],
      ['99.9999', true],
      ['9.99999', true],
      ['0.00001', true],
      ['-0.00001', true],
      ['0.000001', false],
      ['12345.678', false],
      ['999999.5', false],
      ['9.999999', false],
    ]);
  });

  it('limits monetary amounts to twelve total digits without excluding valid integers', async () => {
    await check(restriction('ValueType', 'xs:decimal', digits(12, 2)), [
      ['999999999999', true],
      ['99999999999.9', true],
      ['9999999999.99', true],
      ['-9999999999.99', true],
      ['999999999999.5', false],
      ['99999999999.99', false],
      ['1000000000000', false],
      ['1.125', false],
    ]);
  });

  it('combines inherited digit restrictions with additional bounds', async () => {
    await check(
      restriction('Base', 'xs:decimal', digits(8, 4)) +
        restriction('ValueType', 'Base', `${digits(6, 2)}<xs:minExclusive value="0"/>`),
      [
        ['0', false],
        ['-1', false],
        ['0.01', true],
        ['999999', true],
        ['9999.99', true],
        ['999999.5', false],
        ['1.125', false],
      ],
    );
  });
});
