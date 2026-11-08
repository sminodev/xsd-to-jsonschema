import { describe, expect, it } from 'vitest';
import { Problems } from './problems.js';
import { documentation, normalizePath, resolvePath, SchemaSet, xsChild } from './schema-set.js';

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function load(files: Record<string, string>, entry: string) {
  const problems = new Problems();
  const set = new SchemaSet(files, problems);
  const doc = set.load(entry);
  return { set, doc, problems: problems.list };
}

describe('paths', () => {
  it('resolve relative to the importing document', () => {
    expect(resolvePath('a.xsd', 'b.xsd')).toBe('b.xsd');
    expect(resolvePath('dir/a.xsd', '../b.xsd')).toBe('b.xsd');
    expect(resolvePath('dir/a.xsd', 'sub/./b.xsd')).toBe('dir/sub/b.xsd');
    expect(resolvePath('a.xsd', '../b.xsd')).toBe('../b.xsd');
    expect(resolvePath('dir/a.xsd', '..\\types\\b.xsd')).toBe('types/b.xsd');
  });

  it('keep absolute URIs and resolve relative paths against them', () => {
    expect(resolvePath('dir/a.xsd', 'http://example.org/s/b.xsd')).toBe('http://example.org/s/b.xsd');
    expect(resolvePath('http://example.org/s/b.xsd', '../t/c.xsd')).toBe('http://example.org/t/c.xsd');
    expect(normalizePath('https://example.org/s/b.xsd')).toBe('https://example.org/s/b.xsd');
    expect(normalizePath('/x/../y/z.xsd')).toBe('/y/z.xsd');
  });
});

describe('SchemaSet', () => {
  it('follows imports and includes and indexes the global components by expanded name', () => {
    const { set, doc, problems } = load(
      {
        'dir/main.xsd': `<xs:schema ${XS} targetNamespace="urn:m" elementFormDefault="qualified">
          <xs:import namespace="urn:o" schemaLocation="../other.xsd"/>
          <xs:include schemaLocation="part.xsd"/>
          <xs:element name="Root" type="xs:string"/>
        </xs:schema>`,
        'dir/part.xsd': `<xs:schema ${XS} targetNamespace="urn:m"><xs:simpleType name="Part"/></xs:schema>`,
        'other.xsd': `<xs:schema ${XS} targetNamespace="urn:o"><xs:complexType name="Other"/></xs:schema>`,
      },
      'dir/main.xsd',
    );
    expect(problems).toEqual([]);
    expect(doc?.elementQualified).toBe(true);
    expect([...set.documents.keys()]).toEqual(['dir/main.xsd', 'other.xsd', 'dir/part.xsd']);
    expect(set.lookup('element', { ns: 'urn:m', local: 'Root' })?.doc.path).toBe('dir/main.xsd');
    expect(set.lookup('simpleType', { ns: 'urn:m', local: 'Part' })).toBeDefined();
    expect(set.lookup('complexType', { ns: 'urn:o', local: 'Other' })).toBeDefined();
  });

  it('reports missing files, documents that are no XML or no XML Schema, and duplicates', () => {
    const { problems } = load(
      {
        'a.xsd': `<xs:schema ${XS}>\n<xs:import schemaLocation="gone.xsd"/>\n<xs:include schemaLocation="b.xsd"/>
          <xs:import schemaLocation="broken.xsd"/><xs:import schemaLocation="plain.xml"/>
          <xs:simpleType name="T"/></xs:schema>`,
        'b.xsd': `<xs:schema ${XS}><xs:simpleType name="T"/></xs:schema>`,
        'broken.xsd': '<xs:schema',
        'plain.xml': '<a/>',
      },
      'a.xsd',
    );
    expect(problems.map((p) => p.code)).toEqual(['missing-file', 'invalid-xml', 'not-a-schema', 'duplicate-component']);
    expect(problems[0]).toMatchObject({ file: 'a.xsd', line: 2, message: 'schema document gone.xsd not found' });
  });

  it('reports an include into another target namespace and xs:redefine, which it does not apply', () => {
    const { problems } = load(
      {
        'a.xsd': `<xs:schema ${XS} targetNamespace="urn:a">
          <xs:include schemaLocation="plain.xsd"/>
          <xs:redefine schemaLocation="plain.xsd"/>
        </xs:schema>`,
        'plain.xsd': `<xs:schema ${XS}><xs:simpleType name="T"/></xs:schema>`,
      },
      'a.xsd',
    );
    expect(problems).toEqual([
      expect.objectContaining({ code: 'unsupported-include', line: 2 }),
      expect.objectContaining({ code: 'unsupported-redefine', line: 3 }),
    ]);
  });

  it('resolves QNames with the namespaces in scope, including the default namespace', () => {
    const { set, doc, problems } = load(
      { 'a.xsd': `<xs:schema ${XS} xmlns="urn:d" xmlns:p="urn:p"><xs:element name="E" type="T"/></xs:schema>` },
      'a.xsd',
    );
    const element = xsChild(doc!.root, 'element')!;
    expect(set.resolveQName(element, 'T')).toEqual({ ns: 'urn:d', local: 'T' });
    expect(set.resolveQName(element, 'p:T')).toEqual({ ns: 'urn:p', local: 'T' });
    expect(set.resolveQName(element, 'xs:string')).toEqual({ ns: 'http://www.w3.org/2001/XMLSchema', local: 'string' });
    expect(set.resolveQName(element, 'q:T')).toEqual({ ns: '', local: 'T' });
    expect(problems.map((p) => p.code)).toEqual(['unknown-prefix']);
  });
});

describe('documentation', () => {
  it('joins the lines of a paragraph and keeps paragraphs apart', () => {
    const { doc } = load(
      {
        'a.xsd': `<xs:schema ${XS}><xs:element name="E"><xs:annotation><xs:documentation>First
          line   continues.

          Second paragraph.</xs:documentation></xs:annotation></xs:element></xs:schema>`,
      },
      'a.xsd',
    );
    expect(documentation(xsChild(doc!.root, 'element')!)).toBe('First line continues.\n\nSecond paragraph.');
  });
});
