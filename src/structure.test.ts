import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convert, type ConvertInput, type ConvertOptions } from './convert.js';
import { describeSchema, type DescribeSchemaResult } from './describe.js';
import { convertFile, describeSchemaFile } from './node.js';
import type { JsonSchema } from './json-schema.js';
import type {
  ComplexType,
  ElementNode,
  GroupNode,
  Particle,
  SimpleType,
  Structure,
  WildcardNode,
} from './structure.js';

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function schema(body: string, ns = 'urn:t', extra = 'elementFormDefault="qualified"'): string {
  return `<xs:schema ${XS} xmlns="${ns}" xmlns:t="${ns}" targetNamespace="${ns}" ${extra}>${body}</xs:schema>`;
}

function report(files: Record<string, string>, root?: string, options?: ConvertOptions): DescribeSchemaResult {
  const input: ConvertInput = { files, entry: Object.keys(files)[0] ?? '', root, options };
  return describeSchema(input);
}

function structureOf(files: Record<string, string>, root?: string): Structure {
  const { structure } = report(files, root);
  if (!structure) {
    throw new Error('no structure');
  }
  return structure;
}

const complex = (structure: Structure, id: string): ComplexType => {
  const type = structure.types[id];
  if (type?.kind !== 'complex') {
    throw new Error(`${id} is not a complex type`);
  }
  return type;
};

const simple = (structure: Structure, id: string): SimpleType => {
  const type = structure.types[id];
  if (type?.kind !== 'simple') {
    throw new Error(`${id} is not a simple type`);
  }
  return type;
};

/** The particles of a group, by element name or compositor. */
const particle = (group: GroupNode | undefined, index: number): Particle => {
  const found = group?.particles[index];
  if (!found) {
    throw new Error(`no particle ${index}`);
  }
  return found;
};

const element = (group: GroupNode | undefined, index: number): ElementNode => {
  const found = particle(group, index);
  if (found.kind !== 'element') {
    throw new Error(`particle ${index} is a ${found.kind}`);
  }
  return found;
};

const content = (structure: Structure): GroupNode | undefined => complex(structure, structure.root.type).content;

const ORDER = schema(`
  <xs:element name="Root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="A" type="xs:string"/>
        <xs:element name="B" type="t:Code" minOccurs="0" maxOccurs="3"/>
        <xs:choice>
          <xs:element name="C1" type="xs:int"/>
          <xs:element name="C2" type="xs:date"/>
        </xs:choice>
        <xs:sequence maxOccurs="unbounded">
          <xs:element name="K" type="xs:string"/>
          <xs:element name="V" type="xs:decimal"/>
        </xs:sequence>
        <xs:element name="Node" type="t:Tree" minOccurs="0"/>
        <xs:element name="Bag" minOccurs="0">
          <xs:complexType>
            <xs:all><xs:element name="X" type="xs:string"/><xs:element name="Y" type="xs:string" minOccurs="0"/></xs:all>
          </xs:complexType>
        </xs:element>
        <xs:any namespace="##other" processContents="lax" minOccurs="0" maxOccurs="2"/>
      </xs:sequence>
      <xs:attribute name="id" type="xs:ID"/>
      <xs:anyAttribute processContents="skip"/>
    </xs:complexType>
    <xs:key name="byK"><xs:selector xpath="t:K"/><xs:field xpath="."/></xs:key>
  </xs:element>
  <xs:simpleType name="Code">
    <xs:restriction base="xs:token"><xs:pattern value="[A-Z]{2}"/><xs:pattern value="[0-9]{3}"/></xs:restriction>
  </xs:simpleType>
  <xs:complexType name="Tree">
    <xs:sequence>
      <xs:element name="Label" type="xs:string"/>
      <xs:element name="Child" type="t:Tree" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>`);

