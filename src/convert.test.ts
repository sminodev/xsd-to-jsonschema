import { describe, expect, it } from 'vitest';
import { convert } from './convert.js';
import type { JsonSchema } from './json-schema.js';
import type { Problem } from './problems.js';
import { ajvFor } from './test-support/oracle.js';
import { xmlToJson } from './test-support/xml-to-json.js';

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
      expect(out?.xml).toEqual({ name: 'B', namespace: 'urn:t', type: '{http://www.w3.org/2001/XMLSchema}integer' });
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

    it('can explicitly select a global element from an imported schema', () => {
      const { schema: out, problems } = convert({
        files: {
          'entry.xsd': schema('<xs:import namespace="urn:other" schemaLocation="other.xsd"/>'),
          'other.xsd': schema('<xs:element name="Imported" type="xs:integer"/>', 'urn:other'),
        },
        entry: 'entry.xsd',
        root: '{urn:other}Imported',
      });
      expect(problems).toEqual([]);
      expect(out?.type).toBe('integer');
      expect(out?.xml).toEqual({
        name: 'Imported',
        namespace: 'urn:other',
        type: '{http://www.w3.org/2001/XMLSchema}integer',
      });
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
      expect(out?.$defs?.['Code']).toEqual({
        type: 'string',
        minLength: 2,
        maxLength: 2,
        xml: { type: '{urn:o}Code' },
      });
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
      expect(out?.$defs?.['Code']).toEqual({
        type: 'string',
        minLength: 2,
        maxLength: 2,
        xml: { type: '{urn:o}Code' },
      });
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
        xml: { namespace: 'urn:t', whiteSpace: 'collapse', type: '{http://www.w3.org/2001/XMLSchema}date' },
      });
    });

    it('leave out the xml annotations with xml: false', () => {
      const { schema: out } = convert({ files, entry: 'a.xsd', options: { xml: false } });
      expect(JSON.stringify(out)).not.toContain('"xml"');
      expect(out?.properties?.['B']).toEqual({
        type: 'string',
        contentEncoding: 'base64',
        pattern: expect.any(String) as string,
      });
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
      expect(problemsOf(type(' mixed="true"><xs:sequence><xs:element name="B"/></xs:sequence>'))).toEqual([
        'unsupported-mixed',
      ]);
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
            '><xs:sequence><xs:element name="B" type="xs:string"/></xs:sequence><xs:attribute name="B" type="xs:string"/>',
          ),
        ),
      ).toEqual(['duplicate-name']);
      expect(
        problemsOf(
          type(
            '><xs:sequence><xs:element name="B" type="xs:string"/><xs:element name="B" type="xs:integer"/></xs:sequence>',
          ),
        ),
      ).toEqual(['duplicate-name']);
      expect(problemsOf(type('><xs:complexContent><xs:restriction base="Missing"/></xs:complexContent>'))).toEqual([
        'unknown-type',
      ]);
    });

    it('and still write a schema a validator can compile', () => {
      const schemas = [
        type(
          '><xs:sequence><xs:element name="B" type="xs:string"/><xs:element name="C" type="xs:string"/><xs:element name="B" type="xs:integer"/></xs:sequence>',
        ),
        type(
          '><xs:sequence><xs:element name="B" type="xs:string"/></xs:sequence><xs:attribute name="B" type="xs:string" use="required"/>',
        ),
        type(
          '><xs:choice><xs:sequence><xs:element name="B" type="xs:string"/><xs:element name="B" type="xs:integer"/></xs:sequence><xs:element name="C" type="xs:string"/></xs:choice>',
        ),
      ];
      for (const body of schemas) {
        const { schema: out, problems } = convert({ files: { 'a.xsd': schema(body) }, entry: 'a.xsd', root: 'A' });
        expect(codes(problems)).toEqual(['duplicate-name']);
        expect(() => ajvFor(out as JsonSchema)).not.toThrow();
      }
    });

    it('for attributes of one local name in two namespaces, keeping the first', () => {
      const { schema: out, problems } = convert({
        files: {
          'a.xsd': schema(
            '<xs:attribute name="id" type="xs:integer"/>' +
              '<xs:element name="A"><xs:complexType><xs:attribute ref="t:id" use="required"/>' +
              '<xs:attribute name="id" type="xs:string" form="unqualified"/></xs:complexType></xs:element>',
          ),
        },
        entry: 'a.xsd',
        root: 'A',
      });
      expect(codes(problems)).toEqual(['duplicate-name']);
      expect(out?.properties?.['id']).toMatchObject({ type: 'integer' });
      expect(out?.required).toEqual(['id']);
    });

    it('keeps inherited attributes apart by namespace', () => {
      const { schema: out, problems } = convert({
        files: {
          'a.xsd': schema(
            '<xs:attribute name="id" type="xs:integer"/>' +
              '<xs:complexType name="Base"><xs:attribute ref="t:id"/></xs:complexType>' +
              '<xs:complexType name="Sub"><xs:complexContent><xs:extension base="Base">' +
              '<xs:attribute name="id" type="xs:string" form="unqualified"/></xs:extension></xs:complexContent></xs:complexType>' +
              '<xs:element name="A" type="Sub"/>',
          ),
        },
        entry: 'a.xsd',
        root: 'A',
      });
      expect(codes(problems)).toEqual(['duplicate-name']);
      expect(out?.properties?.['id']).toMatchObject({ type: 'integer' });
    });

    it('for numbers a JSON number cannot hold exactly', () => {
      const big = '9223372036854775807';
      const restricted = (facets: string) =>
        `<xs:element name="A"><xs:simpleType><xs:restriction base="xs:long">${facets}</xs:restriction></xs:simpleType></xs:element>`;
      expect(problemsOf(restricted(`<xs:maxInclusive value="${big}"/>`))).toEqual(['rounded-number']);
      expect(problemsOf(restricted(`<xs:enumeration value="${big}"/>`))).toEqual(['rounded-number']);
      expect(problemsOf(`<xs:element name="A" type="xs:long" fixed="${big}"/>`)).toEqual(['rounded-number']);
      expect(problemsOf(`<xs:element name="A" type="xs:decimal" fixed="12.50"/>`)).toEqual([]);
      expect(problemsOf(restricted('<xs:maxInclusive value="9007199254740991"/>'))).toEqual([]);
    });

    it('for enumeration values outside the base enumeration', () => {
      const body = (derived: string) =>
        '<xs:simpleType name="Base"><xs:restriction base="xs:integer"><xs:enumeration value="1"/><xs:enumeration value="2"/></xs:restriction></xs:simpleType>' +
        `<xs:element name="A"><xs:simpleType><xs:restriction base="Base">${derived}</xs:restriction></xs:simpleType></xs:element>`;
      const run = (derived: string) =>
        convert({ files: { 'a.xsd': schema(body(derived)) }, entry: 'a.xsd', root: 'A' });
      const partly = run('<xs:enumeration value="01"/><xs:enumeration value="3"/>');
      expect(codes(partly.problems)).toEqual(['invalid-facet']);
      expect(partly.schema?.enum).toEqual([1]);
      const none = run('<xs:enumeration value="3"/>');
      expect(codes(none.problems)).toEqual(['invalid-facet']);
      expect(none.schema?.not).toEqual({});
      expect(() => ajvFor(none.schema as JsonSchema)).not.toThrow();
    });

    it('with the position of a named union member', () => {
      const { problems } = convert({
        files: {
          'a.xsd': schema(
            '<xs:simpleType name="L">\n<xs:restriction base="xs:string"><xs:pattern value="\\p{IsBasicLatin}"/></xs:restriction></xs:simpleType>\n' +
              '<xs:simpleType name="U"><xs:union memberTypes="L xs:string"/></xs:simpleType><xs:element name="A" type="U"/>',
          ),
        },
        entry: 'a.xsd',
        root: 'A',
      });
      expect(problems).toEqual([expect.objectContaining({ code: 'untranslatable-pattern', file: 'a.xsd', line: 2 })]);
    });

    it('give an element the derived types that xsi:type can select, unless a block attribute forbids it', () => {
      const types =
        '<xs:complexType name="Base"><xs:sequence><xs:element name="x" type="xs:string"/></xs:sequence></xs:complexType>' +
        '<xs:complexType name="Wide"><xs:complexContent><xs:extension base="Base"><xs:sequence>' +
        '<xs:element name="y" type="xs:string"/></xs:sequence></xs:extension></xs:complexContent></xs:complexType>' +
        '<xs:complexType name="Wider"><xs:complexContent><xs:extension base="Wide"/></xs:complexContent></xs:complexType>';
      const run = (element: string, extra = '') =>
        convert({
          files: { 'a.xsd': schema(`${types}${element}`).replace('<xs:schema ', `<xs:schema ${extra} `) },
          entry: 'a.xsd',
          root: 'A',
        });
      const branches = (out: JsonSchema | undefined) =>
        out?.anyOf?.map((branch) => branch.$ref ?? (branch.properties?.['#type'] as JsonSchema | undefined)?.const);
      const open = run('<xs:element name="A" type="Base"/>');
      expect(open.problems).toEqual([]);
      expect(branches(open.schema)).toEqual(['{urn:t}Base', '#/$defs/Wide', '#/$defs/Wider']);
      expect(open.schema?.anyOf?.[1]).toEqual({ $ref: '#/$defs/Wide', type: 'object', required: ['#type'] });
      expect(open.schema?.$defs?.['Wide']?.properties?.['#type']).toEqual({
        const: '{urn:t}Wide',
        xml: { xsiType: true },
      });
      expect(run('<xs:element name="A" type="Base" block="extension"/>').schema).not.toHaveProperty('anyOf');
      expect(run('<xs:element name="A" type="Base"/>', 'blockDefault="#all"').schema).not.toHaveProperty('anyOf');
      expect(branches(run('<xs:element name="A" type="Wide"/>').schema)).toEqual(['{urn:t}Wide', '#/$defs/Wider']);
      expect(run('<xs:element name="A" type="Wider"/>').schema).not.toHaveProperty('anyOf');
    });

    it('for an element of an abstract type that no type derives from', () => {
      const { problems } = convert({
        files: {
          'a.xsd': schema(
            '<xs:complexType name="Shape" abstract="true"><xs:sequence><xs:element name="id" type="xs:string"/></xs:sequence></xs:complexType>' +
              '<xs:element name="A"><xs:complexType><xs:sequence><xs:element name="S" type="Shape"/></xs:sequence></xs:complexType></xs:element>',
          ),
        },
        entry: 'a.xsd',
        root: 'A',
      });
      expect(codes(problems)).toEqual(['unsupported-element']);
      expect(problems[0]?.message).toContain('abstract type Shape');
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

    it('for an abstract substitution group head without members, and not for heads with members', () => {
      const body = `<xs:element name="Shape" type="xs:string"/>
        <xs:element name="Circle" type="xs:string" substitutionGroup="t:Shape"/>
        <xs:element name="Lonely" type="xs:string" abstract="true"/>`;
      const uses = (ref: string) => type(`><xs:sequence><xs:element ref="${ref}"/></xs:sequence>`);
      const head = convert({ files: { 'a.xsd': schema(uses('Shape') + body) }, entry: 'a.xsd', root: 'A' });
      expect(head.problems).toEqual([]);
      expect(Object.keys(head.schema?.properties ?? {})).toEqual(['Shape', 'Circle']);
      expect(problemsOf(uses('Circle') + body)).toEqual([]);
      expect(problemsOf(uses('Lonely') + body)).toEqual(['unsupported-element']);
    });

    it('for identity constraints, also on a root with a named type', () => {
      expect(
        problemsOf(`<xs:element name="A" type="T" nillable="true">
          <xs:unique name="u"><xs:selector xpath="t:B"/><xs:field xpath="."/></xs:unique></xs:element>
          <xs:complexType name="T"><xs:sequence><xs:element name="B" type="xs:string" maxOccurs="9"/></xs:sequence></xs:complexType>`),
      ).toEqual(['unsupported-identity-constraint']);
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
      expect(problems).toEqual([]);
      expect(out?.properties).toEqual({
        '#type': { const: '{urn:t}Limited', xml: { xsiType: true } },
        currency: { type: 'string', xml: { attribute: true } },
        value: { type: 'number', maximum: 100, xml: { text: true } },
      });
      expect(out?.required).toEqual(['currency', 'value']);
    });
  });

  describe('values', () => {
    it.each(['fixed', 'default'])('reports a non-finite numeric %s instead of emitting null', (kind) => {
      const { schema: out, problems } = convert({
        files: { 'a.xsd': schema(`<xs:element name="A" type="xs:double" ${kind}="1e999"/>`) },
        entry: 'a.xsd',
      });
      expect(problems).toMatchObject([{ code: 'invalid-value', severity: 'error', file: 'a.xsd' }]);
      expect(out?.type).toBe('number');
      expect(out).not.toHaveProperty(kind === 'fixed' ? 'const' : 'default');
    });

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
      expect(out?.$defs?.['Level']).toEqual({ type: 'integer', enum: [1, 2], xml: { type: '{urn:t}Level' } });
      expect(out?.properties?.['N']).toMatchObject({ const: 2 });
      expect(out?.properties?.['B']).toMatchObject({ default: true });
    });
  });

  describe('whitespace', () => {
    const files = {
      'a.xsd': schema(`<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="Str" type="xs:string"/>
          <xs:element name="Norm" type="xs:normalizedString"/>
          <xs:element name="Tok" type="xs:token" maxOccurs="2"/>
          <xs:element name="Lang" type="xs:language"/>
          <xs:element name="Uri" type="xs:anyURI"/>
          <xs:element name="Num" type="xs:decimal"/>
          <xs:element name="Flag" type="xs:boolean"/>
          <xs:element name="Day" type="xs:date"/>
          <xs:element name="Facet" type="Squeezed"/>
          <xs:element name="Same" type="SameUnion"/>
          <xs:element name="Mixed" type="MixedUnion"/>
          <xs:element name="Numbers" type="NumberUnion"/>
          <xs:element name="Items" type="Items"/>
          <xs:element name="Text"><xs:complexType><xs:simpleContent>
            <xs:extension base="xs:token"><xs:attribute name="note" type="xs:string"/></xs:extension>
          </xs:simpleContent></xs:complexType></xs:element>
        </xs:sequence>
        <xs:attribute name="key" type="xs:NMTOKEN"/>
        </xs:complexType></xs:element>
        <xs:simpleType name="Squeezed"><xs:restriction base="xs:string"><xs:whiteSpace value="collapse"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="SameUnion"><xs:union memberTypes="Short xs:date"/></xs:simpleType>
        <xs:simpleType name="Short"><xs:restriction base="xs:token"><xs:maxLength value="3"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="MixedUnion"><xs:union memberTypes="xs:token xs:string"/></xs:simpleType>
        <xs:simpleType name="NumberUnion"><xs:union memberTypes="xs:integer xs:decimal"/></xs:simpleType>
        <xs:simpleType name="Items"><xs:list itemType="xs:integer"/></xs:simpleType>`),
    };
    const whiteSpace = (out: JsonSchema | undefined, key: string) => {
      const p = out?.properties?.[key] as JsonSchema;
      const target = p.$ref ? out?.$defs?.[p.$ref.slice('#/$defs/'.length)] : p.type === 'array' ? p.items : p;
      return target?.xml?.whiteSpace;
    };

    it('records replace and collapse on the string values XML normalizes, and nothing else', () => {
      const { schema: out } = convert({ files, entry: 'a.xsd' });
      const keys = ['Str', 'Norm', 'Tok', 'Lang', 'Uri', 'Num', 'Flag', 'Day', 'Facet', 'Same', 'Mixed', 'Numbers'];
      expect(Object.fromEntries(keys.map((key) => [key, whiteSpace(out, key)]))).toEqual({
        Str: undefined,
        Norm: 'replace',
        Tok: 'collapse',
        Lang: 'collapse',
        Uri: 'collapse',
        Num: undefined,
        Flag: undefined,
        Day: 'collapse',
        Facet: 'collapse',
        Same: 'collapse',
        Mixed: undefined,
        Numbers: undefined,
      });
      // Next to the other members of a property, on items for an array, and on attributes, lists and simple content.
      expect(out?.properties?.['Tok']).toMatchObject({ items: { xml: { whiteSpace: 'collapse' } } });
      expect(out?.properties?.['Uri']).toMatchObject({ xml: { namespace: 'urn:t', whiteSpace: 'collapse' } });
      expect(out?.properties?.['key']).toMatchObject({ xml: { attribute: true, whiteSpace: 'collapse' } });
      expect(out?.$defs?.['Items']).toEqual({
        type: 'array',
        items: { type: 'integer' },
        xml: { list: true, type: '{urn:t}Items' },
      });
      const text = out?.properties?.['Text'] as JsonSchema;
      expect(text.properties?.['value']).toMatchObject({ xml: { text: true, whiteSpace: 'collapse' } });
      expect(text.properties?.['note']).toEqual({ type: 'string', xml: { attribute: true } });
      // Each union member keeps its own, as XML normalizes the text for each member; members that normalize
      // differently keep their branches even when one of them accepts every string.
      expect(out?.$defs?.['SameUnion']?.anyOf?.map((m) => m.xml?.whiteSpace)).toEqual(['collapse', 'collapse']);
      expect(out?.$defs?.['MixedUnion']).toEqual({
        type: 'string',
        anyOf: [{ type: 'string', xml: { whiteSpace: 'collapse' } }, { type: 'string' }],
        xml: { type: '{urn:t}MixedUnion' },
      });
    });

    it('normalizes enumeration, fixed and default values like the text they are compared with', () => {
      const { schema: out } = convert({
        files: {
          'b.xsd': schema(`<xs:element name="A"><xs:complexType><xs:sequence>
              <xs:element name="Fixed" type="xs:token" fixed=" x  y "/>
              <xs:element name="Default" type="xs:normalizedString" default="a\tb" minOccurs="0"/>
              <xs:element name="Kept" type="xs:string" fixed=" x "/>
              <xs:element name="Picked" type="Picked"/>
            </xs:sequence></xs:complexType></xs:element>
            <xs:simpleType name="Picked"><xs:restriction base="Union"><xs:enumeration value=" ab "/></xs:restriction></xs:simpleType>
            <xs:simpleType name="Union"><xs:union memberTypes="xs:token xs:date"/></xs:simpleType>`),
        },
        entry: 'b.xsd',
      });
      expect(out?.properties?.['Fixed']).toMatchObject({ const: 'x y' });
      expect(out?.properties?.['Default']).toMatchObject({ default: 'a b' });
      expect(out?.properties?.['Kept']).toMatchObject({ const: ' x ' });
      expect(out?.$defs?.['Picked']).toMatchObject({ enum: ['ab'], xml: { whiteSpace: 'collapse' } });
    });

    it('records it in format mode and leaves it out with xml: false', () => {
      const format = convert({ files, entry: 'a.xsd', options: { dateTime: 'format' } }).schema;
      expect(format?.properties?.['Day']).toMatchObject({ format: 'date', xml: { whiteSpace: 'collapse' } });
      const plain = convert({ files, entry: 'a.xsd', options: { xml: false } }).schema;
      expect(JSON.stringify(plain)).not.toContain('whiteSpace');
    });
  });

  describe('descriptions', () => {
    const doc = (text: string) => `<xs:annotation><xs:documentation>${text}</xs:documentation></xs:annotation>`;
    const files = {
      'a.xsd': schema(`<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="List" type="Item" maxOccurs="3">${doc('element List')}</xs:element>
          <xs:element name="One" type="Item">${doc('element One')}</xs:element>
          <xs:element name="Anonymous" maxOccurs="2">${doc('element Anonymous')}<xs:complexType>${doc('anonymous type')}
            <xs:sequence><xs:element name="N" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
          <xs:element name="Undocumented"><xs:complexType>${doc('undocumented element type')}
            <xs:sequence><xs:element name="N" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
        </xs:sequence>
        <xs:attribute name="own" type="Code">${doc('attribute own')}</xs:attribute>
        <xs:attribute name="bare" type="Code"/>
        <xs:attribute ref="t:global"/>
        </xs:complexType></xs:element>
        <xs:attribute name="global" type="Code">${doc('global attribute')}</xs:attribute>
        <xs:complexType name="Item">${doc('type Item')}<xs:sequence><xs:element name="N" type="xs:string"/></xs:sequence></xs:complexType>
        <xs:simpleType name="Code">${doc('type Code')}<xs:restriction base="xs:string"/></xs:simpleType>`),
    };

    it('put the declaration documentation on the property and keep the type documentation with the type', () => {
      const { schema: out, problems } = convert({ files, entry: 'a.xsd' });
      expect(problems).toEqual([]);
      const p = (key: string) => out?.properties?.[key] as JsonSchema;
      expect(p('List')).toMatchObject({ description: 'element List', type: 'array', items: { $ref: '#/$defs/Item' } });
      expect(p('List').items).not.toHaveProperty('description');
      expect(p('One')).toMatchObject({ description: 'element One', $ref: '#/$defs/Item' });
      expect(out?.$defs?.['Item']?.description).toBe('type Item');
      expect(p('Anonymous')).toMatchObject({
        description: 'element Anonymous',
        items: { description: 'anonymous type' },
      });
      expect(p('Undocumented').description).toBe('undocumented element type');
      expect(p('own')).toMatchObject({ description: 'attribute own', $ref: '#/$defs/Code' });
      expect(p('bare')).not.toHaveProperty('description');
      expect(p('global')).toMatchObject({ description: 'global attribute' });
      expect(out?.$defs?.['Code']?.description).toBe('type Code');
    });
  });

  describe('values that XML checks more closely', () => {
    const run = (body: string, root = 'A') => convert({ files: { 'a.xsd': schema(body) }, entry: 'a.xsd', root });

    it('warn once per type that the prefix of a QName is not checked', () => {
      const { schema: out, problems } = run(
        `<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="Q" type="xs:QName"/><xs:element name="R" type="Name"/><xs:element name="S" type="Name"/>
        </xs:sequence><xs:attribute name="q" type="xs:QName"/></xs:complexType></xs:element>
        <xs:simpleType name="Name"><xs:restriction base="xs:QName"><xs:pattern value="t:.*"/></xs:restriction></xs:simpleType>`,
      );
      expect(problems.map((p) => `${p.code} ${p.line}`)).toEqual([
        'unchecked-qname-prefix 2',
        'unchecked-qname-prefix 3',
        'unchecked-qname-prefix 4',
      ]);
      expect(problems.every((p) => p.severity === 'warning')).toBe(true);
      // The syntax is still checked.
      const validate = ajvFor(out ?? {});
      expect(validate({ Q: 'p:a', R: 't:a', S: 't:b', q: 'a' })).toBe(true);
      expect(validate({ Q: 'p:a:b', R: 't:a', S: 't:b' })).toBe(false);
    });

    it('give the items of IDREFS and ENTITIES the NCName pattern, and NMTOKENS any name characters', () => {
      // The JSON comes from XML, so that the test holds whatever JSON form a list has.
      const { schema: out } = run(
        `<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="I" type="xs:IDREFS"/><xs:element name="E" type="xs:ENTITIES"/>
          <xs:element name="N" type="xs:NMTOKENS"/><xs:element name="One" type="xs:ENTITY"/>
        </xs:sequence></xs:complexType></xs:element>`,
      );
      const validate = ajvFor(out ?? {});
      const value = { I: 'a b', E: 'c', N: '1 :x', One: 'd' };
      const document = (values: Record<string, string>) =>
        `<A xmlns="urn:t">${Object.entries(values)
          .map(([key, text]) => `<${key}>${text}</${key}>`)
          .join('')}</A>`;
      expect(validate(xmlToJson(out ?? {}, document(value)))).toBe(true);
      for (const [key, bad] of [
        ['I', 'a 1x'],
        ['I', 'a p:b'],
        ['E', '-c'],
        ['One', '1d'],
        ['N', 'a b!'],
      ] as const) {
        expect(validate(xmlToJson(out ?? {}, document({ ...value, [key]: bad }))), `${key}: ${bad}`).toBe(false);
      }
    });

    it('report a whiteSpace facet that relaxes the whiteSpace of its base', () => {
      const { problems } = run(
        '<xs:element name="A"><xs:simpleType><xs:restriction base="xs:token"><xs:whiteSpace value="preserve"/></xs:restriction></xs:simpleType></xs:element>',
      );
      expect(problems).toMatchObject([
        { code: 'invalid-facet', message: 'whiteSpace preserve cannot relax the collapse of its base' },
      ]);
    });

    it('normalize fixed, default and enumeration values of a union as the member that accepts them first', () => {
      const { schema: out, problems } = run(
        `<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="F" type="DateOrEmpty" fixed=" 2026-11-11 "/>
          <xs:element name="D" type="DateOrEmpty" default=" "/>
          <xs:element name="E" type="Picked"/>
        </xs:sequence></xs:complexType></xs:element>
        <xs:simpleType name="Empty"><xs:restriction base="xs:string"><xs:maxLength value="0"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="DateOrEmpty"><xs:union memberTypes="xs:date Empty"/></xs:simpleType>
        <xs:simpleType name="Picked"><xs:restriction base="DateOrEmpty">
          <xs:enumeration value=" 2026-11-11 "/><xs:enumeration value=""/>
        </xs:restriction></xs:simpleType>`,
      );
      expect(codes(problems)).toEqual([]);
      const p = (key: string) => out?.properties?.[key] as JsonSchema;
      expect(p('F').const).toBe('2026-11-11');
      // No member accepts a single space: it stays as the first member normalizes it.
      expect(p('D').default).toBe('');
      expect(out?.$defs?.['Picked']).toMatchObject({ enum: ['2026-11-11', ''] });
      expect(out?.$defs?.['Picked']?.anyOf?.map((m) => m.xml?.whiteSpace)).toEqual(['collapse', undefined]);
    });

    it('pick the member of a union for a fixed value by its pattern, also in format mode', () => {
      const body = `<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="F" type="DateOrText" fixed=" x "/><xs:element name="G" type="DateOrText" fixed=" 2026-11-11 "/>
        </xs:sequence></xs:complexType></xs:element>
        <xs:simpleType name="DateOrText"><xs:union memberTypes="xs:date xs:string"/></xs:simpleType>`;
      for (const dateTime of ['pattern', 'format'] as const) {
        const { schema: out } = convert({ files: { 'a.xsd': schema(body) }, entry: 'a.xsd', options: { dateTime } });
        expect((out?.properties?.['F'] as JsonSchema).const, dateTime).toBe(' x ');
        expect((out?.properties?.['G'] as JsonSchema).const, dateTime).toBe('2026-11-11');
      }
    });

    it('warn about mixed content only where it can hold elements, inherited ones included', () => {
      const mixed = (content: string, extra = '') =>
        codes(
          run(
            `<xs:element name="A" type="M"/><xs:complexType name="M" mixed="true">${content}</xs:complexType>
            <xs:complexType name="Base"><xs:sequence><xs:element name="B"/></xs:sequence></xs:complexType>
            <xs:group name="None"><xs:sequence/></xs:group>${extra}`,
          ).problems,
        );
      expect(mixed('')).toEqual([]);
      expect(mixed('<xs:sequence><xs:group ref="None"/></xs:sequence>')).toEqual([]);
      expect(mixed('<xs:sequence><xs:element name="B" maxOccurs="0"/></xs:sequence>')).toEqual([]);
      expect(mixed('<xs:attribute name="a" type="xs:string"/>')).toEqual([]);
      expect(mixed('<xs:sequence><xs:any/></xs:sequence>')).toEqual(['unsupported-mixed']);
      expect(mixed('<xs:complexContent><xs:extension base="Base"/></xs:complexContent>')).toEqual([
        'unsupported-mixed',
      ]);
      expect(mixed('<xs:complexContent><xs:restriction base="xs:anyType"/></xs:complexContent>')).toEqual([]);
    });

    it('report the facets of a simpleContent restriction that are not supported', () => {
      const { schema: out, problems } = run(
        `<xs:element name="A" type="Late"/>
        <xs:complexType name="Day"><xs:simpleContent><xs:extension base="xs:dateTime"/></xs:simpleContent></xs:complexType>
        <xs:complexType name="Late"><xs:simpleContent><xs:restriction base="Day">
          <xs:minInclusive value="2026-01-01T00:00:00"/><xs:maxLength value="30"/>
        </xs:restriction></xs:simpleContent></xs:complexType>`,
      );
      expect(problems).toMatchObject([
        { code: 'unsupported-bound', message: expect.stringContaining('minInclusive') as string },
      ]);
      expect(out?.properties?.['value']).toMatchObject({ type: 'string', maxLength: 30, xml: { text: true } });
    });
  });

  describe('lists, nil and wildcards', () => {
    const run = (body: string, options = {}) =>
      convert({ files: { 'a.xsd': schema(body) }, entry: 'a.xsd', root: 'A', options });

    it('report a pattern on a list and give its items their own facets', () => {
      const { schema: out, problems } = run(
        `<xs:element name="A" type="Codes"/>
        <xs:simpleType name="Code"><xs:restriction base="xs:string"><xs:pattern value="[A-Z]{2}"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Codes"><xs:restriction><xs:simpleType><xs:list itemType="Code"/></xs:simpleType>
          <xs:pattern value="[A-Z ]*"/><xs:length value="2"/></xs:restriction></xs:simpleType>`,
      );
      expect(codes(problems)).toEqual(['unsupported-list-pattern']);
      expect(out?.$defs?.['Codes']).toEqual({
        type: 'array',
        items: { type: 'string', pattern: '^(?:[A-Z]{2})$' },
        minItems: 2,
        maxItems: 2,
        xml: { list: true, type: '{urn:t}Codes' },
      });
    });

    it('write the nil forms of a nillable element: null, and an object with the attributes and a null text', () => {
      const { schema: out, problems } = run(
        `<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="S" type="xs:int" nillable="true"/>
          <xs:element name="O" nillable="true" maxOccurs="2"><xs:complexType>
            <xs:sequence><xs:element name="C" type="xs:string"/></xs:sequence>
            <xs:attribute name="k" type="xs:string" use="required"/>
          </xs:complexType></xs:element>
          <xs:element name="V" nillable="true"><xs:complexType>
            <xs:attribute name="value" type="xs:string"/>
          </xs:complexType></xs:element>
        </xs:sequence></xs:complexType></xs:element>`,
      );
      expect(problems).toMatchObject([
        { code: 'duplicate-name', message: expect.stringContaining('nil form of V') as string },
      ]);
      const p = (key: string) => out?.properties?.[key] as JsonSchema;
      expect(p('S')).toEqual({
        anyOf: [
          {
            type: 'integer',
            minimum: -2147483648,
            maximum: 2147483647,
            xml: { type: '{http://www.w3.org/2001/XMLSchema}int' },
          },
          { type: 'null' },
        ],
        xml: { namespace: 'urn:t', nillable: true },
      });
      // A required attribute rules out null; the nil form is on the items of an array.
      expect(p('O').items?.anyOf?.[1]).toEqual({
        type: 'object',
        properties: { k: { type: 'string', xml: { attribute: true } }, value: { type: 'null', xml: { text: true } } },
        required: ['k', 'value'],
        additionalProperties: false,
      });
      expect(p('O').items?.anyOf).toHaveLength(2);
      expect(p('O').items?.xml).toEqual({ nillable: true });
      expect(p('V').anyOf?.map((form) => form.type)).toEqual(['object', 'null']);
    });

    it('leave out list, nil and wildcard annotations with xml: false', () => {
      const { schema: out } = run(
        `<xs:element name="A"><xs:complexType><xs:sequence>
          <xs:element name="L" type="xs:NMTOKENS" nillable="true"/><xs:any namespace="##other"/>
        </xs:sequence><xs:anyAttribute/></xs:complexType></xs:element>`,
        { xml: false },
      );
      expect(JSON.stringify(out)).not.toContain('"xml"');
      expect(out?.properties?.['L']).toMatchObject({ anyOf: [{ type: 'array', minItems: 1 }, { type: 'null' }] });
      expect(out).not.toHaveProperty('additionalProperties');
    });

    it('mark objects with wildcards, also in repeated groups and through extension', () => {
      const { schema: out } = run(
        `<xs:element name="A" type="Wide"/>
        <xs:complexType name="Base"><xs:sequence><xs:any namespace="##other" processContents="lax"/></xs:sequence>
          <xs:anyAttribute/></xs:complexType>
        <xs:complexType name="Wide"><xs:complexContent><xs:extension base="Base"><xs:sequence maxOccurs="2">
          <xs:element name="B" type="xs:string"/><xs:any namespace="##other" processContents="skip"/>
        </xs:sequence></xs:extension></xs:complexContent></xs:complexType>`,
      );
      expect(out?.xml).toEqual({ name: 'A', namespace: 'urn:t', anyElement: true, anyAttribute: true });
      expect((out?.properties?.['#sequence'] as JsonSchema).items?.xml).toEqual({ anyElement: true });
    });
  });
});
