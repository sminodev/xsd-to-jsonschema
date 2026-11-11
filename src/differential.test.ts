// Each case pairs a synthetic XML Schema with instances. For every instance the test states the verdict of the XML
// Schema (checked with libxml2), and the JSON Schema must reach the same verdict on the mapped JSON.
//
// Not covered by design: element order (JSON objects have none) and lexical forms the JSON value loses (leading
// zeros or a plus sign of a number).

import { describe, expect, it } from 'vitest';
import type { ConvertOptions } from './convert.js';
import type { JsonSchema } from './json-schema.js';
import { compare, disagreements } from './test-support/oracle.js';

const prop = (schema: JsonSchema | undefined, key: string): JsonSchema => schema?.properties?.[key] as JsonSchema;
const def = (schema: JsonSchema, key: string): JsonSchema => schema.$defs?.[key] as JsonSchema;

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function schema(body: string, extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema ${XS} xmlns="urn:t" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified" ${extra}>
${body}
</xs:schema>`;
}

function instance(content: string, attributes = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Root xmlns="urn:t" ${attributes}>${content}</Root>`;
}

async function check(
  files: Record<string, string>,
  cases: Record<string, [string, boolean]>,
  options?: ConvertOptions,
) {
  const instances = Object.fromEntries(Object.entries(cases).map(([name, [xml]]) => [name, xml]));
  const result = await compare({
    files,
    entry: Object.keys(files)[0] ?? '',
    root: 'Root',
    options: options ?? {},
    instances,
  });
  const expected = Object.fromEntries(Object.entries(cases).map(([name, [, valid]]) => [name, valid]));
  const xsd = Object.fromEntries(result.verdicts.map((v) => [v.name, v.xsd]));
  expect(xsd, 'XSD verdicts of the corpus').toEqual(expected);
  expect(disagreements(result.verdicts)).toEqual([]);
  return result;
}