const FACETS = schema(`
  <xs:element name="Root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Day" type="t:Day"/>
        <xs:element name="Blob" type="t:Blob"/>
        <xs:element name="Codes" type="t:Codes"/>
        <xs:element name="Amount" type="t:Amount"/>
        <xs:element name="Either" type="t:Either"/>
        <xs:element name="Refs" type="t:Refs"/>
        <xs:element name="Narrow" type="t:Narrow"/>
        <xs:element name="Inline" fixed="ab">
          <xs:simpleType><xs:restriction base="xs:string"><xs:length value="2"/></xs:restriction></xs:simpleType>
        </xs:element>
        <xs:element name="Price" type="t:Price"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:simpleType name="Day">
    <xs:restriction base="xs:date"><xs:minInclusive value="2020-01-01"/><xs:maxExclusive value="2030-01-01"/></xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Blob"><xs:restriction base="xs:base64Binary"><xs:maxLength value="4"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Codes">
    <xs:restriction>
      <xs:simpleType><xs:list itemType="xs:token"/></xs:simpleType>
      <xs:maxLength value="3"/><xs:pattern value="[A-Z ]+"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Amount">
    <xs:restriction base="xs:decimal">
      <xs:totalDigits value="5"/><xs:fractionDigits value="2"/><xs:pattern value="[0-9]+\\.[0-9]{2}"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Either"><xs:union memberTypes="xs:int t:Day"/></xs:simpleType>
  <xs:simpleType name="Refs"><xs:list itemType="xs:IDREF"/></xs:simpleType>
  <xs:simpleType name="Wide"><xs:restriction base="xs:string"><xs:pattern value="[a-z]+"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Narrow">
    <xs:restriction base="t:Wide"><xs:pattern value="[a-c]+"/><xs:maxLength value="8"/></xs:restriction>
  </xs:simpleType>
  <xs:complexType name="Price">
    <xs:simpleContent>
      <xs:extension base="t:Amount"><xs:attribute name="currency" type="xs:string" use="required"/></xs:extension>
    </xs:simpleContent>
  </xs:complexType>`);

const DERIVED = schema(`
  <xs:element name="Root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Party" type="t:Party"/>
        <xs:element ref="t:Item" maxOccurs="unbounded"/>
        <xs:element ref="t:Shape"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:complexType name="Party">
    <xs:sequence><xs:element name="Name" type="xs:string"/></xs:sequence>
    <xs:attributeGroup ref="t:Audit"/>
    <xs:attribute name="note" type="xs:string"/>
  </xs:complexType>
  <xs:complexType name="Person">
    <xs:complexContent>
      <xs:extension base="t:Party"><xs:sequence><xs:element name="Born" type="xs:date"/></xs:sequence></xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="Quiet">
    <xs:complexContent>
      <xs:restriction base="t:Party">
        <xs:sequence><xs:element name="Name" type="xs:string"/></xs:sequence>
        <xs:attribute name="note" use="prohibited"/>
      </xs:restriction>
    </xs:complexContent>
  </xs:complexType>
  <xs:attributeGroup name="Audit"><xs:attribute name="by" type="xs:string" use="required"/></xs:attributeGroup>
  <xs:element name="Item" type="xs:string"/>
  <xs:element name="Shape" abstract="true" type="t:ShapeType"/>
  <xs:element name="Circle" substitutionGroup="t:Shape" type="t:ShapeType"/>
  <xs:element name="Square" substitutionGroup="t:Shape" type="t:ShapeType"/>
  <xs:complexType name="ShapeType"><xs:attribute name="size" type="xs:int"/></xs:complexType>`);

const NAMES = `<xs:schema ${XS} xmlns:t="urn:t" xmlns:u="urn:u" targetNamespace="urn:t">
  <xs:import namespace="urn:u" schemaLocation="u.xsd"/>
  <xs:element name="Root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Local" type="xs:string"/>
        <xs:element ref="t:Name"/>
        <xs:element ref="u:Name"/>
      </xs:sequence>
      <xs:attribute name="plain" type="xs:string"/>
    </xs:complexType>
  </xs:element>
  <xs:element name="Name" type="xs:string"/>
</xs:schema>`;
const NAMES_U = schema('<xs:element name="Name" type="xs:int"/>', 'urn:u');

