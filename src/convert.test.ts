import { describe, expect, it } from 'vitest';
import { convert } from './convert.js';
import type { Problem } from './problems.js';

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function schema(body: string, ns = 'urn:t'): string {
  return `<xs:schema ${XS} xmlns="${ns}" xmlns:t="${ns}" targetNamespace="${ns}" elementFormDefault="qualified">${body}</xs:schema>`;
}

const codes = (problems: Problem[]) => problems.map((p) => p.code);

describe('convert', () => {
  describe('root element', () => {
    const files = {
      'a.xsd': schema('<xs:element name="A" type="xs:string"/><xs:element name="B" type="xs:integer"/>'),
    };

    it('needs root when the entry declares several global elements', () => {
      const { schema: out, problems } = convert({ files, entry: 'a.xsd' });
      expect(out).toBeUndefined();
      expect(codes(problems)).toEqual(['root-required']);
      expect(problems[0]?.message).toContain('{urn:t}A');
    });

    it.each(['B', 't:B', '{urn:t}B'])('accepts the root as %s', (root) => {
      const { schema: out } = convert({ files, entry: 'a.xsd', root });
      expect(out?.type).toBe('integer');
      expect(out?.xml).toEqual({ name: 'B', namespace: 'urn:t' });
      expect(out?.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    });

    it('reports an unknown root with the candidates', () => {
      const { schema: out, problems } = convert({ files, entry: 'a.xsd', root: 'C' });
      expect(out).toBeUndefined();
      expect(codes(problems)).toEqual(['unknown-root']);
    });
  });

  describe('schema documents', () => {
    it('reports a missing import with its location', () => {
      const files = {
        'a.xsd': schema(
          '<xs:import namespace="urn:o" schemaLocation="sub/o.xsd"/><xs:element name="A" type="xs:string"/>',
        ),
      };
      const { schema: out, problems } = convert({ files, entry: 'a.xsd' });
      expect(out?.type).toBe('string');
      expect(problems).toEqual([
        expect.objectContaining({
          code: 'missing-file',
          file: 'a.xsd',
          line: 1,
          message: 'schema document sub/o.xsd not found',
        }),
      ]);
    });

    it('reads imports relative to the importing document, also through a reader function', () => {
      const texts: Record<string, string> = {
        'dir/a.xsd': schema(
          '<xs:import namespace="urn:o" schemaLocation="../o.xsd"/><xs:element name="A" type="o:Code"/>',
        ).replace('xmlns:t=', 'xmlns:o="urn:o" xmlns:t='),
        'o.xsd': schema(
          '<xs:simpleType name="Code"><xs:restriction base="xs:string"><xs:length value="2"/></xs:restriction></xs:simpleType>',
          'urn:o',
        ),
      };
      const { schema: out, problems } = convert({ files: (path) => texts[path], entry: 'dir/a.xsd' });
      expect(problems).toEqual([]);
      expect(out?.$ref).toBe('#/$defs/Code');
      expect(out?.$defs?.['Code']).toEqual({ type: 'string', minLength: 2, maxLength: 2 });
    });
  });

  describe('definitions', () => {
    it('prefix a name that two namespaces use with a label of the namespace', () => {
      const other = 'http://example.org/schema/Other/1.0';
      const files = {
        'a.xsd': schema(
          `<xs:import namespace="${other}" schemaLocation="o.xsd"/>
          <xs:element name="A"><xs:complexType><xs:sequence>
            <xs:element name="X" type="Code"/><xs:element name="Y" type="o:Code"/>
          </xs:sequence></xs:complexType></xs:element>
          <xs:simpleType name="Code"><xs:restriction base="xs:string"/></xs:simpleType>`,
        ).replace('xmlns:t=', `xmlns:o="${other}" xmlns:t=`),
        'o.xsd': schema('<xs:simpleType name="Code"><xs:restriction base="xs:integer"/></xs:simpleType>', other),
      };
      const { schema: out } = convert({ files, entry: 'a.xsd' });
      expect(Object.keys(out?.$defs ?? {})).toEqual(['Code', 'Other_1.0.Code']);
      expect(out?.properties?.['Y']).toEqual({ $ref: '#/$defs/Other_1.0.Code', xml: { namespace: 'urn:t' } });
    });
  });

  describe('options', () => {
    const files = {
      'a.xsd': schema(`<xs:element name="A"><xs:complexType><xs:sequence>
        <xs:element name="D" type="xs:date"/><xs:element name="B" type="xs:base64Binary"/>
      </xs:sequence><xs:attribute name="v" type="xs:string"/></xs:complexType></xs:element>`),
    };

    it('write dates as format by default and as the XML Schema format on request', () => {
      expect(convert({ files, entry: 'a.xsd' }).schema?.properties?.['D']).toEqual({
        type: 'string',
        format: 'date',
        xml: { namespace: 'urn:t' },
      });
      const date = convert({ files, entry: 'a.xsd', options: { dateTime: 'pattern' } }).schema?.properties?.['D'];
      expect(date).not.toHaveProperty('format');
      expect(new RegExp((date as { pattern: string }).pattern, 'u').test('2026-11-04+01:00')).toBe(true);
    });

    it('leave out the xml annotations with xml: false', () => {
      const { schema: out } = convert({ files, entry: 'a.xsd', options: { xml: false } });
      expect(JSON.stringify(out)).not.toContain('"xml"');
      expect(out?.properties?.['B']).toEqual({ type: 'string', contentEncoding: 'base64' });
    });

    it('reject an unknown dateTime mode', () => {
      expect(() => convert({ files, entry: 'a.xsd', options: { dateTime: 'x' as unknown as 'format' } })).toThrow(
        TypeError,
      );
    });
  });

  describe('problems', () => {
    const problemsOf = (body: string) =>
      codes(convert({ files: { 'a.xsd': schema(body) }, entry: 'a.xsd', root: 'A' }).problems);
    const type = (content: string) => `<xs:element name="A"><xs:complexType${content}</xs:complexType></xs:element>`;

    it('for constructs JSON Schema cannot express', () => {
      expect(problemsOf(type('><xs:sequence><xs:any/></xs:sequence>'))).toEqual(['unsupported-any']);
      expect(problemsOf(type(' mixed="true"><xs:sequence/>'))).toEqual(['unsupported-mixed']);
      expect(
        problemsOf(type('><xs:sequence maxOccurs="2"><xs:element name="B" type="xs:string"/></xs:sequence>')),
      ).toEqual(['repeated-group']);
      expect(
        problemsOf(
          '<xs:element name="A"><xs:simpleType><xs:restriction base="xs:string"><xs:pattern value="\\p{IsBasicLatin}"/></xs:restriction></xs:simpleType></xs:element>',
        ),
      ).toEqual(['untranslatable-pattern']);
    });

    it('for mistakes in the XML Schema', () => {
      expect(problemsOf('<xs:element name="A" type="Missing"/>')).toEqual(['unknown-type']);
      expect(problemsOf(type('><xs:sequence><xs:element ref="Missing"/></xs:sequence>'))).toEqual(['unknown-element']);
      expect(
        problemsOf(
          type(
            '><xs:sequence><xs:element name="B" type="xs:string"/><xs:element name="B" type="xs:string"/></xs:sequence>',
          ),
        ),
      ).toEqual(['duplicate-name']);
      expect(
        problemsOf(
          type(
            '><xs:choice><xs:element name="B" type="xs:string" minOccurs="0"/><xs:element name="C" type="xs:string" minOccurs="0"/></xs:choice>',
          ),
        ),
      ).toEqual(['ambiguous-choice']);
    });
  });

  describe('values', () => {
    it('give enumerations, fixed and default values the JSON type of the declared type', () => {
      const { schema: out } = convert({
        files: {
          'a.xsd': schema(`<xs:element name="A"><xs:complexType><xs:sequence>
            <xs:element name="N" type="Level" fixed="2"/>
            <xs:element name="B" type="xs:boolean" default="1" minOccurs="0"/>
          </xs:sequence></xs:complexType></xs:element>
          <xs:simpleType name="Level"><xs:restriction base="xs:integer"><xs:enumeration value="1"/><xs:enumeration value="2"/></xs:restriction></xs:simpleType>`),
        },
        entry: 'a.xsd',
      });
      expect(out?.$defs?.['Level']).toEqual({ type: 'integer', enum: [1, 2] });
      expect(out?.properties?.['N']).toMatchObject({ const: 2 });
      expect(out?.properties?.['B']).toMatchObject({ default: true });
    });
  });
});
