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

    it('says so when the entry declares no global element', () => {
      const types = { 't.xsd': schema('<xs:simpleType name="T"><xs:restriction base="xs:string"/></xs:simpleType>') };
      const { schema: out, problems } = convert({ files: types, entry: 't.xsd' });
      expect(out).toBeUndefined();
      expect(problems[0]?.message).toBe(
        't.xsd declares no global element; choose the document that declares the root element as entry',
      );
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

    it('hands imports by absolute URL to the reader unchanged', () => {
      const remote = 'https://example.org/schemas/o.xsd';
      const texts: Record<string, string> = {
        'a.xsd': schema(
          `<xs:import namespace="urn:o" schemaLocation="${remote}"/><xs:element name="A" type="o:Code"/>`,
        ).replace('xmlns:t=', 'xmlns:o="urn:o" xmlns:t='),
        [remote]: schema('<xs:include schemaLocation="code.xsd"/>', 'urn:o'),
        'https://example.org/schemas/code.xsd': schema(
          '<xs:simpleType name="Code"><xs:restriction base="xs:string"><xs:length value="2"/></xs:restriction></xs:simpleType>',
          'urn:o',
        ),
      };
      const read: string[] = [];
      const { schema: out, problems } = convert({ files: (path) => (read.push(path), texts[path]), entry: 'a.xsd' });
      expect(problems).toEqual([]);
      expect(read).toEqual(['a.xsd', remote, 'https://example.org/schemas/code.xsd']);
      expect(out?.$defs?.['Code']).toEqual({ type: 'string', minLength: 2, maxLength: 2 });
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

    it('write dates in the XML Schema format by default and as format on request', () => {
      const date = convert({ files, entry: 'a.xsd' }).schema?.properties?.['D'];
      expect(date).not.toHaveProperty('format');
      const pattern = new RegExp((date as { pattern: string }).pattern, 'u');
      expect(['2026-11-04', '2026-11-04+01:00'].every((d) => pattern.test(d))).toBe(true);
      expect(convert({ files, entry: 'a.xsd', options: { dateTime: 'format' } }).schema?.properties?.['D']).toEqual({
        type: 'string',
        format: 'date',
        xml: { namespace: 'urn:t' },
      });
    });

    it('leave out the xml annotations with xml: false', () => {
      const { schema: out } = convert({ files, entry: 'a.xsd', options: { xml: false } });
      expect(JSON.stringify(out)).not.toContain('"xml"');
      expect(out?.properties?.['B']).toEqual({ type: 'string', contentEncoding: 'base64' });
    });

    it('reject an unknown dateTime mode and an empty textProperty', () => {
      expect(() => convert({ files, entry: 'a.xsd', options: { dateTime: 'x' as unknown as 'format' } })).toThrow(
        TypeError,
      );
      expect(() => convert({ files, entry: 'a.xsd', options: { textProperty: '' } })).toThrow(TypeError);
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
      expect(problemsOf(type('><xs:complexContent><xs:restriction base="Missing"/></xs:complexContent>'))).toEqual([
        'unknown-type',
      ]);
    });

    it('for facet values that are no counts, leaving the facet out', () => {
      const { schema: out, problems } = convert({
        files: {
          'a.xsd': schema(`<xs:element name="A"><xs:simpleType><xs:restriction base="xs:decimal">
            <xs:totalDigits value="0"/><xs:fractionDigits value="two"/>
          </xs:restriction></xs:simpleType></xs:element>`),
        },
        entry: 'a.xsd',
      });
      expect(codes(problems)).toEqual(['invalid-facet', 'invalid-facet']);
      expect(problems[1]?.message).toBe('fractionDigits needs a non-negative integer, not "two"');
      expect(out).toEqual(expect.objectContaining({ type: 'number' }));
      expect(JSON.stringify(out)).not.toMatch(/null|multipleOf|Minimum|Maximum/);
    });

    it('with the file and line of the node that names an unknown type', () => {
      const files = {
        'a.xsd': schema(`<xs:element name="A" type="xs:strng"/>
          <xs:element name="B"><xs:simpleType><xs:restriction base="Missing"/></xs:simpleType></xs:element>`),
      };
      const [a, b] = ['A', 'B'].map((root) => convert({ files, entry: 'a.xsd', root }).problems);
      expect(a).toEqual([expect.objectContaining({ code: 'unknown-type', file: 'a.xsd', line: 1 })]);
      expect(b).toEqual([expect.objectContaining({ code: 'unknown-type', file: 'a.xsd', line: 2 })]);
    });

    it('for a substitution group head, but not for a member used by its own name', () => {
      const body = `<xs:element name="Shape" type="xs:string"/>
        <xs:element name="Circle" type="xs:string" substitutionGroup="t:Shape"/>`;
      const uses = (ref: string) => type(`><xs:sequence><xs:element ref="${ref}"/></xs:sequence>`);
      const head = convert({ files: { 'a.xsd': schema(uses('Shape') + body) }, entry: 'a.xsd', root: 'A' }).problems;
      expect(head).toEqual([
        expect.objectContaining({
          code: 'unsupported-element',
          message: expect.stringContaining('(Circle)') as string,
        }),
      ]);
      expect(problemsOf(uses('Circle') + body)).toEqual([]);
    });

    it('for nillable, abstract and identity constraints, also on a root with a named type', () => {
      expect(
        problemsOf(`<xs:element name="A" type="T" nillable="true">
          <xs:unique name="u"><xs:selector xpath="t:B"/><xs:field xpath="."/></xs:unique></xs:element>
          <xs:complexType name="T"><xs:sequence><xs:element name="B" type="xs:string" maxOccurs="9"/></xs:sequence></xs:complexType>`),
      ).toEqual(['unsupported-element', 'unsupported-identity-constraint']);
    });

    it('for XML Schema 1.1 assertions, open content and type alternatives', () => {
      expect(
        problemsOf(
          type(`><xs:openContent><xs:any/></xs:openContent>
            <xs:sequence><xs:element name="B" type="xs:int"><xs:alternative type="xs:string"/></xs:element></xs:sequence>
            <xs:assert test="B gt 0"/>`),
        ),
      ).toEqual(['unsupported-particle', 'unsupported-particle', 'unsupported-element']);
    });

    it('for an attribute of the xml namespace that no imported schema declares', () => {
      expect(
        problemsOf(`<xs:import namespace="http://www.w3.org/XML/1998/namespace"/>
          ${type('><xs:attribute ref="xml:lang"/>')}`),
      ).toEqual(['unknown-attribute']);
    });
  });

  describe('content models', () => {
    it('leave out particles with maxOccurs 0, since XML Schema does not allow them to occur', () => {
      // libxml2 accepts such elements anyway, so this is no case for the differential tests.
      const { schema: out, problems } = convert({
        files: {
          'a.xsd': schema(`<xs:element name="A"><xs:complexType><xs:sequence>
            <xs:element name="Kept" type="xs:string"/>
            <xs:element name="Gone" type="xs:string" minOccurs="0" maxOccurs="0"/>
            <xs:choice>
              <xs:element name="X" type="xs:string"/>
              <xs:sequence minOccurs="0" maxOccurs="0"><xs:element name="Y" type="xs:string"/></xs:sequence>
            </xs:choice>
          </xs:sequence></xs:complexType></xs:element>`),
        },
        entry: 'a.xsd',
      });
      expect(problems).toEqual([]);
      expect(Object.keys(out?.properties ?? {})).toEqual(['Kept', 'X']);
      expect(out?.oneOf).toEqual([{ required: ['X'] }]);
    });

    it('restrict the attributes of simple content without a problem', () => {
      const { schema: out, problems } = convert({
        files: {
          'a.xsd': schema(`<xs:element name="A" type="Required"/>
            <xs:complexType name="Amount"><xs:simpleContent><xs:extension base="xs:decimal">
              <xs:attribute name="currency" type="xs:string"/>
            </xs:extension></xs:simpleContent></xs:complexType>
            <xs:complexType name="Required"><xs:simpleContent><xs:restriction base="Amount">
              <xs:attribute name="currency" type="xs:string" use="required"/>
            </xs:restriction></xs:simpleContent></xs:complexType>`),
        },
        entry: 'a.xsd',
      });
      expect(problems).toEqual([]);
      expect(out?.required).toEqual(['currency', 'value']);
    });

    it('inherit the text and the attributes of a complex type with simple content', () => {
      const { schema: out, problems } = convert({
        files: {
          'a.xsd': schema(`<xs:element name="A" type="Limited"/>
            <xs:complexType name="Price"><xs:simpleContent><xs:extension base="xs:decimal">
              <xs:attribute name="currency" type="xs:string" use="required"/>
              <xs:attribute name="note" type="xs:string"/>
            </xs:extension></xs:simpleContent></xs:complexType>
            <xs:complexType name="Limited"><xs:simpleContent><xs:restriction base="Price">
              <xs:maxInclusive value="100"/><xs:attribute name="note" use="prohibited"/>
            </xs:restriction></xs:simpleContent></xs:complexType>`),
        },
        entry: 'a.xsd',
      });
      expect(codes(problems)).toEqual(['unsupported-simple-content']);
      expect(out?.properties).toEqual({
        currency: { type: 'string', xml: { attribute: true } },
        value: { type: 'number', xml: { text: true } },
      });
      expect(out?.required).toEqual(['currency', 'value']);
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