describe('describeSchema', () => {
  describe('particles', () => {
    const structure = structureOf({ 'a.xsd': ORDER });
    const model = content(structure);

    it('keeps the compositors and the order of the particles', () => {
      expect(model?.kind).toBe('sequence');
      expect(model?.particles.map((p) => (p.kind === 'element' ? p.name : p.kind))).toEqual([
        '{urn:t}A',
        '{urn:t}B',
        'choice',
        'sequence',
        '{urn:t}Node',
        '{urn:t}Bag',
        'any',
      ]);
      const bag = complex(structure, element(model, 5).type);
      expect(bag.content?.kind).toBe('all');
      expect(bag.owner).toBe('{urn:t}Bag');
    });

    it('gives the root its path and every element its cardinality', () => {
      expect(structure.root).toMatchObject({ name: '{urn:t}Root', path: '/{urn:t}Root', pointer: '', min: 1, max: 1 });
      expect(element(model, 1)).toMatchObject({ min: 0, max: 3, key: 'B', pointer: '/properties/B' });
      const choice = particle(model, 2) as GroupNode;
      expect(choice.particles.map((p) => (p as ElementNode).pointer)).toEqual(['/properties/C1', '/properties/C2']);
    });

    it('places the elements of a repeated group inside the items of its array', () => {
      const group = particle(model, 3) as GroupNode;
      expect(group).toMatchObject({ kind: 'sequence', max: 'unbounded', key: '#sequence' });
      expect(group.pointer).toBe('/properties/#sequence');
      expect(element(group, 0).pointer).toBe('/properties/#sequence/items/properties/K');
    });

    it('lists a recursive type once and refers to it', () => {
      const tree = complex(structure, '{urn:t}Tree');
      expect(element(model, 4).type).toBe('{urn:t}Tree');
      expect(tree.pointer).toBe('/$defs/Tree');
      expect(element(tree.content, 1)).toMatchObject({ name: '{urn:t}Child', type: '{urn:t}Tree', max: 'unbounded' });
    });

    it('describes wildcards with namespace, processContents and cardinality', () => {
      const any = particle(model, 6) as WildcardNode;
      expect(any).toMatchObject({ kind: 'any', namespace: '##other', processContents: 'lax', min: 0, max: 2 });
      expect(any.targetNamespace).toBe('urn:t');
      expect(complex(structure, structure.root.type).anyAttribute).toMatchObject([
        { namespace: '##any', processContents: 'skip' },
      ]);
    });

    it('reports identity constraints and where IDs come from', () => {
      expect(structure.root.identity).toMatchObject([
        { kind: 'key', name: '{urn:t}byK', selector: 't:K', fields: ['.'], namespaces: { t: 'urn:t' } },
      ]);
      expect(complex(structure, structure.root.type).attributes[0]).toMatchObject({ name: '{}id', idType: 'ID' });
    });

    it('attaches problems to the nodes they concern', () => {
      const { problems, structure: s } = report({ 'a.xsd': ORDER });
      const at = (indexes: number[] | undefined) => (indexes ?? []).map((i) => problems[i]?.code);
      expect(at(s?.root.problems)).toContain('unsupported-identity-constraint');
      expect(at((particle(content(s as Structure), 6) as WildcardNode).problems)).toEqual(['unsupported-any']);
      expect(s?.unplaced).toEqual([]);
    });
  });

  describe('facets', () => {
    const structure = structureOf({ 'a.xsd': FACETS });
    const model = content(structure);
    const value = (index: number) => element(model, index).value;

    it('keeps bounds of dates and lengths of binary data as written', () => {
      expect(value(0)).toEqual({
        builtin: 'date',
        variety: 'atomic',
        whiteSpace: 'collapse',
        minInclusive: '2020-01-01',
        maxExclusive: '2030-01-01',
      });
      expect(value(1)).toMatchObject({ builtin: 'base64Binary', maxLength: 4 });
    });

    it('describes a restricted list with its items, length and pattern', () => {
      expect(value(2)).toEqual({
        builtin: 'anySimpleType',
        variety: 'list',
        item: { builtin: 'token', variety: 'atomic', whiteSpace: 'collapse' },
        whiteSpace: 'collapse',
        maxLength: 3,
        patterns: [['[A-Z ]+']],
      });
      expect(value(5)).toMatchObject({ variety: 'list', item: { builtin: 'IDREF' } });
      expect(element(model, 5).idType).toBe('IDREFS');
    });

    it('keeps digits and a lexical pattern of a number', () => {
      expect(value(3)).toMatchObject({ builtin: 'decimal', totalDigits: 5, fractionDigits: 2 });
      expect(value(3)?.patterns).toEqual([['[0-9]+\\.[0-9]{2}']]);
    });

    it('describes the members of a union', () => {
      expect(value(4)).toMatchObject({ builtin: 'anySimpleType', variety: 'union' });
      expect(value(4)?.members?.map((m) => m.builtin)).toEqual(['int', 'date']);
      expect(value(4)?.whiteSpace).toBeUndefined();
    });

    it('keeps one array of patterns per restriction step', () => {
      expect(value(6)).toMatchObject({ builtin: 'string', patterns: [['[a-z]+'], ['[a-c]+']], maxLength: 8 });
      expect(simple(structure, '{urn:t}Narrow').base).toBe('{urn:t}Wide');
    });

    it('adds the fixed value of the declaration', () => {
      expect(element(model, 7).value).toEqual({
        builtin: 'string',
        variety: 'atomic',
        whiteSpace: 'preserve',
        length: 2,
        fixed: 'ab',
      });
      expect(simple(structure, element(model, 7).type).owner).toBe('{urn:t}Inline');
    });

    it('describes the text of simple content', () => {
      const price = complex(structure, '{urn:t}Price');
      expect(price.text).toMatchObject({ key: 'value', pointer: '/properties/value' });
      expect(price.text?.value).toMatchObject({ builtin: 'decimal', totalDigits: 5 });
      expect(element(model, 8).value).toEqual(price.text?.value);
      expect(price.attributes[0]).toMatchObject({ name: '{}currency', use: 'required' });
    });
  });

  it('says which attributes are global declarations', () => {
    const structure = structureOf(
      {
        'a.xsd': `<xs:schema ${XS} targetNamespace="urn:t" xmlns:t="urn:t" attributeFormDefault="unqualified">
          <xs:attribute name="g" type="xs:string"/>
          <xs:element name="Root"><xs:complexType>
            <xs:attribute ref="t:g" use="required"/>
            <xs:attribute name="g" type="xs:int"/>
            <xs:attribute name="q" type="xs:int" form="qualified"/>
          </xs:complexType></xs:element>
        </xs:schema>`,
      },
      'Root',
    );
    const root = complex(structure, structure.root.type);
    const of = (name: string) => root.attributes.find((a) => a.name === name);
    expect(of('{urn:t}g')).toMatchObject({ global: true, use: 'required' });
    expect(of('{}g')).toMatchObject({ global: false });
    expect(of('{urn:t}q')).toMatchObject({ global: false });
    expect(structure.globals.attributes).toEqual([expect.objectContaining({ name: '{urn:t}g', global: true })]);
  });

  describe('derivation and substitution', () => {
    const structure = structureOf({ 'a.xsd': DERIVED }, 'Root');
    const model = content(structure);

    it('reads an extension as a sequence of the base content and its own', () => {
      const person = complex(structure, '{urn:t}Person');
      expect(person.derivation).toEqual({ base: '{urn:t}Party', method: 'extension' });
      expect(person.content?.particles.map((p) => p.kind)).toEqual(['sequence', 'sequence']);
      expect(element(person.content?.particles[1] as GroupNode, 0).pointer).toBe('/properties/Born');
      expect(person.attributes.map((a) => [a.name, a.group])).toEqual([
        ['{}by', '{urn:t}Audit'],
        ['{}note', undefined],
      ]);
    });

    it('leaves out an attribute a restriction prohibits', () => {
      expect(complex(structure, '{urn:t}Quiet').attributes.map((a) => a.name)).toEqual(['{}by']);
    });

    it('lists the types xsi:type may select', () => {
      expect(element(model, 0).typeAlternatives).toEqual(['{urn:t}Party', '{urn:t}Person', '{urn:t}Quiet']);
    });

    it('lists the members of a substitution group with their own properties', () => {
      const shape = element(model, 2);
      expect(shape).toMatchObject({ name: '{urn:t}Shape', abstract: true, global: true });
      expect(shape.pointer).toBeUndefined();
      expect(shape.substitutes?.map((s) => [s.name, s.pointer])).toEqual([
        ['{urn:t}Circle', '/properties/Circle'],
        ['{urn:t}Square', '/properties/Square'],
      ]);
      expect(element(model, 1)).toMatchObject({ global: true, max: 'unbounded', pointer: '/properties/Item' });
    });
  });

  describe('names', () => {
    const structure = structureOf({ 'a.xsd': NAMES, 'u.xsd': NAMES_U }, 'Root');
    const model = content(structure);

    it('writes a name without namespace with empty braces', () => {
      expect(element(model, 0).name).toBe('{}Local');
      expect(complex(structure, structure.root.type).attributes[0]?.name).toBe('{}plain');
    });

    it('escapes the pointer of a property named with its namespace', () => {
      expect(element(model, 1)).toMatchObject({ key: '{urn:t}Name', pointer: '/properties/{urn:t}Name' });
      const other = structureOf(
        {
          'a.xsd': NAMES.replace(/urn:t/g, 'http://x/t'),
          'u.xsd': NAMES_U.replace(/urn:t/g, 'http://x/t'),
        },
        'Root',
      );
      expect(element(content(other), 1).pointer).toBe('/properties/{http:~1~1x~1t}Name');
    });
  });

  it('describes mixed content without properties for its elements', () => {
    const structure = structureOf({
      'a.xsd': schema(
        '<xs:element name="P"><xs:complexType mixed="true"><xs:sequence><xs:element name="B" type="xs:string"/>' +
          '</xs:sequence></xs:complexType></xs:element>',
      ),
    });
    expect(complex(structure, structure.root.type).mixed).toBe(true);
    expect(element(content(structure), 0).pointer).toBeUndefined();
  });

  it('adds no problems of its own', () => {
    // The emitter never reads the elements of mixed content; the structure does, and finds the undeclared prefix.
    const files = {
      'a.xsd': schema(
        '<xs:element name="P"><xs:complexType mixed="true"><xs:sequence><xs:element ref="u:B"/>' +
          '</xs:sequence></xs:complexType></xs:element>',
      ),
    };
    const described = report(files);
    expect(described.problems).toEqual(convert({ files, entry: 'a.xsd' }).problems);
    expect(described.structure).toBeDefined();
  });

  it('stops at a simple type that derives from itself', () => {
    const files = {
      'a.xsd': schema(
        '<xs:element name="E" type="t:Loop"/><xs:simpleType name="Loop">' +
          '<xs:restriction base="t:Loop"><xs:pattern value="[0-9]{5}"/></xs:restriction></xs:simpleType>',
      ),
    };
    const loop = simple(structureOf(files), '{urn:t}Loop');
    expect(loop.base).toBe('{urn:t}Loop');
    expect(loop.facets.patterns).toEqual([['[0-9]{5}']]);
  });

  it('gives no structure without a schema', () => {
    const result = report({ 'a.xsd': schema('') });
    expect(result.schema).toBeUndefined();
    expect(result.structure).toBeUndefined();
    expect(result.problems.map((p) => p.code)).toEqual(['root-required']);
  });

  it('takes mixed from the base where an extension adds no content', () => {
    const structure = structureOf({
      'a.xsd': schema(`
        <xs:element name="r" type="t:D"/>
        <xs:complexType name="B" mixed="true"><xs:sequence><xs:element name="b" type="xs:string"/></xs:sequence></xs:complexType>
        <xs:complexType name="D"><xs:complexContent><xs:extension base="t:B">
          <xs:attribute name="k" type="xs:string"/></xs:extension></xs:complexContent></xs:complexType>`),
    });
    expect(complex(structure, '{urn:t}D').mixed).toBe(true);
  });

  it('gives an extension of anyType the content and attribute wildcard of anyType', () => {
    const structure = structureOf({
      'a.xsd': schema(`
        <xs:element name="r"><xs:complexType><xs:complexContent><xs:extension base="xs:anyType">
          <xs:attribute name="k" type="xs:string"/></xs:extension></xs:complexContent></xs:complexType></xs:element>`),
    });
    const type = complex(structure, structure.root.type);
    expect(type.mixed).toBe(true);
    expect(type.content?.particles).toMatchObject([
      { kind: 'any', namespace: '##any', processContents: 'lax', min: 0, max: 'unbounded' },
    ]);
    expect(type.attributeWildcard).toEqual({ namespaces: { any: true }, processContents: 'lax' });
  });

  it('intersects the attribute wildcards of a type and its groups and joins those of an extension', () => {
    const structure = structureOf({
      'a.xsd': schema(`
        <xs:element name="r" type="t:D"/>
        <xs:attributeGroup name="G"><xs:anyAttribute namespace="urn:a urn:b" processContents="skip"/></xs:attributeGroup>
        <xs:complexType name="B"><xs:anyAttribute namespace="urn:c" processContents="strict"/></xs:complexType>
        <xs:complexType name="D"><xs:complexContent><xs:extension base="t:B">
          <xs:attributeGroup ref="t:G"/><xs:anyAttribute namespace="urn:b urn:d" processContents="lax"/>
        </xs:extension></xs:complexContent></xs:complexType>`),
    });
    expect(complex(structure, '{urn:t}D').attributeWildcard).toEqual({
      namespaces: { only: ['urn:b', 'urn:c'] },
      processContents: 'lax',
    });
    expect(complex(structure, '{urn:t}B').attributeWildcard).toEqual({
      namespaces: { only: ['urn:c'] },
      processContents: 'strict',
    });
  });

  it('marks an attribute wildcard XML Schema 1.0 cannot express as uncertain', () => {
    const structure = structureOf({
      'a.xsd': schema(`
        <xs:element name="r" type="t:D"/>
        <xs:complexType name="B"><xs:anyAttribute namespace="##local urn:t"/></xs:complexType>
        <xs:complexType name="D"><xs:complexContent><xs:extension base="t:B">
          <xs:anyAttribute namespace="##other"/></xs:extension></xs:complexContent></xs:complexType>`),
    });
    const type = complex(structure, '{urn:t}D');
    expect(type.attributeWildcard).toEqual({ namespaces: { any: true }, processContents: 'strict' });
    const odd = structureOf({
      'a.xsd': schema(`
        <xs:element name="r" type="t:D"/>
        <xs:complexType name="B"><xs:anyAttribute namespace="urn:t"/></xs:complexType>
        <xs:complexType name="D"><xs:complexContent><xs:extension base="t:B">
          <xs:anyAttribute namespace="##other"/></xs:extension></xs:complexContent></xs:complexType>`),
    });
    expect(complex(odd, '{urn:t}D').uncertain).toMatchObject([{ code: 'attribute-wildcard' }]);
    expect(complex(odd, '{urn:t}D').attributeWildcard).toBeUndefined();
  });

  it('marks invalid occurrences as uncertain instead of writing NaN', () => {
    const structure = structureOf({
      'a.xsd': schema(`<xs:element name="r"><xs:complexType><xs:sequence>
        <xs:element name="a" type="xs:string" minOccurs="x"/><xs:element name="b" type="xs:string" minOccurs="3" maxOccurs="2"/>
      </xs:sequence></xs:complexType></xs:element>`),
    });
    const type = complex(structure, structure.root.type);
    expect(type.content?.particles).toMatchObject([
      { name: '{urn:t}a', min: 1, max: 1 },
      { name: '{urn:t}b', min: 3, max: 3 },
    ]);
    expect(type.uncertain?.map((u) => u.code)).toEqual(['occurrences', 'occurrences']);
  });

  it('reads a schema file with its includes and imports', () => {
    const file = new URL('../examples/order/order.xsd', import.meta.url).pathname;
    const result = describeSchemaFile(file);
    expect(result.structure).toBeDefined();
    expect(JSON.stringify(result.schema)).toBe(JSON.stringify(convertFile(file).schema));
    expect(result.problems).toEqual(convertFile(file).problems);
  });

  it('lists the substitutes of a root that heads a substitution group', () => {
    const structure = structureOf(
      {
        'a.xsd': schema(`
          <xs:element name="Item" type="xs:string"/>
          <xs:element name="Book" type="xs:string" substitutionGroup="t:Item"/>
          <xs:element name="Disc" type="xs:string" substitutionGroup="t:Item"/>`),
      },
      'Item',
    );
    expect(structure.root.abstract).toBe(false);
    expect(structure.root.substitutes?.map((s) => s.name)).toEqual(['{urn:t}Book', '{urn:t}Disc']);
    expect(structure.root.substitutes?.every((s) => s.pointer === undefined)).toBe(true);
  });

  it('keeps only the narrowest bound on each side and length over minLength and maxLength', () => {
    const structure = structureOf({
      'a.xsd': schema(`
        <xs:element name="r"><xs:complexType><xs:sequence>
          <xs:element name="n" type="t:N"/><xs:element name="s" type="t:S"/></xs:sequence></xs:complexType></xs:element>
        <xs:simpleType name="B"><xs:restriction base="xs:int"><xs:minInclusive value="0"/><xs:maxExclusive value="100"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="N"><xs:restriction base="t:B"><xs:minExclusive value="5"/><xs:maxInclusive value="50"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="L"><xs:restriction base="xs:string"><xs:minLength value="1"/><xs:maxLength value="9"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="S"><xs:restriction base="t:L"><xs:length value="4"/></xs:restriction></xs:simpleType>`),
    });
    const n = simple(structure, '{urn:t}N').facets;
    expect([n.minInclusive, n.minExclusive, n.maxInclusive, n.maxExclusive]).toEqual([undefined, '5', '50', undefined]);
    const s = simple(structure, '{urn:t}S').facets;
    expect([s.length, s.minLength, s.maxLength]).toEqual([4, undefined, undefined]);
  });

  it('takes mixed from complexContent where it says so, else from complexType', () => {
    const typed = (outer: string, inner: string) =>
      structureOf({
        'a.xsd': schema(`
          <xs:element name="r" type="t:D"/>
          <xs:complexType name="B"><xs:sequence><xs:element name="b" type="xs:string"/></xs:sequence></xs:complexType>
          <xs:complexType name="D"${outer}><xs:complexContent${inner}><xs:extension base="t:B"><xs:sequence>
            <xs:element name="c" type="xs:string"/></xs:sequence></xs:extension></xs:complexContent></xs:complexType>`),
      });
    expect(complex(typed(' mixed="true"', ' mixed="false"'), '{urn:t}D').mixed).toBe(false);
    expect(complex(typed(' mixed="false"', ' mixed="true"'), '{urn:t}D').mixed).toBe(true);
    expect(complex(typed(' mixed="true"', ''), '{urn:t}D').mixed).toBe(true);
    expect(complex(typed('', ''), '{urn:t}D').mixed).toBe(false);
  });

  it('lists the global elements and attributes of the schema set', () => {
    const structure = structureOf(
      {
        'a.xsd': schema(`
        <xs:element name="r" type="xs:string"/><xs:element name="other" type="xs:int"/>
        <xs:attribute name="ga"><xs:simpleType><xs:restriction base="xs:int"><xs:maxInclusive value="9"/></xs:restriction></xs:simpleType></xs:attribute>`),
      },
      'r',
    );
    expect(structure.globals.elements).toEqual(['{urn:t}other', '{urn:t}r']);
    expect(structure.globals.attributes).toMatchObject([
      { name: '{urn:t}ga', value: { builtin: 'int', maxInclusive: '9' } },
    ]);
  });

  it('names the owner of an anonymous type by kind: an element, or an attribute with @', () => {
    const structure = structureOf({
      'a.xsd': schema(
        `<xs:element name="r"><xs:complexType><xs:sequence><xs:element name="q"><xs:simpleType><xs:restriction base="xs:string"/></xs:simpleType></xs:element></xs:sequence>
         <xs:attribute name="q"><xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:attribute></xs:complexType></xs:element>`,
        'urn:t',
        'elementFormDefault="qualified"',
      ),
    });
    const owners = Object.values(structure.types).flatMap((t) => (t.owner === undefined ? [] : [t.owner]));
    expect(owners).toEqual(expect.arrayContaining(['{urn:t}q', '@{}q']));
    const type = complex(structure, structure.root.type);
    expect(type.attributes[0]?.name).toBe('{}q');
  });

  it('gives block and final in effect, with the defaults of the schema document', () => {
    const structure = structureOf({
      'a.xsd': schema(
        `<xs:element name="r" type="t:T"/><xs:complexType name="T"><xs:sequence>
          <xs:element name="a" type="xs:string" block="restriction"/></xs:sequence></xs:complexType>`,
        'urn:t',
        'elementFormDefault="qualified" blockDefault="#all" finalDefault="extension"',
      ),
    });
    expect(structure.root).toMatchObject({ block: '#all', final: 'extension' });
    expect(complex(structure, '{urn:t}T')).toMatchObject({ block: '#all', final: 'extension' });
    const [a] = (complex(structure, '{urn:t}T').content?.particles ?? []) as ElementNode[];
    expect(a?.block).toBe('restriction');
    expect(a?.final).toBeUndefined();
  });
});