describe('convert: XML Schema and JSON Schema agree', () => {
  it('on choices: exclusive branches, sequence branches, optional choices', async () => {
    const files = {
      'choice.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Kind" type="xs:string"/>
				<xs:choice>
					<xs:element name="Signature" type="Code"/>
					<xs:sequence>
						<xs:element name="Street" type="xs:string"/>
						<xs:element name="Number" type="xs:string" minOccurs="0"/>
					</xs:sequence>
				</xs:choice>
				<xs:choice minOccurs="0">
					<xs:element name="A" type="xs:integer"/>
					<xs:element name="B" type="xs:boolean"/>
				</xs:choice>
				<xs:element name="Tail" type="xs:string"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Code">
		<xs:restriction base="xs:string">
			<xs:pattern value="\\d{2}\\-[A-Z]"/>
		</xs:restriction>
	</xs:simpleType>`),
    };
    const k = '<Kind>k</Kind>';
    const tail = '<Tail>t</Tail>';
    const { schema: out } = await check(files, {
      signature: [instance(`${k}<Signature>12-A</Signature>${tail}`), true],
      street: [instance(`${k}<Street>s</Street>${tail}`), true],
      streetAndNumber: [instance(`${k}<Street>s</Street><Number>1</Number>${tail}`), true],
      withA: [instance(`${k}<Signature>12-A</Signature><A>5</A>${tail}`), true],
      withB: [instance(`${k}<Street>s</Street><B>true</B>${tail}`), true],
      bothBranches: [instance(`${k}<Signature>12-A</Signature><Street>s</Street>${tail}`), false],
      noBranch: [instance(`${k}${tail}`), false],
      numberWithoutStreet: [instance(`${k}<Signature>12-A</Signature><Number>1</Number>${tail}`), false],
      numberAndBadSignature: [instance(`${k}<Signature>1-A</Signature><Number>1</Number>${tail}`), false],
      badSignature: [instance(`${k}<Signature>1-A</Signature>${tail}`), false],
      aAndB: [instance(`${k}<Street>s</Street><A>5</A><B>true</B>${tail}`), false],
      badA: [instance(`${k}<Street>s</Street><A>x</A>${tail}`), false],
      missingTail: [instance(`${k}<Street>s</Street>`), false],
    });
    expect(Object.keys(out.properties ?? {})).toEqual(['Kind', 'Signature', 'Street', 'Number', 'A', 'B', 'Tail']);
    expect(out.allOf?.length).toBe(2);
    expect(out.allOf?.[1]?.oneOf?.[2]).toEqual({ properties: { A: false, B: false } });
  });

  it('on a choice with an empty branch and on a nested choice', async () => {
    const files = {
      'nested.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:choice>
				<xs:sequence>
					<xs:element name="Note" type="xs:string" minOccurs="0"/>
				</xs:sequence>
				<xs:sequence>
					<xs:element name="Head" type="xs:string"/>
					<xs:choice>
						<xs:element name="X" type="xs:string"/>
						<xs:element name="Y" type="xs:string"/>
					</xs:choice>
				</xs:sequence>
			</xs:choice>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      empty: [instance(''), true],
      note: [instance('<Note>n</Note>'), true],
      headX: [instance('<Head>h</Head><X>x</X>'), true],
      headY: [instance('<Head>h</Head><Y>y</Y>'), true],
      headOnly: [instance('<Head>h</Head>'), false],
      headXY: [instance('<Head>h</Head><X>x</X><Y>y</Y>'), false],
      noteAndHead: [instance('<Note>n</Note><Head>h</Head><X>x</X>'), false],
      xWithoutHead: [instance('<X>x</X>'), false],
    });
  });

  it('on an optional choice whose branch can be empty through a nested optional choice', async () => {
    const files = {
      'optional.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:choice minOccurs="0">
					<xs:element name="A" type="xs:string"/>
					<xs:sequence>
						<xs:choice minOccurs="0">
							<xs:element name="B" type="xs:string"/>
							<xs:element name="C" type="xs:string"/>
						</xs:choice>
					</xs:sequence>
				</xs:choice>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      empty: [instance(''), true],
      a: [instance('<A>a</A>'), true],
      b: [instance('<B>b</B>'), true],
      aAndB: [instance('<A>a</A><B>b</B>'), false],
      bAndC: [instance('<B>b</B><C>c</C>'), false],
    });
  });

  it('on repetition, arrays and optional sequences', async () => {
    const files = {
      'occurs.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Pair" type="xs:string" minOccurs="2" maxOccurs="3"/>
				<xs:element name="Many" type="xs:integer" minOccurs="0" maxOccurs="unbounded"/>
				<xs:sequence minOccurs="0">
					<xs:element name="From" type="xs:string"/>
					<xs:element name="Until" type="xs:string"/>
					<xs:element name="Remark" type="xs:string" minOccurs="0"/>
				</xs:sequence>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const pair = '<Pair>a</Pair><Pair>b</Pair>';
    await check(files, {
      two: [instance(pair), true],
      three: [instance(`${pair}<Pair>c</Pair>`), true],
      one: [instance('<Pair>a</Pair>'), false],
      four: [instance(`${pair}${pair}`), false],
      many: [instance(`${pair}<Many>1</Many><Many>2</Many>`), true],
      badMany: [instance(`${pair}<Many>1</Many><Many>x</Many>`), false],
      range: [instance(`${pair}<From>a</From><Until>b</Until>`), true],
      rangeWithRemark: [instance(`${pair}<From>a</From><Until>b</Until><Remark>r</Remark>`), true],
      fromOnly: [instance(`${pair}<From>a</From>`), false],
      remarkOnly: [instance(`${pair}<Remark>r</Remark>`), false],
    });
  });

  it('on a repeated sequence: an array with an object per occurrence', async () => {
    const files = {
      'repeat.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Id" type="xs:string"/>
				<xs:sequence maxOccurs="2">
					<xs:element name="A" type="xs:integer"/>
					<xs:element name="B" type="xs:string" minOccurs="0"/>
				</xs:sequence>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const id = '<Id>i</Id>';
    const {
      schema: out,
      problems,
      verdicts,
    } = await check(files, {
      once: [instance(`${id}<A>1</A>`), true],
      twice: [instance(`${id}<A>1</A><B>x</B><A>2</A>`), true],
      thrice: [instance(`${id}<A>1</A><A>2</A><A>3</A>`), false],
      none: [instance(id), false],
      bOnly: [instance(`${id}<B>x</B>`), false],
      bFirst: [instance(`${id}<B>x</B><A>1</A>`), false],
      badValue: [instance(`${id}<A>x</A>`), false],
    });
    expect(problems).toEqual([]);
    expect(verdicts.find((v) => v.name === 'twice')?.value).toEqual({
      Id: 'i',
      '#sequence': [{ A: 1, B: 'x' }, { A: 2 }],
    });
    expect(out.required).toEqual(['Id', '#sequence']);
    expect(prop(out, '#sequence')).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          A: { type: 'integer', xml: { namespace: 'urn:t' } },
          B: { type: 'string', xml: { namespace: 'urn:t' } },
        },
        required: ['A'],
        additionalProperties: false,
      },
      minItems: 1,
      maxItems: 2,
      xml: { group: true },
    });
  });

  it('on a repeated choice: each occurrence is one branch', async () => {
    const files = {
      'choices.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:choice minOccurs="0" maxOccurs="3">
				<xs:element name="A" type="xs:integer"/>
				<xs:sequence>
					<xs:element name="B" type="xs:string"/>
					<xs:element name="C" type="xs:string"/>
				</xs:sequence>
			</xs:choice>
		</xs:complexType>
	</xs:element>`),
    };
    const { schema: out, verdicts } = await check(files, {
      empty: [instance(''), true],
      branchesInTurn: [instance('<A>1</A><B>b</B><C>c</C><A>2</A>'), true],
      sameBranch: [instance('<A>1</A><A>2</A><A>3</A>'), true],
      four: [instance('<A>1</A><A>2</A><A>3</A><A>4</A>'), false],
      halfBranch: [instance('<A>1</A><B>b</B>'), false],
      cAlone: [instance('<C>c</C>'), false],
    });
    expect(verdicts.find((v) => v.name === 'branchesInTurn')?.value).toEqual({
      '#choice': [{ A: 1 }, { B: 'b', C: 'c' }, { A: 2 }],
    });
    expect(out.required).toBeUndefined();
    expect(prop(out, '#choice').minItems).toBeUndefined();
  });

  it('on repeated groups inside repeated groups, on references and on numbering', async () => {
    const files = {
      'nested.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:sequence maxOccurs="2">
					<xs:element name="Head" type="xs:string"/>
					<xs:sequence minOccurs="0" maxOccurs="2">
						<xs:element name="Key" type="xs:string"/>
						<xs:element name="Val" type="xs:integer"/>
					</xs:sequence>
				</xs:sequence>
				<xs:element name="Mid" type="xs:string"/>
				<xs:sequence minOccurs="0" maxOccurs="unbounded">
					<xs:element name="Tail" type="xs:string"/>
				</xs:sequence>
				<xs:group ref="Pair" maxOccurs="2"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:group name="Pair">
		<xs:sequence>
			<xs:element name="L" type="xs:string"/>
			<xs:element name="R" type="xs:string"/>
		</xs:sequence>
	</xs:group>`),
    };
    const pair = '<L>l</L><R>r</R>';
    const { schema: out, verdicts } = await check(files, {
      flat: [instance(`<Head>h</Head><Mid>m</Mid>${pair}`), true],
      nested: [
        instance(
          `<Head>h</Head><Key>k</Key><Val>1</Val><Key>l</Key><Val>2</Val><Head>i</Head><Mid>m</Mid>${pair}${pair}`,
        ),
        true,
      ],
      tails: [instance(`<Head>h</Head><Mid>m</Mid><Tail>t</Tail><Tail>u</Tail>${pair}`), true],
      keyWithoutVal: [instance(`<Head>h</Head><Key>k</Key><Mid>m</Mid>${pair}`), false],
      threeInner: [instance(`<Head>h</Head>${'<Key>k</Key><Val>1</Val>'.repeat(3)}<Mid>m</Mid>${pair}`), false],
      noPair: [instance(`<Head>h</Head><Mid>m</Mid>`), false],
      halfPair: [instance(`<Head>h</Head><Mid>m</Mid>${pair}<L>l</L>`), false],
    });
    expect(Object.keys(out.properties ?? {})).toEqual(['#sequence', 'Mid', '#sequence:2', '#Pair']);
    expect(verdicts.find((v) => v.name === 'nested')?.value).toEqual({
      '#sequence': [
        {
          Head: 'h',
          '#sequence': [
            { Key: 'k', Val: 1 },
            { Key: 'l', Val: 2 },
          ],
        },
        { Head: 'i' },
      ],
      Mid: 'm',
      '#Pair': [
        { L: 'l', R: 'r' },
        { L: 'l', R: 'r' },
      ],
    });
  });

  it('on two references to one group: they share its property', async () => {
    const files = {
      'twice.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:group ref="Pair" maxOccurs="2"/>
				<xs:element name="Mid" type="xs:string"/>
				<xs:group ref="Pair" maxOccurs="2"/>
				<xs:element name="End" type="xs:string"/>
				<xs:group ref="Head"/>
				<xs:element name="Sep" type="xs:string"/>
				<xs:group ref="Head"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:group name="Pair">
		<xs:sequence>
			<xs:element name="L" type="xs:string"/>
			<xs:element name="R" type="xs:string"/>
		</xs:sequence>
	</xs:group>
	<xs:group name="Head">
		<xs:sequence>
			<xs:element name="H" type="xs:string"/>
			<xs:sequence maxOccurs="2">
				<xs:element name="V" type="xs:integer"/>
			</xs:sequence>
		</xs:sequence>
	</xs:group>`),
    };
    const pair = '<L>l</L><R>r</R>';
    const head = '<H>h</H><V>1</V>';
    const tail = `<End>e</End>${head}<Sep>s</Sep>${head}`;
    const {
      schema: out,
      problems,
      verdicts,
    } = await check(files, {
      least: [instance(`${pair}<Mid>m</Mid>${pair}${tail}`), true],
      most: [instance(`${pair}${pair}<Mid>m</Mid>${pair}${pair}${tail}`), true],
      fiveAcrossBoth: [instance(`${pair}${pair}<Mid>m</Mid>${pair}${pair}${pair}${tail}`), false],
      secondMissing: [instance(`${pair}<Mid>m</Mid>${tail}`), false],
    });
    expect(problems).toEqual([]);
    expect(Object.keys(out.properties ?? {})).toEqual(['#Pair', 'Mid', 'End', 'H', '#sequence', 'Sep']);
    expect(prop(out, '#Pair').minItems).toBe(2);
    expect(prop(out, '#Pair').maxItems).toBe(4);
    expect(verdicts.find((v) => v.name === 'least')?.value).toEqual({
      '#Pair': [
        { L: 'l', R: 'r' },
        { L: 'l', R: 'r' },
      ],
      Mid: 'm',
      End: 'e',
      H: ['h', 'h'],
      '#sequence': [{ V: 1 }, { V: 1 }],
      Sep: 's',
    });
  });

  it('on a repeated group in a choice, one that can be empty, and an extension of a base with one', async () => {
    const files = {
      'places.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:choice>
					<xs:element name="None" type="xs:string"/>
					<xs:sequence maxOccurs="2">
						<xs:element name="A" type="xs:integer"/>
					</xs:sequence>
				</xs:choice>
				<xs:sequence minOccurs="2" maxOccurs="3">
					<xs:element name="Opt" type="xs:string" minOccurs="0"/>
				</xs:sequence>
				<xs:element name="Derived" type="Derived"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:complexType name="Base">
		<xs:sequence maxOccurs="2">
			<xs:element name="X" type="xs:string"/>
		</xs:sequence>
	</xs:complexType>
	<xs:complexType name="Derived">
		<xs:complexContent>
			<xs:extension base="Base">
				<xs:sequence maxOccurs="2">
					<xs:element name="Y" type="xs:string"/>
				</xs:sequence>
			</xs:extension>
		</xs:complexContent>
	</xs:complexType>`),
    };
    const derived = '<Derived><X>x</X><Y>y</Y></Derived>';
    const { schema: out, verdicts } = await check(files, {
      none: [instance(`<None>n</None>${derived}`), true],
      numbers: [instance(`<A>1</A><A>2</A>${derived}`), true],
      both: [instance(`<None>n</None><A>1</A>${derived}`), false],
      neither: [instance(derived), false],
      someOpt: [instance(`<None>n</None><Opt>o</Opt><Opt>p</Opt>${derived}`), true],
      tooManyOpt: [instance(`<None>n</None>${'<Opt>o</Opt>'.repeat(4)}${derived}`), false],
      moreOfBoth: [instance('<None>n</None><Derived><X>x</X><X>x</X><Y>y</Y><Y>y</Y></Derived>'), true],
      noY: [instance('<None>n</None><Derived><X>x</X></Derived>'), false],
    });
    expect(Object.keys(def(out, 'Derived').properties ?? {})).toEqual(['#sequence', '#sequence:2']);
    expect(verdicts.find((v) => v.name === 'someOpt')?.value).toEqual({
      None: 'n',
      '#sequence:2': [{ Opt: 'o' }, { Opt: 'p' }],
      Derived: { '#sequence': [{ X: 'x' }], '#sequence:2': [{ Y: 'y' }] },
    });
    expect(out.required).not.toContain('#sequence:2');
  });

  it('on one element name in several particles: an array with the occurrences of all', async () => {
    const files = {
      'names.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="A" type="xs:integer"/>
				<xs:element name="B" type="xs:string"/>
				<xs:element name="A" type="xs:integer" minOccurs="0"/>
				<xs:choice>
					<xs:sequence>
						<xs:element name="X" type="xs:string"/>
						<xs:element name="Y" type="xs:string"/>
						<xs:element name="Z" type="xs:string"/>
						<xs:element name="Y" type="xs:string"/>
					</xs:sequence>
					<xs:sequence>
						<xs:element name="W" type="xs:string"/>
						<xs:element name="Y" type="xs:string" minOccurs="0"/>
					</xs:sequence>
				</xs:choice>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const ab = '<A>1</A><B>b</B>';
    const xyz = '<X>x</X><Y>y</Y><Z>z</Z><Y>y</Y>';
    const {
      schema: out,
      problems,
      verdicts,
    } = await check(files, {
      required: [instance(`${ab}${xyz}`), true],
      withOptional: [instance(`${ab}<A>2</A>${xyz}`), true],
      tooMany: [instance(`${ab}<A>2</A><A>3</A>${xyz}`), false],
      noA: [instance(`<B>b</B>${xyz}`), false],
      w: [instance(`${ab}<W>w</W>`), true],
      wAndY: [instance(`${ab}<W>w</W><Y>y</Y>`), true],
      wAndTwoY: [instance(`${ab}<W>w</W><Y>y</Y><Y>y</Y>`), false],
      oneYInFirstBranch: [instance(`${ab}<X>x</X><Y>y</Y><Z>z</Z>`), false],
    });
    expect(problems).toEqual([]);
    expect(out.required).toEqual(['A', 'B']);
    expect(prop(out, 'A')).toEqual({
      type: 'array',
      items: { type: 'integer' },
      minItems: 1,
      maxItems: 2,
      xml: { namespace: 'urn:t' },
    });
    expect(verdicts.find((v) => v.name === 'withOptional')?.value).toEqual({
      A: [1, 2],
      B: 'b',
      X: 'x',
      Y: ['y', 'y'],
      Z: 'z',
    });
  });

  it('on branches that declare the same element: either may match', async () => {
    const files = {
      'same.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:choice>
				<xs:element name="K" type="xs:string"/>
				<xs:sequence>
					<xs:element name="K" type="xs:string"/>
				</xs:sequence>
				<xs:element name="M" type="xs:string"/>
			</xs:choice>
		</xs:complexType>
	</xs:element>`),
    };
    const { schema: out } = await check(files, {
      k: [instance('<K>k</K>'), true],
      m: [instance('<M>m</M>'), true],
      kAndM: [instance('<K>k</K><M>m</M>'), false],
      twoK: [instance('<K>k</K><K>l</K>'), false],
      neither: [instance(''), false],
    });
    expect(out.oneOf).toBeUndefined();
    expect(out.anyOf).toHaveLength(3);
  });

  it('on a choice with several branches that can be empty', async () => {
    const files = {
      'empty.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:choice>
				<xs:element name="A" type="xs:string" minOccurs="0"/>
				<xs:element name="B" type="xs:string" minOccurs="0"/>
			</xs:choice>
		</xs:complexType>
	</xs:element>`),
    };
    const { problems } = await check(files, {
      nothing: [instance(''), true],
      a: [instance('<A>a</A>'), true],
      b: [instance('<B>b</B>'), true],
      both: [instance('<A>a</A><B>b</B>'), false],
    });
    expect(problems).toEqual([]);
  });

  it('on a choice inside an optional sequence: all of the sequence or nothing', async () => {
    const files = {
      'optional.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:sequence minOccurs="0">
					<xs:element name="Head" type="xs:string"/>
					<xs:choice>
						<xs:element name="X" type="xs:string"/>
						<xs:element name="Y" type="xs:string"/>
					</xs:choice>
				</xs:sequence>
				<xs:element name="Tail" type="xs:string"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const tail = '<Tail>t</Tail>';
    const { problems } = await check(files, {
      nothing: [instance(tail), true],
      headX: [instance(`<Head>h</Head><X>x</X>${tail}`), true],
      headY: [instance(`<Head>h</Head><Y>y</Y>${tail}`), true],
      headOnly: [instance(`<Head>h</Head>${tail}`), false],
      xOnly: [instance(`<X>x</X>${tail}`), false],
      headXY: [instance(`<Head>h</Head><X>x</X><Y>y</Y>${tail}`), false],
    });
    expect(problems).toEqual([]);
  });

  it('on fixed and default values of simple content, on children, the root and untyped elements', async () => {
    const price = `<xs:complexType name="Price"><xs:simpleContent><xs:extension base="xs:decimal">
			<xs:attribute name="currency" type="xs:string"/></xs:extension></xs:simpleContent></xs:complexType>`;
    const child = await check(
      {
        'child.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Fee" type="Price" fixed="10.00"/>
				<xs:element name="Mode" fixed="AUTO"/>
				<xs:element name="Inline" fixed="7">
					<xs:complexType><xs:simpleContent><xs:extension base="xs:integer"/></xs:simpleContent></xs:complexType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	${price}`),
      },
      {
        right: [instance('<Fee currency="EUR">10.00</Fee><Mode>AUTO</Mode><Inline>7</Inline>'), true],
        wrongFee: [instance('<Fee>11</Fee><Mode>AUTO</Mode><Inline>7</Inline>'), false],
        wrongMode: [instance('<Fee>10.00</Fee><Mode>OTHER</Mode><Inline>7</Inline>'), false],
        wrongInline: [instance('<Fee>10.00</Fee><Mode>AUTO</Mode><Inline>8</Inline>'), false],
      },
    );
    expect(child.problems).toEqual([]);
    const root = await check(
      { 'root.xsd': schema(`<xs:element name="Root" type="Price" fixed="10.00"/>${price}`) },
      {
        right: [instance('10.00'), true],
        wrong: [instance('11'), false],
      },
    );
    expect(root.problems).toEqual([]);
    expect(prop(root.schema, 'value').const).toBe(10);
  });

  it('on a name inside and outside a choice or optional group: valid documents pass', async () => {
    const files = {
      'overlap.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="First" type="Overlap" minOccurs="0"/>
				<xs:element name="Second" type="Optional" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:complexType name="Overlap">
		<xs:sequence>
			<xs:choice>
				<xs:element name="X" type="xs:string"/>
				<xs:element name="A" type="xs:string"/>
			</xs:choice>
			<xs:element name="A" type="xs:string"/>
		</xs:sequence>
	</xs:complexType>
	<xs:complexType name="Optional">
		<xs:sequence>
			<xs:element name="A" type="xs:string"/>
			<xs:sequence minOccurs="0">
				<xs:element name="A" type="xs:string"/>
				<xs:element name="B" type="xs:string"/>
			</xs:sequence>
		</xs:sequence>
	</xs:complexType>`),
    };
    const { problems } = await check(files, {
      xThenA: [instance('<First><X>x</X><A>a</A></First>'), true],
      twoA: [instance('<First><A>a</A><A>a</A></First>'), true],
      noA: [instance('<First><X>x</X></First>'), false],
      oneA: [instance('<Second><A>a</A></Second>'), true],
      twoAAndB: [instance('<Second><A>a</A><A>a</A><B>b</B></Second>'), true],
      threeA: [instance('<Second><A>a</A><A>a</A><A>a</A><B>b</B></Second>'), false],
    });
    expect(problems.map((p) => `${p.severity}:${p.code}`)).toEqual([
      'warning:approximated-occurrences',
      'warning:approximated-occurrences',
    ]);
  });

  it('on facets: lengths, enumerations, patterns, bounds and digits', async () => {
    const files = {
      'facets.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Code" type="Code" minOccurs="0"/>
				<xs:element name="Narrow" type="Narrow" minOccurs="0"/>
				<xs:element name="Flag" type="Flag" minOccurs="0"/>
				<xs:element name="Count" type="Count" minOccurs="0"/>
				<xs:element name="Amount" type="Amount" minOccurs="0"/>
				<xs:element name="Rate" type="Rate" minOccurs="0"/>
				<xs:element name="Small" type="Small" minOccurs="0"/>
				<xs:element name="Plain" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:string">
							<xs:minLength value="2"/>
							<xs:maxLength value="4"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="Literal" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:string">
							<xs:pattern value="a.c|^$"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Code">
		<xs:restriction base="xs:string">
			<xs:pattern value="[A-Z]{2}"/>
			<xs:pattern value="\\d{3}"/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Narrow">
		<xs:restriction base="Code">
			<xs:pattern value="A.|9.."/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Flag">
		<xs:restriction base="xs:string">
			<xs:length value="1"/>
			<xs:enumeration value="0"/>
			<xs:enumeration value="1"/>
			<xs:enumeration value="10"/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Count">
		<xs:restriction base="xs:integer">
			<xs:minInclusive value="1"/>
			<xs:maxExclusive value="100"/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Rate">
		<xs:restriction base="xs:decimal">
			<xs:fractionDigits value="5"/>
			<xs:minInclusive value="0"/>
			<xs:maxInclusive value="999999.99999"/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Amount">
		<xs:restriction base="xs:decimal">
			<xs:fractionDigits value="2"/>
			<xs:minInclusive value="0"/>
			<xs:maxInclusive value="9999.99"/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Small">
		<xs:restriction base="xs:integer">
			<xs:totalDigits value="3"/>
		</xs:restriction>
	</xs:simpleType>`),
    };
    const { schema: out, problems } = await check(files, {
      letters: [instance('<Code>AB</Code>'), true],
      digits: [instance('<Code>123</Code>'), true],
      mixed: [instance('<Code>A1</Code>'), false],
      narrowA: [instance('<Narrow>AB</Narrow>'), true],
      narrow9: [instance('<Narrow>912</Narrow>'), true],
      narrowOther: [instance('<Narrow>BA</Narrow>'), false],
      narrowNotCode: [instance('<Narrow>9X</Narrow>'), false],
      flag: [instance('<Flag>1</Flag>'), true],
      flagTooLong: [instance('<Flag>10</Flag>'), false],
      count: [instance('<Count>99</Count>'), true],
      countZero: [instance('<Count>0</Count>'), false],
      countHundred: [instance('<Count>100</Count>'), false],
      amount: [instance('<Amount>12.34</Amount>'), true],
      amountFraction: [instance('<Amount>1.234</Amount>'), false],
      amountMax: [instance('<Amount>10000</Amount>'), false],
      amountTwoDigits: [instance('<Amount>1.12</Amount>'), true],
      rateWhole: [instance('<Rate>1</Rate>'), true],
      rateLarge: [instance('<Rate>999999.99999</Rate>'), true],
      rateFraction: [instance('<Rate>0.000011</Rate>'), false],
      small: [instance('<Small>-999</Small>'), true],
      smallTooLong: [instance('<Small>1000</Small>'), false],
      plain: [instance('<Plain>abc</Plain>'), true],
      plainShort: [instance('<Plain>a</Plain>'), false],
      plainLong: [instance('<Plain>abcde</Plain>'), false],
      literalDot: [instance('<Literal>abc</Literal>'), true],
      literalCaret: [instance('<Literal>^$</Literal>'), true],
      literalAnchored: [instance('<Literal>xabc</Literal>'), false],
    });
    expect(def(out, 'Flag')).toEqual({ type: 'string', enum: ['0', '1'] });
    expect(problems.map((p) => p.code)).toEqual(['unreachable-enumeration']);
  });

  it('on fixed and default values, attributes and attribute groups', async () => {
    const files = {
      'values.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Version" type="xs:string" fixed="10"/>
				<xs:element name="Hardship" type="Flag" fixed="1" minOccurs="0"/>
				<xs:element name="Count" type="xs:integer" fixed="1"/>
				<xs:element name="Mode" type="xs:string" default="a" minOccurs="0"/>
			</xs:sequence>
			<xs:attributeGroup ref="Header"/>
			<xs:attribute name="note" type="xs:string"/>
		</xs:complexType>
	</xs:element>
	<xs:attributeGroup name="Header">
		<xs:attribute name="id" type="xs:integer" use="required"/>
		<xs:attribute name="kind" type="xs:string" fixed="K"/>
	</xs:attributeGroup>
	<xs:simpleType name="Flag">
		<xs:restriction base="xs:string">
			<xs:enumeration value="0"/>
			<xs:enumeration value="1"/>
		</xs:restriction>
	</xs:simpleType>`),
    };
    const body = '<Version>10</Version><Count>1</Count>';
    const { schema: out } = await check(files, {
      minimal: [instance(body, 'id="7"'), true],
      hardship: [instance('<Version>10</Version><Hardship>1</Hardship><Count>1</Count>', 'id="7"'), true],
      hardshipZero: [instance('<Version>10</Version><Hardship>0</Hardship><Count>1</Count>', 'id="7"'), false],
      wrongVersion: [instance('<Version>11</Version><Count>1</Count>', 'id="7"'), false],
      wrongCount: [instance('<Version>10</Version><Count>2</Count>', 'id="7"'), false],
      noId: [instance(body), false],
      badId: [instance(body, 'id="x"'), false],
      kind: [instance(body, 'id="7" kind="K"'), true],
      wrongKind: [instance(body, 'id="7" kind="L"'), false],
      note: [instance(body, 'id="7" note="n"'), true],
      unknownAttribute: [instance(body, 'id="7" other="o"'), false],
    });
    expect(prop(out, 'Version').const).toBe('10');
    expect(prop(out, 'Count').const).toBe(1);
    expect(prop(out, 'Mode').default).toBe('a');
    expect(Object.keys(out.properties ?? {})).toEqual(['id', 'kind', 'note', 'Version', 'Hardship', 'Count', 'Mode']);
    expect(out.required).toEqual(['id', 'Version', 'Count']);
  });

  it('on namespaces, imports, element references and recursion', async () => {
    const files = {
      'main.xsd': schema(
        `
	<xs:import namespace="urn:o" schemaLocation="other.xsd"/>
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element ref="o:Shared"/>
				<xs:element name="Local" type="o:Code"/>
				<xs:element ref="Root" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`,
        'xmlns:o="urn:o"',
      ),
      'other.xsd': `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema ${XS} xmlns="urn:o" targetNamespace="urn:o" elementFormDefault="unqualified">
	<xs:element name="Shared">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Inner" type="Code"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Code">
		<xs:restriction base="xs:string">
			<xs:length value="2"/>
		</xs:restriction>
	</xs:simpleType>
</xs:schema>`,
    };
    const shared = '<o:Shared xmlns:o="urn:o"><Inner xmlns="">ab</Inner></o:Shared>';
    const { schema: out } = await check(files, {
      flat: [instance(`${shared}<Local>cd</Local>`), true],
      nested: [instance(`${shared}<Local>cd</Local><Root>${shared}<Local>ef</Local></Root>`), true],
      nestedBad: [instance(`${shared}<Local>cd</Local><Root>${shared}<Local>e</Local></Root>`), false],
      innerQualified: [instance('<o:Shared xmlns:o="urn:o"><o:Inner>ab</o:Inner></o:Shared><Local>cd</Local>'), false],
      sharedWrongNamespace: [instance('<Shared><Inner xmlns="">ab</Inner></Shared><Local>cd</Local>'), false],
    });
    expect(prop(out, 'Root')).toEqual({ $ref: '#', xml: { namespace: 'urn:t' } });
    expect(prop(out, 'Shared').xml).toEqual({ namespace: 'urn:o' });
    expect(prop(def(out, 'Shared'), 'Inner').xml).toBeUndefined();
  });

  it('on complex type extension and simple content', async () => {
    const files = {
      'derived.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Person" type="Employee"/>
				<xs:element name="Price" type="Price"/>
				<xs:element name="Offer" type="Offer" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:complexType name="Person">
		<xs:sequence>
			<xs:element name="Name" type="xs:string"/>
		</xs:sequence>
		<xs:attribute name="id" type="xs:string" use="required"/>
	</xs:complexType>
	<xs:complexType name="Employee">
		<xs:complexContent>
			<xs:extension base="Person">
				<xs:sequence>
					<xs:element name="Staff" type="xs:integer"/>
				</xs:sequence>
			</xs:extension>
		</xs:complexContent>
	</xs:complexType>
	<xs:complexType name="Price">
		<xs:simpleContent>
			<xs:extension base="xs:decimal">
				<xs:attribute name="currency" type="xs:string" use="required"/>
			</xs:extension>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="Offer">
		<xs:simpleContent>
			<xs:extension base="Price">
				<xs:attribute name="until" type="xs:date"/>
			</xs:extension>
		</xs:simpleContent>
	</xs:complexType>`),
    };
    const person = '<Person id="p"><Name>n</Name><Staff>3</Staff></Person>';
    const price = '<Price currency="EUR">1.5</Price>';
    await check(files, {
      valid: [instance(`<Person id="p"><Name>n</Name><Staff>3</Staff></Person>${price}`), true],
      noStaff: [instance(`<Person id="p"><Name>n</Name></Person>${price}`), false],
      noId: [instance(`<Person><Name>n</Name><Staff>3</Staff></Person>${price}`), false],
      badPrice: [
        instance('<Person id="p"><Name>n</Name><Staff>3</Staff></Person><Price currency="EUR">x</Price>'),
        false,
      ],
      noCurrency: [instance('<Person id="p"><Name>n</Name><Staff>3</Staff></Person><Price>1</Price>'), false],
      offer: [instance(`${person}${price}<Offer currency="EUR" until="2026-11-30">1.2</Offer>`), true],
      offerNoCurrency: [instance(`${person}${price}<Offer until="2026-11-30">1.2</Offer>`), false],
      offerBadValue: [instance(`${person}${price}<Offer currency="EUR">x</Offer>`), false],
      offerBadUntil: [instance(`${person}${price}<Offer currency="EUR" until="soon">1.2</Offer>`), false],
    });
  });

  it('on model groups, global attributes and complex type restriction', async () => {
    const files = {
      'groups.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:group ref="Address"/>
				<xs:group ref="Contact" minOccurs="0"/>
				<xs:element name="Item" type="Narrow"/>
			</xs:sequence>
			<xs:attribute ref="lang" use="required"/>
		</xs:complexType>
	</xs:element>
	<xs:attribute name="lang" type="xs:language"/>
	<xs:group name="Address">
		<xs:sequence>
			<xs:element name="Street" type="xs:string"/>
			<xs:element name="City" type="xs:string" minOccurs="0"/>
		</xs:sequence>
	</xs:group>
	<xs:group name="Contact">
		<xs:choice>
			<xs:element name="Phone" type="xs:string"/>
			<xs:element name="Mail" type="xs:string"/>
		</xs:choice>
	</xs:group>
	<xs:complexType name="Wide">
		<xs:sequence>
			<xs:element name="Code" type="xs:string"/>
			<xs:element name="Note" type="xs:string" minOccurs="0"/>
		</xs:sequence>
		<xs:attribute name="kind" type="xs:string"/>
		<xs:attribute name="old" type="xs:string"/>
	</xs:complexType>
	<xs:complexType name="Narrow">
		<xs:complexContent>
			<xs:restriction base="Wide">
				<xs:sequence>
					<xs:element name="Code" type="xs:string"/>
				</xs:sequence>
				<xs:attribute name="old" use="prohibited"/>
			</xs:restriction>
		</xs:complexContent>
	</xs:complexType>`),
    };
    const lang = 't:lang="de" xmlns:t="urn:t"';
    const item = '<Item kind="k"><Code>c</Code></Item>';
    await check(files, {
      street: [instance(`<Street>s</Street>${item}`, lang), true],
      full: [instance(`<Street>s</Street><City>c</City><Mail>m</Mail>${item}`, lang), true],
      phoneAndMail: [instance(`<Street>s</Street><Phone>p</Phone><Mail>m</Mail>${item}`, lang), false],
      noStreet: [instance(item, lang), false],
      noLang: [instance(`<Street>s</Street>${item}`), false],
      badLang: [instance(`<Street>s</Street>${item}`, 't:lang="toolongforlanguage" xmlns:t="urn:t"'), false],
      restrictedNote: [instance(`<Street>s</Street><Item><Code>c</Code><Note>n</Note></Item>`, lang), false],
      prohibitedAttribute: [instance(`<Street>s</Street><Item old="o"><Code>c</Code></Item>`, lang), false],
    });
  });

  it('on extension points with xs:any and xs:anyAttribute', async () => {
    const files = {
      'any.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Id" type="xs:string"/>
				<xs:element name="Extension" minOccurs="0">
					<xs:complexType>
						<xs:sequence>
							<xs:any namespace="##other" processContents="lax" maxOccurs="unbounded"/>
						</xs:sequence>
					</xs:complexType>
				</xs:element>
				<xs:element name="Note">
					<xs:complexType>
						<xs:simpleContent>
							<xs:extension base="xs:string">
								<xs:anyAttribute namespace="##other" processContents="skip"/>
							</xs:extension>
						</xs:simpleContent>
					</xs:complexType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const { problems } = await check(files, {
      plain: [instance('<Id>1</Id><Note>n</Note>'), true],
      extension: [instance('<Id>1</Id><Extension><o:Any xmlns:o="urn:o">x</o:Any></Extension><Note>n</Note>'), true],
      foreignAttribute: [instance('<Id>1</Id><Note xmlns:o="urn:o" o:lang="de">n</Note>'), true],
      noId: [instance('<Extension><o:Any xmlns:o="urn:o">x</o:Any></Extension><Note>n</Note>'), false],
      unknownElsewhere: [instance('<Id>1</Id><Other>o</Other><Note>n</Note>'), false],
    });
    expect(problems.map((p) => `${p.severity}:${p.code}`)).toEqual([
      'warning:unsupported-any',
      'warning:unsupported-any',
    ]);
  });

  it('on mixed content, written as a string of markup', async () => {
    const files = {
      'mixed.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Note" type="RichText"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:complexType name="RichText" mixed="true">
		<xs:choice minOccurs="0" maxOccurs="unbounded">
			<xs:element name="b" type="xs:string"/>
			<xs:element name="i" type="xs:string"/>
		</xs:choice>
		<xs:attribute name="lang" type="xs:language" use="required"/>
	</xs:complexType>`),
    };
    // The elements inside mixed content are not checked, so the cases leave out documents that only they make invalid.
    const {
      schema: out,
      problems,
      verdicts,
    } = await check(files, {
      text: [instance('<Note lang="de">Hello <b>World</b>, <i>again</i>!</Note>'), true],
      empty: [instance('<Note lang="de"/>'), true],
      noLang: [instance('<Note>Hello</Note>'), false],
      badLang: [instance('<Note lang="toolonglanguage">Hello</Note>'), false],
      noNote: [instance(''), false],
    });
    expect(def(out, 'RichText').properties?.['value']).toEqual({ type: 'string', xml: { text: true, mixed: true } });
    expect(verdicts.find((v) => v.name === 'text')?.value).toEqual({
      Note: { lang: 'de', value: 'Hello <b xmlns="urn:t">World</b>, <i xmlns="urn:t">again</i>!' },
    });
    expect(problems.map((p) => `${p.severity}:${p.code}`)).toEqual(['warning:unsupported-mixed']);
  });

  it('on unions of simple types and restrictions of unions', async () => {
    const files = {
      'union.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="When" type="PartialDate" minOccurs="0"/>
				<xs:element name="Day" type="Day2026" minOccurs="0"/>
				<xs:element name="Size" type="Size" minOccurs="0"/>
				<xs:element name="Count" type="CountOrNone" minOccurs="0"/>
				<xs:element name="Measure" type="DecimalOrDouble" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="PartialDate">
		<xs:union memberTypes="xs:gYear xs:gYearMonth xs:date"/>
	</xs:simpleType>
	<xs:simpleType name="Day2026">
		<xs:restriction base="PartialDate">
			<xs:pattern value="2026-\\d{2}-\\d{2}"/>
		</xs:restriction>
	</xs:simpleType>
	<xs:simpleType name="Size">
		<xs:union>
			<xs:simpleType>
				<xs:restriction base="xs:token">
					<xs:enumeration value="S"/>
					<xs:enumeration value="M"/>
					<xs:enumeration value="L"/>
				</xs:restriction>
			</xs:simpleType>
			<xs:simpleType>
				<xs:restriction base="xs:string">
					<xs:pattern value="\\d{2}cm"/>
				</xs:restriction>
			</xs:simpleType>
		</xs:union>
	</xs:simpleType>
	<xs:simpleType name="DecimalOrDouble">
		<xs:union memberTypes="xs:decimal xs:double"/>
	</xs:simpleType>
	<xs:simpleType name="CountOrNone">
		<xs:union memberTypes="xs:integer">
			<xs:simpleType>
				<xs:restriction base="xs:string">
					<xs:enumeration value="none"/>
				</xs:restriction>
			</xs:simpleType>
		</xs:union>
	</xs:simpleType>`),
    };
    const { schema: out, problems } = await check(files, {
      year: [instance('<When>2026</When>'), true],
      yearMonth: [instance('<When>2026-11</When>'), true],
      date: [instance('<When>2026-11-04</When>'), true],
      badMonth: [instance('<When>2026-13</When>'), false],
      shortYear: [instance('<When>26</When>'), false],
      day: [instance('<Day>2026-11-04</Day>'), true],
      otherYear: [instance('<Day>2025-11-04</Day>'), false],
      yearOnlyDay: [instance('<Day>2026</Day>'), false],
      size: [instance('<Size>M</Size>'), true],
      centimetres: [instance('<Size>12cm</Size>'), true],
      unknownSize: [instance('<Size>XL</Size>'), false],
      shortCentimetres: [instance('<Size>1cm</Size>'), false],
      count: [instance('<Count>5</Count>'), true],
      none: [instance('<Count>none</Count>'), true],
      decimal: [instance('<Measure>1.5</Measure>'), true],
      negative: [instance('<Measure>-2</Measure>'), true],
      double: [instance('<Measure>1e3</Measure>'), true],
      noNumber: [instance('<Measure>x</Measure>'), false],
    });
    expect(problems.map((p) => `${p.severity}:${p.code}`)).toEqual(['warning:unsupported-union']);
    expect(def(out, 'DecimalOrDouble').type).toBe('number');
  });

  it('on dates and times written as XML Schema lexical patterns', async () => {
    const files = {
      'dates.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="D" type="xs:date" minOccurs="0"/>
				<xs:element name="DT" type="xs:dateTime" minOccurs="0"/>
				<xs:element name="T" type="xs:time" minOccurs="0"/>
				<xs:element name="Y" type="xs:gYear" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(
      files,
      {
        date: [instance('<D>2026-11-04</D>'), true],
        dateZone: [instance('<D>2026-11-04Z</D>'), true],
        dateTime: [instance('<DT>2026-11-04T08:30:00</DT>'), true],
        dateTimeOffset: [instance('<DT>2026-11-04T08:30:00.5+01:00</DT>'), true],
        time: [instance('<T>23:59:59</T>'), true],
        year: [instance('<Y>2026</Y>'), true],
        badMonth: [instance('<D>2026-13-04</D>'), false],
        badTime: [instance('<T>25:00:00</T>'), false],
        compactDate: [instance('<D>20261104</D>'), false],
        leapDay: [instance('<D>2024-02-29</D>'), true],
        leapCentury: [instance('<D>2000-02-29</D>'), true],
        noLeapYear: [instance('<D>2026-02-29</D>'), false],
        noLeapCentury: [instance('<D>1900-02-29</D>'), false],
        thirtiethOfFebruary: [instance('<D>2026-02-30</D>'), false],
        thirtyFirstOfApril: [instance('<DT>2026-04-31T10:00:00</DT>'), false],
        yearZero: [instance('<D>0000-01-01</D>'), false],
        fiveDigitYear: [instance('<Y>12026</Y>'), true],
      },
      { dateTime: 'pattern' },
    );
  });

  it('on durations and on the length of binary data', async () => {
    const files = {
      'lexical.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="D" type="xs:duration" minOccurs="0"/>
				<xs:element name="Hash" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:hexBinary">
							<xs:length value="2"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      days: [instance('<D>P1D</D>'), true],
      all: [instance('<D>-P1Y2M3DT4H5M6.7S</D>'), true],
      shortSeconds: [instance('<D>PT.5S</D>'), true],
      openSeconds: [instance('<D>PT1.S</D>'), true],
      nothing: [instance('<D>P</D>'), false],
      negativeNothing: [instance('<D>-P</D>'), false],
      emptyTime: [instance('<D>P1YT</D>'), false],
      weeks: [instance('<D>P1W</D>'), false],
      twoOctets: [instance('<Hash>0aFF</Hash>'), true],
      oneOctet: [instance('<Hash>0a</Hash>'), false],
      threeOctets: [instance('<Hash>0a0b0c</Hash>'), false],
    });
  });
});
