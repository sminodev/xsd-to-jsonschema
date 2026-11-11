import { describe, expect, it } from 'vitest';
import { Problems } from './problems.js';
import { documentation, type Limits, normalizePath, resolvePath, SchemaSet, xsChild } from './schema-set.js';

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function load(files: Record<string, string>, entry: string, limits?: Limits) {
  const problems = new Problems();
  const set = new SchemaSet(files, problems, limits);
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
  it('keeps the entry path when a schema is missing or its reader throws', () => {
    expect(load({}, 'missing.xsd').problems).toEqual([
      expect.objectContaining({ code: 'missing-file', file: 'missing.xsd' }),
    ]);
    const problems = new Problems();
    const set = new SchemaSet(() => {
      throw new Error('EACCES');
    }, problems);
    expect(set.load('blocked.xsd')).toBeUndefined();
    expect(problems.list).toEqual([expect.objectContaining({ code: 'missing-file', file: 'blocked.xsd' })]);
    expect(problems.list[0]?.message).toContain('EACCES');
  });

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

  it('reports an include or a redefine of another target namespace', () => {
    const { problems } = load(
      {
        'a.xsd': `<xs:schema ${XS} targetNamespace="urn:a">
          <xs:include schemaLocation="b.xsd"/>
          <xs:redefine schemaLocation="b.xsd"/>
        </xs:schema>`,
        'b.xsd': `<xs:schema ${XS} targetNamespace="urn:b"><xs:simpleType name="T"/></xs:schema>`,
      },
      'a.xsd',
    );
    expect(problems).toEqual([
      expect.objectContaining({ code: 'unsupported-include', line: 2 }),
      expect.objectContaining({ code: 'unsupported-include', line: 3 }),
    ]);
  });

  it('replaces groups and attribute groups in xs:redefine; a reference to the own name means the replaced one', () => {
    const { set, problems } = load(
      {
        'a.xsd': `<xs:schema ${XS} targetNamespace="urn:a">
          <xs:redefine schemaLocation="b.xsd">
            <xs:group name="G"><xs:sequence><xs:group ref="G"/><xs:element name="x"/></xs:sequence></xs:group>
            <xs:attributeGroup name="AG"><xs:attributeGroup ref="AG"/></xs:attributeGroup>
          </xs:redefine>
        </xs:schema>`,
        'b.xsd': `<xs:schema ${XS}><xs:group name="G"><xs:sequence/></xs:group><xs:attributeGroup name="AG"/></xs:schema>`,
      },
      'a.xsd',
    );
    expect(problems).toEqual([]);
    expect(set.blocked).toBe(false);
    const group = set.lookup('group', { ns: 'urn:a', local: 'G' });
    expect(group?.doc.path).toBe('a.xsd');
    const inner = group?.node.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'group')[0];
    expect(inner && set.lookupRef('group', { ns: 'urn:a', local: 'G' }, inner)?.doc.path).toBe('b.xsd');
  });

  it('refuses xs:redefine of a type and xs:override: no schema is written', () => {
    const { set, problems } = load(
      {
        'a.xsd': `<xs:schema ${XS}>
          <xs:redefine schemaLocation="b.xsd"><xs:simpleType name="T"><xs:restriction base="T"/></xs:simpleType></xs:redefine>
          <xs:override schemaLocation="b.xsd"/>
        </xs:schema>`,
        'b.xsd': `<xs:schema ${XS}><xs:simpleType name="T"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>`,
      },
      'a.xsd',
    );
    expect(problems.map((p) => [p.code, p.line])).toEqual([
      ['unsupported-redefine', 2],
      ['unsupported-redefine', 3],
    ]);
    expect(set.blocked).toBe(true);
  });

  it('includes a document without target namespace into the namespace of each including document', () => {
    const { set, problems } = load(
      {
        'a.xsd': `<xs:schema ${XS} targetNamespace="urn:a">
          <xs:import namespace="urn:b" schemaLocation="b.xsd"/>
          <xs:import schemaLocation="common/c.xsd"/>
          <xs:include schemaLocation="common/c.xsd"/>
        </xs:schema>`,
        'b.xsd': `<xs:schema ${XS} targetNamespace="urn:b"><xs:include schemaLocation="common/c.xsd"/></xs:schema>`,
        'common/c.xsd': `<xs:schema ${XS}>
          <xs:include schemaLocation="d.xsd"/>
          <xs:complexType name="Contact"><xs:sequence><xs:element name="Phone" type="Digits"/></xs:sequence></xs:complexType>
        </xs:schema>`,
        'common/d.xsd': `<xs:schema ${XS}>
          <xs:include schemaLocation="c.xsd"/>
          <xs:simpleType name="Digits"><xs:restriction base="xs:string"/></xs:simpleType>
        </xs:schema>`,
      },
      'a.xsd',
    );
    expect(problems).toEqual([]);
    expect([...set.components.complexType.keys()].sort()).toEqual(['{urn:a}Contact', '{urn:b}Contact', '{}Contact']);
    expect([...set.components.simpleType.keys()].sort()).toEqual(['{urn:a}Digits', '{urn:b}Digits', '{}Digits']);
    // A reference without prefix in a chameleon document means its own namespace.
    for (const ns of ['urn:a', 'urn:b', '']) {
      const contact = set.components.complexType.get(`{${ns}}Contact`)?.node;
      const phone = contact && xsChild(xsChild(contact, 'sequence') ?? contact, 'element');
      expect(phone && set.resolveQName(phone, 'Digits')).toEqual({ ns, local: 'Digits' });
      expect(phone && set.documentOf(phone)?.chameleon).toBe(ns !== '');
    }
  });

  it('does not take inherited members of the files object for documents', () => {
    expect(load({}, 'toString').problems).toEqual([
      expect.objectContaining({ code: 'missing-file', message: 'schema document toString not found' }),
    ]);
  });

  it('reports an import with another target namespace', () => {
    const { problems } = load(
      {
        'a.xsd': `<xs:schema ${XS}><xs:import namespace="urn:a" schemaLocation="b.xsd"/></xs:schema>`,
        'b.xsd': `<xs:schema ${XS} targetNamespace="urn:b"/>`,
      },
      'a.xsd',
    );
    expect(problems).toEqual([expect.objectContaining({ code: 'namespace-mismatch', file: 'a.xsd', line: 1 })]);
  });

  it('refuses a DOCTYPE whose entity the document uses', () => {
    const { doc, problems } = load(
      { 'a.xsd': `<!DOCTYPE schema [<!ENTITY x "urn:x">]><xs:schema ${XS} targetNamespace="&x;"/>` },
      'a.xsd',
    );
    expect(doc).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['unsafe-input']);
  });

  it('reads a DOCTYPE that only stands in a comment as a comment', () => {
    const quoted = '<!DOCTYPE schema PUBLIC "-//W3C//DTD XMLSchema 200102//EN" "XMLSchema.dtd" [ <!ENTITY d "x"> ]>';
    const { doc, problems } = load(
      { 'a.xsd': `<?xml version="1.0"?>\n<!-- removed:\n${quoted}\n-->\n<xs:schema ${XS}/>` },
      'a.xsd',
    );
    expect(problems).toEqual([]);
    expect(doc).toBeDefined();
  });

  it('limits the size of a file, of the schema set and the number of documents, by default and as given', () => {
    const empty = `<xs:schema ${XS}/>`;
    const padded = (size: number) => `<xs:schema ${XS}><!--${'x'.repeat(size)}--></xs:schema>`;
    const codes = (result: { problems: { code: string }[] }) => result.problems.map((p) => p.code);
    // 4 MiB per file by default; the message names the limit in effect.
    expect(codes(load({ 'a.xsd': padded(3 * 1024 * 1024) }, 'a.xsd'))).toEqual([]);
    const tooLarge = load({ 'a.xsd': padded(4 * 1024 * 1024) }, 'a.xsd');
    expect(tooLarge.problems).toEqual([
      expect.objectContaining({ code: 'resource-limit', message: 'a.xsd exceeds the limit of 4194304 bytes per file' }),
    ]);
    expect(load({ 'a.xsd': padded(2000) }, 'a.xsd', { maxFileBytes: 1000 }).problems[0]?.message).toContain('1000');
    // The bytes count as UTF-8: 600 times ü are 1200 bytes.
    expect(
      codes(
        load({ 'a.xsd': `<xs:schema ${XS}><!--${'ü'.repeat(600)}--></xs:schema>` }, 'a.xsd', { maxFileBytes: 1200 }),
      ),
    ).toEqual(['resource-limit']);
    const includes = (names: string[]) =>
      `<xs:schema ${XS}>${names.map((n) => `<xs:include schemaLocation="${n}"/>`).join('')}</xs:schema>`;
    const parts = Array.from({ length: 5 }, (_, i) => `p${i}.xsd`);
    const large = Object.fromEntries(parts.map((name) => [name, padded(4 * 1024 * 1024 - 100)]));
    expect(codes(load({ 'a.xsd': includes(parts), ...large }, 'a.xsd'))).toContain('resource-limit');
    const total = load({ 'a.xsd': includes(['b.xsd']), 'b.xsd': padded(500) }, 'a.xsd', { maxTotalBytes: 500 });
    expect(total.problems[0]?.message).toBe('the schema set exceeds the limit of 500 bytes');
    const many = Array.from({ length: 128 }, (_, i) => `f${i}.xsd`);
    const small = Object.fromEntries(many.map((name) => [name, empty]));
    expect(codes(load({ 'a.xsd': includes(many), ...small }, 'a.xsd'))).toEqual(['resource-limit']);
    const three = load({ 'a.xsd': includes(many.slice(0, 3)), ...small }, 'a.xsd', { maxDocuments: 3 });
    expect(three.problems.map((p) => p.message)).toEqual(['the schema set exceeds the limit of 3 documents']);
  });

  it('takes limits only as a plain object', () => {
    for (const bad of [5, 'x', [], null, new Date()]) {
      expect(() => load({}, 'a.xsd', bad as unknown as Limits)).toThrow(TypeError);
    }
    expect(() => load({}, 'a.xsd', Object.create(null) as Limits)).not.toThrow();
  });

  it('takes only positive safe integers as limits', () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => load({}, 'a.xsd', { maxDocuments: bad })).toThrow(TypeError);
    }
    expect(() => load({}, 'a.xsd', { maxFileBytes: '10' as unknown as number })).toThrow(
      'limits.maxFileBytes must be a positive safe integer, not 10',
    );
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