// --- every pointer resolves, and the schema is the one convert() writes ---------------------------------------------

/** The value at a JSON Pointer below `node`. */
function at(node: unknown, pointer: string): unknown {
  let current = node;
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

/** The object behind a property, as docs/structure.md describes: through items, the first branch and $ref. */
function objectOf(root: JsonSchema, property: JsonSchema): JsonSchema {
  let current = property;
  for (let step = 0; step < 32; step += 1) {
    if (current.$ref !== undefined) {
      current = (current.$ref === '#' ? root : at(root, current.$ref.slice(1))) as JsonSchema;
    } else if (current.type === 'array' && current.items) {
      current = current.items;
    } else if (current.properties === undefined && (current.anyOf ?? current.oneOf)) {
      current = (current.anyOf ?? current.oneOf)?.[0] as JsonSchema;
    } else {
      return current;
    }
  }
  throw new Error('no object');
}

const localName = (name: string): string => name.slice(name.indexOf('}') + 1);

/** Checks that every pointer of the structure leads to the property of its node; returns how many it checked. */
function checkPointers(schema: JsonSchema, structure: Structure): number {
  let checked = 0;
  const visited = new Set<string>();
  const visitType = (id: string, object: JsonSchema): void => {
    const type = structure.types[id];
    if (type?.kind !== 'complex' || visited.has(id)) {
      return;
    }
    visited.add(id);
    for (const attribute of type.attributes) {
      if (attribute.pointer !== undefined) {
        const property = at(object, attribute.pointer) as JsonSchema;
        expect(property?.xml?.attribute, `${id} ${attribute.name}`).toBe(true);
        checked += 1;
      }
    }
    if (type.text?.pointer !== undefined) {
      expect((at(object, type.text.pointer) as JsonSchema)?.xml?.text).toBe(true);
    }
    const visitParticle = (p: Particle): void => {
      if (p.kind === 'element') {
        for (const node of [p, ...(p.substitutes ?? [])]) {
          if (node.pointer === undefined || node.key === undefined) {
            continue;
          }
          const property = at(object, node.pointer) as JsonSchema;
          expect(property, `${id} ${node.pointer}`).toBeDefined();
          expect(localName(node.key)).toBe(localName(node.name));
          checked += 1;
          visitType(node.type, objectOf(schema, property));
        }
      } else if (p.kind !== 'any') {
        if (p.pointer !== undefined) {
          expect((at(object, p.pointer) as JsonSchema)?.xml?.group).toBe(true);
          checked += 1;
        }
        p.particles.forEach(visitParticle);
      }
    };
    if (type.content) {
      visitParticle(type.content);
    }
  };
  visitType(structure.root.type, objectOf(schema, schema));
  return checked;
}

const CONTRACT = new URL('./test-support/contract/', import.meta.url);

/** Every case of the contract tests and the example, as input with all its schema documents. */
function corpus(): [string, ConvertInput][] {
  const cases: [string, ConvertInput][] = readdirSync(CONTRACT).map((name) => {
    const dir = new URL(`${name}/`, CONTRACT);
    const files = Object.fromEntries(
      readdirSync(dir)
        .filter((file) => file.endsWith('.xsd'))
        .sort((a, b) => (a === 'schema.xsd' ? -1 : b === 'schema.xsd' ? 1 : a.localeCompare(b)))
        .map((file) => [file, readFileSync(new URL(file, dir), 'utf8')]),
    );
    return [name, { files, entry: 'schema.xsd' }];
  });
  const example = new URL('../examples/order/', import.meta.url);
  const exampleFiles: Record<string, string> = {};
  for (const file of ['order.xsd', 'line.xsd', 'common/common.xsd']) {
    try {
      exampleFiles[file] = readFileSync(new URL(file, example), 'utf8');
    } catch {
      // The example keeps its shared types where it likes; a missing file is reported as such.
    }
  }
  cases.push(['example', { files: (path) => exampleFiles[path] ?? readIn(example, path), entry: 'order.xsd' }]);
  cases.push(['particles', { files: { 'a.xsd': ORDER }, entry: 'a.xsd' }]);
  cases.push(['facets', { files: { 'a.xsd': FACETS }, entry: 'a.xsd' }]);
  cases.push(['derivation', { files: { 'a.xsd': DERIVED }, entry: 'a.xsd', root: 'Root' }]);
  cases.push(['names', { files: { 'a.xsd': NAMES, 'u.xsd': NAMES_U }, entry: 'a.xsd', root: 'Root' }]);
  return cases;
}

function readIn(dir: URL, path: string): string | undefined {
  try {
    return readFileSync(new URL(path, dir), 'utf8');
  } catch {
    return undefined;
  }
}

describe('describeSchema and convert', () => {
  const variants: [string, ConvertOptions][] = [
    ['default options', {}],
    ['format and #text', { dateTime: 'format', textProperty: '#text' }],
    ['without xml', { xml: false }],
  ];
  describe.each(corpus())('%s', (_, input) => {
    it.each(variants)('writes the same schema and problems with %s', (__, options) => {
      const described = describeSchema({ ...input, options });
      const converted = convert({ ...input, options });
      expect(JSON.stringify(described.schema)).toBe(JSON.stringify(converted.schema));
      expect(described.problems).toEqual(converted.problems);
    });

    it('resolves every pointer to the property of its node', () => {
      const { schema: out, structure } = describeSchema(input);
      if (out && structure) {
        expect(checkPointers(out, structure)).toBeGreaterThan(0);
      }
    });

    it('points only at problems of the result', () => {
      const { problems, structure } = describeSchema(input);
      if (structure) {
        const indexes = [...structure.unplaced, ...problemIndexes(structure)];
        expect(indexes.filter((i) => !Number.isInteger(i) || i < 0 || i >= problems.length)).toEqual([]);
      }
    });
  });
});

/** The problem indexes of every node, type, attribute and wildcard of a structure. */
function problemIndexes(structure: Structure): number[] {
  const out: number[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'problems' && Array.isArray(child)) out.push(...(child as number[]));
      else visit(child);
    }
  };
  visit(structure.root);
  visit(structure.types);
  return out;
}
