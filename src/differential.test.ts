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
          A: { type: 'integer', xml: { namespace: 'urn:t', type: '{http://www.w3.org/2001/XMLSchema}integer' } },
          B: { type: 'string', xml: { namespace: 'urn:t', type: '{http://www.w3.org/2001/XMLSchema}string' } },
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
    expect(Object.keys(def(out, 'Derived').properties ?? {})).toEqual(['#type', '#sequence', '#sequence:2']);
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
      items: { type: 'integer', xml: { type: '{http://www.w3.org/2001/XMLSchema}integer' } },
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
    // Mode has no type: xs:anyType, written without a schema.
    expect(child.problems.map((p) => p.code)).toEqual(['unsupported-any']);
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
    expect(def(out, 'Flag')).toEqual({ type: 'string', enum: ['0', '1'], xml: { type: '{urn:t}Flag' } });
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
				<xs:element name="Small" type="ByteOrFlag" minOccurs="0"/>
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
	</xs:simpleType>
	<xs:simpleType name="ByteOrFlag">
		<xs:union memberTypes="xs:byte xs:boolean"/>
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
      // The members of a union with different JSON types are checked as text, each normalized on its own.
      countWithSpaces: [instance('<Count> +5 </Count>'), true],
      noCount: [instance('<Count>x</Count>'), false],
      fraction: [instance('<Count>1.5</Count>'), false],
      noneWithSpace: [instance('<Count>none </Count>'), false],
      small: [instance('<Small>12</Small>'), true],
      flag: [instance('<Small> true </Small>'), true],
      noSmall: [instance('<Small>yes</Small>'), false],
      decimal: [instance('<Measure>1.5</Measure>'), true],
      negative: [instance('<Measure>-2</Measure>'), true],
      double: [instance('<Measure>1e3</Measure>'), true],
      noNumber: [instance('<Measure>x</Measure>'), false],
    });
    // Only the range of xs:byte is left to the text form.
    expect(problems).toMatchObject([
      {
        severity: 'warning',
        code: 'unsupported-union',
        message: expect.stringContaining('the range of xs:byte') as string,
      },
    ]);
    // A double member adds INF, -INF and NaN: the union has no single JSON type, the members decide.
    expect(def(out, 'DecimalOrDouble')).not.toHaveProperty('type');
    expect(def(out, 'DecimalOrDouble').anyOf).toHaveLength(2);
    expect(def(out, 'CountOrNone').anyOf).toHaveLength(2);
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

  // Dates are left out: XML Schema collapses their whitespace, but libxml2 2.13 rejects `<D> 2026-11-04 </D>`.
  it('on whitespace that XML normalizes before checking a value', async () => {
    const files = {
      'whitespace.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="A" type="Code" minOccurs="0"/>
				<xs:element name="C" type="Code" minOccurs="0" maxOccurs="2"/>
				<xs:element name="N" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:normalizedString">
							<xs:pattern value="[a-z]+ [a-z]+"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="S" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:string">
							<xs:maxLength value="3"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="G" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:string">
							<xs:whiteSpace value="collapse"/>
							<xs:maxLength value="3"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="E" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:token">
							<xs:enumeration value="A B"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="F" minOccurs="0">
					<xs:simpleType>
						<xs:restriction base="xs:token">
							<xs:enumeration value="  C   D "/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="T" minOccurs="0">
					<xs:complexType>
						<xs:simpleContent>
							<xs:extension base="Code">
								<xs:attribute name="unit" type="xs:string"/>
							</xs:extension>
						</xs:simpleContent>
					</xs:complexType>
				</xs:element>
			</xs:sequence>
			<xs:attribute name="key" type="Code"/>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Code">
		<xs:restriction base="xs:token">
			<xs:length value="6"/>
		</xs:restriction>
	</xs:simpleType>`),
    };
    const { schema: out } = await check(files, {
      token: [instance('<A> abcdef\n</A>'), true],
      tokenInside: [instance('<A>abc def</A>'), false],
      tokenTooLong: [instance('<A> abc  def </A>'), false],
      tokenItems: [instance('<C> abcdef</C><C>ghijkl\t</C>'), true],
      normalizedTab: [instance('<N>ab\tcd</N>'), true],
      normalizedLineFeed: [instance('<N>ab\ncd</N>'), true],
      normalizedKeepsEnds: [instance('<N> ab cd</N>'), false],
      stringPreserves: [instance('<S> ab</S>'), true],
      stringTooLong: [instance('<S> abc</S>'), false],
      collapseFacet: [instance('<G>  a \t b  </G>'), true],
      collapseFacetTooLong: [instance('<G> a  bc </G>'), false],
      enumeration: [instance('<E>  A\n B </E>'), true],
      enumerationOther: [instance('<E>AB</E>'), false],
      spacedEnumeration: [instance('<F>C D</F>'), true],
      spacedEnumerationAsWritten: [instance('<F>  C   D </F>'), true],
      attribute: [instance('', 'key=" abcdef "'), true],
      attributeTooLong: [instance('', 'key="abc def"'), false],
      simpleContent: [instance('<T unit=" m "> abcdef\n</T>'), true],
      simpleContentTooLong: [instance('<T>abc def</T>'), false],
    });
    expect(def(out, 'Code').xml).toEqual({ whiteSpace: 'collapse', type: '{urn:t}Code' });
    expect(prop(out, 'N').xml).toEqual({ namespace: 'urn:t', whiteSpace: 'replace' });
    expect(prop(out, 'S').xml).toEqual({ namespace: 'urn:t' });
    expect(prop(out, 'G').xml).toEqual({ namespace: 'urn:t', whiteSpace: 'collapse' });
    expect(prop(out, 'F').enum).toEqual(['C D']);
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

  it('on unions whose members normalize whitespace differently: each member on its own, in member order', async () => {
    const files = {
      'members.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="T" type="DateOrEmpty" minOccurs="0" maxOccurs="2"/>
				<xs:element name="U" type="TokenOrText" minOccurs="0"/>
				<xs:element name="V" type="TextOrToken" minOccurs="0"/>
				<xs:element name="N" type="Nested" minOccurs="0"/>
				<xs:element name="R" type="ReplaceOrShort" minOccurs="0"/>
			</xs:sequence>
			<xs:attribute name="when" type="DateOrEmpty"/>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Empty"><xs:restriction base="xs:string"><xs:maxLength value="0"/></xs:restriction></xs:simpleType>
	<xs:simpleType name="DateOrEmpty"><xs:union memberTypes="xs:date Empty"/></xs:simpleType>
	<xs:simpleType name="TokenOrText"><xs:union memberTypes="xs:token xs:string"/></xs:simpleType>
	<xs:simpleType name="TextOrToken">
		<xs:union memberTypes="xs:string">
			<xs:simpleType><xs:restriction base="xs:token"><xs:enumeration value="a b"/></xs:restriction></xs:simpleType>
		</xs:union>
	</xs:simpleType>
	<xs:simpleType name="Nested">
		<xs:union>
			<xs:simpleType><xs:restriction base="DateOrEmpty"><xs:pattern value="\\d{4}-11-\\d{2}|"/></xs:restriction></xs:simpleType>
			<xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value=" x "/></xs:restriction></xs:simpleType>
		</xs:union>
	</xs:simpleType>
	<xs:simpleType name="ReplaceOrShort">
		<xs:union>
			<xs:simpleType><xs:restriction base="xs:normalizedString"><xs:pattern value="a b"/></xs:restriction></xs:simpleType>
			<xs:simpleType><xs:restriction base="xs:string"><xs:length value="1"/></xs:restriction></xs:simpleType>
		</xs:union>
	</xs:simpleType>`),
    };
    const { schema: out } = await check(files, {
      date: [instance('<T> 2026-11-11 </T><T></T>'), true],
      dateLineBreaks: [instance('<T>\r\n\t2026-11-11\n</T>'), true],
      notADate: [instance('<T> x </T>'), false],
      spacesOnly: [instance('<T> </T>'), false],
      attribute: [instance('', 'when=" 2026-11-11 "'), true],
      emptyAttribute: [instance('', 'when=""'), true],
      // The token member comes first and takes every text; the string member never gets to see it.
      tokenFirst: [instance('<U>  a   b </U>'), true],
      // The string member comes first: it keeps the text as written, so the enumerated token never matches.
      textFirst: [instance('<V>  a   b </V>'), true],
      nestedDate: [instance('<N> 2026-11-11 </N>'), true],
      // libxml2 ignores the facets of a restricted union that is itself a member, so the pattern is left untested.
      nestedNoDate: [instance('<N> 2026-11-31 </N>'), false],
      nestedEmpty: [instance('<N></N>'), true],
      nestedText: [instance('<N> x </N>'), true],
      nestedTextTrimmed: [instance('<N>x</N>'), false],
      replace: [instance('<R>a\tb</R>'), true],
      replaceKeepsDoubleSpace: [instance('<R>a\t b</R>'), false],
      single: [instance('<R>\t</R>'), true],
    });
    const verdicts = await compare({
      files,
      entry: 'members.xsd',
      root: 'Root',
      instances: { u: instance('<U>  a   b </U><V>  a   b </V><R>\t</R>', 'when=" 2026-11-11 "') },
    });
    expect(verdicts.verdicts[0]?.value).toEqual({ when: '2026-11-11', U: 'a b', V: '  a   b ', R: '\t' });
    expect(def(out, 'DateOrEmpty').anyOf?.map((m) => m.xml?.whiteSpace)).toEqual(['collapse', undefined]);
  });

  it('on the whitespace of a root element of a built-in, anonymous or named simple type', async () => {
    const root = (declaration: string) => ({ 'root.xsd': schema(declaration) });
    const doc = (text: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Root xmlns="urn:t">${text}</Root>`;
    const cases = {
      spaces: [doc(' AB1 '), true],
      lineBreaks: [doc('\nAB1\t'), true],
      inside: [doc('A B1'), false],
      tooLong: [doc(' AB12 '), false],
    } satisfies Record<string, [string, boolean]>;
    const builtin = await check(root('<xs:element name="Root" type="xs:token"/>'), {
      spaces: [doc(' AB1 '), true],
      inside: [doc('A  B1'), true],
    });
    expect(builtin.schema.xml).toEqual({
      name: 'Root',
      namespace: 'urn:t',
      whiteSpace: 'collapse',
      type: '{http://www.w3.org/2001/XMLSchema}token',
    });
    expect(builtin.verdicts.map((v) => v.value)).toEqual(['AB1', 'A B1']);
    const anonymous = await check(
      root(
        '<xs:element name="Root"><xs:simpleType><xs:restriction base="xs:token"><xs:length value="3"/></xs:restriction></xs:simpleType></xs:element>',
      ),
      cases,
    );
    expect(anonymous.schema.xml).toEqual({ name: 'Root', namespace: 'urn:t', whiteSpace: 'collapse' });
    const named = await check(
      root(
        '<xs:element name="Root" type="Code"/><xs:simpleType name="Code"><xs:restriction base="xs:token"><xs:length value="3"/></xs:restriction></xs:simpleType>',
      ),
      cases,
    );
    expect(named.schema.xml).toEqual({ name: 'Root', namespace: 'urn:t' });
    expect(def(named.schema, 'Code').xml).toEqual({ whiteSpace: 'collapse', type: '{urn:t}Code' });
  });

  it('on IDs, references and their lists: each item is an NCName', async () => {
    const files = {
      'ids.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Item" minOccurs="0" maxOccurs="unbounded">
					<xs:complexType><xs:attribute name="id" type="xs:ID"/></xs:complexType>
				</xs:element>
				<xs:element name="Ref" type="xs:IDREF" minOccurs="0"/>
				<xs:element name="Refs" type="xs:IDREFS" minOccurs="0"/>
				<xs:element name="Tokens" type="xs:NMTOKENS" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const items = '<Item id="a1"/><Item id="b2"/>';
    await check(files, {
      refs: [instance(`${items}<Ref>a1</Ref><Refs> a1  b2 </Refs>`), true],
      refsNotNames: [instance(`${items}<Refs>a1 1x</Refs>`), false],
      refsWithColon: [instance(`${items}<Refs>a1 p:b2</Refs>`), false],
      refNotAName: [instance(`${items}<Ref>1x</Ref>`), false],
      idNotAName: [instance('<Item id="1x"/>'), false],
      // NMTOKENS takes any name characters, digits and colons too.
      tokens: [instance('<Tokens>1x p:b -c</Tokens>'), true],
      tokensNotNames: [instance('<Tokens>a b!</Tokens>'), false],
    });
  });

  it('on base64 data: quartets, padding, the bits before the padding and spaces', async () => {
    const files = {
      'base64.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="B" type="xs:base64Binary" minOccurs="0" maxOccurs="unbounded"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const b = (value: string) => instance(`<B>${value}</B>`);
    await check(files, {
      empty: [b(''), true],
      quartet: [b('AAAA'), true],
      twoPadded: [b('AA=='), true],
      onePadded: [b('AAA='), true],
      longer: [b('AAAAAA=='), true],
      spaces: [b(' A A A A '), true],
      lineBreaks: [b('Zm9v\nYmFy\r\n'), true],
      spacedPadding: [b('A A = ='), true],
      bitsAfterTwoPadding: [b('AB=='), false],
      bitsAfterOnePadding: [b('AAB='), false],
      padInside: [b('AA=A'), false],
      padFirst: [b('A=AA'), false],
      short: [b('AAA'), false],
      extraPad: [b('AAAA='), false],
      alphabet: [b('*** ERROR ***'), false],
      urlAlphabet: [b('AA-_'), false],
    });
  });

  it('on facets of a simpleContent restriction: whiteSpace, digits, lengths and patterns', async () => {
    const files = {
      'text.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Euro" type="Euro" minOccurs="0" maxOccurs="unbounded"/>
				<xs:element name="Code" type="ShortCode" minOccurs="0" maxOccurs="unbounded"/>
				<xs:element name="Squeezed" type="Squeezed" minOccurs="0" maxOccurs="unbounded"/>
				<xs:element name="Kind" type="Kind" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:complexType name="Amount">
		<xs:simpleContent>
			<xs:extension base="xs:decimal"><xs:attribute name="currency" type="xs:token" use="required"/></xs:extension>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="Euro">
		<xs:simpleContent>
			<xs:restriction base="Amount">
				<xs:totalDigits value="5"/>
				<xs:fractionDigits value="2"/>
				<xs:attribute name="currency" type="xs:token" use="required" fixed="EUR"/>
			</xs:restriction>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="Code">
		<xs:simpleContent>
			<xs:extension base="xs:string"><xs:attribute name="list" type="xs:string"/></xs:extension>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="PatternCode">
		<xs:simpleContent>
			<xs:restriction base="Code"><xs:pattern value="[A-Z ]+"/><xs:maxLength value="4"/></xs:restriction>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="ShortCode">
		<xs:simpleContent>
			<xs:restriction base="PatternCode"><xs:minLength value="2"/></xs:restriction>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="Squeezed">
		<xs:simpleContent>
			<xs:restriction base="Code"><xs:whiteSpace value="collapse"/><xs:maxLength value="3"/></xs:restriction>
		</xs:simpleContent>
	</xs:complexType>
	<xs:complexType name="Kind">
		<xs:simpleContent>
			<xs:restriction base="Code">
				<xs:simpleType><xs:restriction base="xs:token"><xs:enumeration value="a b"/></xs:restriction></xs:simpleType>
			</xs:restriction>
		</xs:simpleContent>
	</xs:complexType>`),
    };
    const { schema: out, problems } = await check(files, {
      euro: [instance('<Euro currency="EUR">123.45</Euro><Euro currency="EUR">-1</Euro>'), true],
      euroFractionDigits: [instance('<Euro currency="EUR">1.234</Euro>'), false],
      euroTotalDigits: [instance('<Euro currency="EUR">1234.56</Euro>'), false],
      euroCurrency: [instance('<Euro currency="USD">1</Euro>'), false],
      code: [instance('<Code>AB</Code><Code>ABCD</Code>'), true],
      codeInheritedPattern: [instance('<Code>ab</Code>'), false],
      codeInheritedLength: [instance('<Code>ABCDE</Code>'), false],
      codeOwnLength: [instance('<Code>A</Code>'), false],
      squeezed: [instance('<Squeezed list="x">  a \t b  </Squeezed>'), true],
      squeezedTooLong: [instance('<Squeezed> ab  cd </Squeezed>'), false],
      kind: [instance('<Kind>  a   b </Kind>'), true],
      otherKind: [instance('<Kind>ab</Kind>'), false],
    });
    expect(problems).toEqual([]);
    expect((def(out, 'Euro').properties?.['value'] as JsonSchema).xml).toEqual({ text: true, decimal: true });
    expect((def(out, 'Squeezed').properties?.['value'] as JsonSchema).xml).toEqual({
      text: true,
      whiteSpace: 'collapse',
    });
  });

  it('on a chameleon include: the components take the namespace of each including document', async () => {
    const files = {
      'main.xsd': schema(`
	<xs:import namespace="urn:o" schemaLocation="other.xsd"/>
	<xs:include schemaLocation="common/contact.xsd"/>
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Contact" type="Contact"/>
				<xs:element ref="o:Other" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`).replace('xmlns:t="urn:t"', 'xmlns:t="urn:t" xmlns:o="urn:o"'),
      'other.xsd': `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema ${XS} xmlns="urn:o" targetNamespace="urn:o" elementFormDefault="qualified">
	<xs:include schemaLocation="common/contact.xsd"/>
	<xs:element name="Other" type="Contact"/>
</xs:schema>`,
      'common/contact.xsd': `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema ${XS} elementFormDefault="qualified">
	<xs:include schemaLocation="digits.xsd"/>
	<xs:complexType name="Contact">
		<xs:sequence>
			<xs:element name="Phone" type="Digits"/>
			<xs:element name="Mail" type="xs:string" minOccurs="0"/>
		</xs:sequence>
		<xs:attribute name="kind" type="xs:string"/>
	</xs:complexType>
</xs:schema>`,
      'common/digits.xsd': `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema ${XS}>
	<xs:include schemaLocation="contact.xsd"/>
	<xs:simpleType name="Digits"><xs:restriction base="xs:string"><xs:pattern value="\\d+"/></xs:restriction></xs:simpleType>
</xs:schema>`,
    };
    const other = (content: string) => `<Other xmlns="urn:o">${content}</Other>`;
    const { schema: out, problems } = await check(files, {
      contact: [instance('<Contact kind="home"><Phone>123</Phone><Mail>a@b</Mail></Contact>'), true],
      both: [instance(`<Contact><Phone>1</Phone></Contact>${other('<Phone>2</Phone>')}`), true],
      phoneWithoutNamespace: [instance('<Contact><Phone xmlns="">123</Phone></Contact>'), false],
      otherPhoneInMainNamespace: [
        instance(`<Contact><Phone>1</Phone></Contact><Other xmlns="urn:o"><Phone xmlns="urn:t">2</Phone></Other>`),
        false,
      ],
      noDigits: [instance('<Contact><Phone>x</Phone></Contact>'), false],
      missingPhone: [instance('<Contact/>'), false],
    });
    expect(problems).toEqual([]);
    expect(Object.keys(out.$defs ?? {})).toEqual(['Contact', 'o.Contact', 'Digits', 'o.Digits']);
    expect(prop(def(out, 'Contact'), 'Phone')).toEqual({ $ref: '#/$defs/Digits', xml: { namespace: 'urn:t' } });
    expect(prop(def(out, 'o.Contact'), 'Phone')).toEqual({ $ref: '#/$defs/o.Digits', xml: { namespace: 'urn:o' } });
  });

  it('on lists: typed arrays for elements, attributes, simple content, repetition and the root', async () => {
    const files = {
      'lists.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Numbers" type="Numbers" minOccurs="0"/>
				<xs:element name="Repeated" type="Numbers" minOccurs="0" maxOccurs="2"/>
				<xs:element name="Short" type="Short" minOccurs="0"/>
				<xs:element name="Pair" type="Pair" minOccurs="0"/>
				<xs:element name="Mixed" type="Mixed" minOccurs="0"/>
				<xs:element name="Tokens" type="xs:NMTOKENS" minOccurs="0"/>
				<xs:element name="Measured" minOccurs="0">
					<xs:complexType>
						<xs:simpleContent>
							<xs:extension base="Numbers"><xs:attribute name="unit" type="xs:token"/></xs:extension>
						</xs:simpleContent>
					</xs:complexType>
				</xs:element>
				<xs:element name="Flags" minOccurs="0" fixed="true 0">
					<xs:simpleType><xs:list itemType="xs:boolean"/></xs:simpleType>
				</xs:element>
			</xs:sequence>
			<xs:attribute name="codes" type="Colours"/>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Numbers"><xs:list itemType="xs:integer"/></xs:simpleType>
	<xs:simpleType name="Colour"><xs:restriction base="xs:token"><xs:enumeration value="red"/><xs:enumeration value="green"/></xs:restriction></xs:simpleType>
	<xs:simpleType name="Colours"><xs:list itemType="Colour"/></xs:simpleType>
	<xs:simpleType name="Short"><xs:restriction base="Numbers"><xs:minLength value="1"/><xs:maxLength value="2"/></xs:restriction></xs:simpleType>
	<xs:simpleType name="Pair"><xs:restriction base="Numbers"><xs:enumeration value="1 2"/><xs:enumeration value="3 4"/></xs:restriction></xs:simpleType>
	<xs:simpleType name="NumberOrWord"><xs:union memberTypes="xs:integer xs:NCName"/></xs:simpleType>
	<xs:simpleType name="Mixed"><xs:list itemType="NumberOrWord"/></xs:simpleType>`),
    };
    const { schema: out, verdicts } = await check(files, {
      numbers: [instance('<Numbers> 1 +02\n 3 </Numbers>'), true],
      empty: [instance('<Numbers/>'), true],
      notANumber: [instance('<Numbers>1 x</Numbers>'), false],
      repeated: [instance('<Repeated>6</Repeated><Repeated>7 8</Repeated>'), true],
      short: [instance('<Short>1 2</Short>'), true],
      tooShort: [instance('<Short/>'), false],
      tooLong: [instance('<Short>1 2 3</Short>'), false],
      pair: [instance('<Pair>+01 002</Pair>'), true],
      otherPair: [instance('<Pair>1 3</Pair>'), false],
      mixed: [instance('<Mixed>1 a 22</Mixed>'), true],
      mixedNoName: [instance('<Mixed>1 -a</Mixed>'), false],
      tokens: [instance('<Tokens>a b</Tokens>'), true],
      measured: [instance('<Measured unit="m">1 2</Measured>'), true],
      measuredNoNumber: [instance('<Measured>x</Measured>'), false],
      attribute: [instance('', 'codes=" red  green "'), true],
      attributeNoColour: [instance('', 'codes="red blue"'), false],
      // libxml2 compares a fixed value as written, so the test keeps to the same text.
      flags: [instance('<Flags>true 0</Flags>'), true],
      otherFlags: [instance('<Flags>true true</Flags>'), false],
    });
    const value = (name: string) => verdicts.find((v) => v.name === name)?.value;
    expect(value('numbers')).toEqual({ Numbers: [1, 2, 3] });
    expect(value('empty')).toEqual({ Numbers: [] });
    expect(value('repeated')).toEqual({ Repeated: [[6], [7, 8]] });
    expect(value('mixed')).toEqual({ Mixed: ['1', 'a', '22'] });
    expect(value('measured')).toEqual({ Measured: { unit: 'm', value: [1, 2] } });
    expect(value('attribute')).toEqual({ codes: ['red', 'green'] });
    expect(value('flags')).toEqual({ Flags: [true, false] });
    expect(def(out, 'Pair')).toMatchObject({
      type: 'array',
      enum: [
        [1, 2],
        [3, 4],
      ],
      xml: { list: true },
    });
    expect(prop(out, 'Repeated')).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/Numbers' },
      maxItems: 2,
      xml: { namespace: 'urn:t' },
    });
    expect(prop(out, 'Flags')).toMatchObject({ const: [true, false], xml: { namespace: 'urn:t', list: true } });
  });

  it('on a root element of a list type', async () => {
    const files = {
      'root.xsd': schema(
        '<xs:element name="Root"><xs:simpleType><xs:list itemType="xs:int"/></xs:simpleType></xs:element>',
      ),
    };
    const doc = (text: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Root xmlns="urn:t">${text}</Root>`;
    const { schema: out, verdicts } = await check(files, { two: [doc(' 1 2 '), true], word: [doc('1 x'), false] });
    expect(out.xml).toEqual({ name: 'Root', namespace: 'urn:t', list: true });
    expect(verdicts[0]?.value).toEqual([1, 2]);
  });

  it('on xsi:nil: null without attributes, an object with the attributes and a null text with them', async () => {
    const files = {
      'nil.xsd': schema(`
	<xs:complexType name="Count"><xs:simpleContent><xs:extension base="xs:int"/></xs:simpleContent></xs:complexType>
	<xs:complexType name="Abstract" abstract="true"><xs:attribute name="tag" type="xs:string"/></xs:complexType>
	<xs:complexType name="Concrete"><xs:complexContent><xs:extension base="Abstract"/></xs:complexContent></xs:complexType>
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="D" type="xs:date" nillable="true" minOccurs="0"/>
				<xs:element name="A" nillable="true" minOccurs="0">
					<xs:complexType>
						<xs:sequence><xs:element name="Place" type="xs:string"/></xs:sequence>
						<xs:attribute name="kind" type="xs:string" use="required"/>
					</xs:complexType>
				</xs:element>
				<xs:element name="B" nillable="true" minOccurs="0">
					<xs:complexType>
						<xs:simpleContent><xs:extension base="xs:decimal"><xs:attribute name="unit" type="xs:string"/></xs:extension></xs:simpleContent>
					</xs:complexType>
				</xs:element>
				<xs:element name="L" type="xs:int" nillable="true" minOccurs="0" maxOccurs="3"/>
				<xs:element name="N" type="xs:int" minOccurs="0"/>
				<xs:element name="Fixed" type="xs:int" fixed="7" nillable="true" minOccurs="0"/>
				<xs:element name="FixedContent" type="Count" fixed="7" nillable="true" minOccurs="0"/>
				<xs:element name="Default" type="xs:int" default="8" nillable="true" minOccurs="0"/>
				<xs:element name="Typed" type="Abstract" nillable="true" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const xsi = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    const { verdicts } = await check(files, {
      date: [instance('<D xsi:nil="true"/>', xsi), true],
      dateWithValue: [instance('<D xsi:nil="false">2026-11-11</D>', xsi), true],
      nilWithContent: [instance('<D xsi:nil="true">2026-11-11</D>', xsi), false],
      nilWithSpace: [instance('<D xsi:nil="true"> </D>', xsi), false],
      attributes: [instance('<A kind="x" xsi:nil="1"/>', xsi), true],
      requiredAttributeMissing: [instance('<A xsi:nil="true"/>', xsi), false],
      content: [instance('<A kind="x"><Place>p</Place></A>', xsi), true],
      simpleContent: [instance('<B unit="EUR" xsi:nil="true"/>', xsi), true],
      simpleContentNoAttributes: [instance('<B xsi:nil="true"/>', xsi), true],
      repeated: [instance('<L>1</L><L xsi:nil="true"/><L>3</L>', xsi), true],
      notNillable: [instance('<N xsi:nil="true"/>', xsi), false],
      fixedNil: [instance('<Fixed xsi:nil="true"/>', xsi), false],
      fixedNotNil: [instance('<Fixed xsi:nil="false"/>', xsi), true],
      fixedEmpty: [instance('<Fixed/>', xsi), true],
      fixedWrong: [instance('<Fixed xsi:nil="false">8</Fixed>', xsi), false],
      fixedContentNotNil: [instance('<FixedContent xsi:nil="0"/>', xsi), true],
      fixedContentNil: [instance('<FixedContent xsi:nil="1"/>', xsi), false],
      defaultNil: [instance('<Default xsi:nil="true"/>', xsi), true],
      abstractNil: [instance('<Typed xsi:nil="true"/>', xsi), false],
      abstractNilWithAttribute: [instance('<Typed xsi:nil="true" tag="x"/>', xsi), false],
      derivedNil: [instance('<Typed xsi:nil="true" xsi:type="Concrete" tag="x"/>', xsi), true],
    });
    const value = (name: string) => verdicts.find((v) => v.name === name)?.value;
    expect(value('date')).toEqual({ D: null });
    expect(value('attributes')).toEqual({ A: { kind: 'x', value: null } });
    expect(value('simpleContent')).toEqual({ B: { unit: 'EUR', value: null } });
    expect(value('simpleContentNoAttributes')).toEqual({ B: null });
    expect(value('repeated')).toEqual({ L: [1, null, 3] });
    expect(value('fixedNotNil')).toEqual({ Fixed: 7 });
    expect(value('fixedEmpty')).toEqual({ Fixed: 7 });
    expect(value('fixedContentNotNil')).toEqual({ FixedContent: { value: 7 } });
    expect(value('defaultNil')).toEqual({ Default: null });
    expect(value('derivedNil')).toEqual({ Typed: { '#type': '{urn:t}Concrete', tag: 'x', value: null } });
    expect(value('nilWithContent')).toEqual({
      error: '/Root/D: the element is nil and has content',
      code: 'nil-content',
    });
  });

  it.each([
    { constraint: 'fixed', placement: 'root' },
    { constraint: 'fixed', placement: 'reference' },
    { constraint: 'default', placement: 'root' },
    { constraint: 'default', placement: 'reference' },
  ])('keeps a $constraint value on a $placement with derived simple content', async ({ constraint, placement }) => {
    const root = placement === 'root';
    const declaration = `<xs:element name="${root ? 'Root' : 'Item'}" type="Base" ${constraint}="7" nillable="true"/>`;
    const containing = `<xs:element name="Root"><xs:complexType><xs:sequence><xs:element ref="Item"/>
                         </xs:sequence></xs:complexType></xs:element>`;
    const files = {
      'value.xsd': schema(`
        <xs:complexType name="Base"><xs:simpleContent><xs:extension base="xs:int"/></xs:simpleContent></xs:complexType>
        <xs:complexType name="Derived"><xs:simpleContent><xs:extension base="Base">
          <xs:attribute name="unit" type="xs:string"/>
        </xs:extension></xs:simpleContent></xs:complexType>
        ${declaration}
        ${root ? '' : containing}`),
    };
    const doc = (text: string, nil = '') => {
      const attrs = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Derived" unit="kg" ${nil}`;
      return root ? instance(text, attrs) : instance(`<Item ${attrs}>${text}</Item>`);
    };
    const { verdicts } = await check(files, {
      empty: [doc(''), true],
      notNil: [doc('', 'xsi:nil="false"'), true],
      same: [doc('7', 'xsi:nil="false"'), true],
      different: [doc('8', 'xsi:nil="false"'), constraint === 'default'],
      nil: [doc('', 'xsi:nil="true"'), constraint === 'default'],
    });
    const value = { '#type': '{urn:t}Derived', unit: 'kg', value: 7 };
    const expected = root ? value : { Item: value };
    expect(verdicts.find((v) => v.name === 'empty')?.value).toEqual(expected);
    expect(verdicts.find((v) => v.name === 'notNil')?.value).toEqual(expected);
  });

  it('on wildcard content: written without a schema, and #unknown outside wildcards', async () => {
    const files = {
      'any.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Ext" minOccurs="0">
					<xs:complexType>
						<xs:sequence><xs:any namespace="##other" processContents="lax" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
						<xs:anyAttribute namespace="##other" processContents="skip"/>
					</xs:complexType>
				</xs:element>
				<xs:element name="Open" minOccurs="0">
					<xs:complexType>
						<xs:sequence>
							<xs:element name="Required" type="xs:int"/>
							<xs:any namespace="##any" processContents="skip" minOccurs="0"/>
						</xs:sequence>
					</xs:complexType>
				</xs:element>
				<xs:element name="Closed" minOccurs="0">
					<xs:complexType><xs:sequence><xs:element name="Value" type="xs:int"/></xs:sequence></xs:complexType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const f = 'xmlns:f="urn:f" xmlns:g="urn:g"';
    const { schema: out, verdicts } = await check(files, {
      ext: [instance('<Ext f:a="1"><f:x>one</f:x><f:x> two </f:x><f:y f:b="2">y</f:y><f:empty/></Ext>', f), true],
      nested: [instance('<Ext><f:z>\n  <f:w>deep</f:w>\n</f:z><f:m>before<f:b>bold</f:b>after</f:m></Ext>', f), true],
      openAny: [instance('<Open><Required>1</Required><f:x>x</f:x></Open>', f), true],
      closedForeign: [instance('<Closed><Value>1</Value><f:x>2</f:x></Closed>', f), false],
    });
    const value = (name: string) => verdicts.find((v) => v.name === name)?.value;
    expect(value('ext')).toEqual({ Ext: { a: '1', x: ['one', ' two '], y: { b: '2', value: 'y' }, empty: '' } });
    expect(value('nested')).toEqual({
      Ext: { z: { w: 'deep' }, m: { value: 'before<f:b xmlns:f="urn:f">bold</f:b>after' } },
    });
    expect(value('closedForeign')).toEqual({ Closed: { Value: 1, '#unknown:f:x': true } });
    expect(prop(out, 'Ext')).toMatchObject({ xml: { namespace: 'urn:t', anyElement: true, anyAttribute: true } });
    expect(prop(out, 'Ext')).not.toHaveProperty('additionalProperties');
    // Valid XML the JSON form has no place for: names that collide.
    const { verdicts: collisions } = await compare({
      files,
      entry: 'any.xsd',
      root: 'Root',
      instances: {
        attributeAndChild: instance('<Ext f:x="1"><f:x>2</f:x></Ext>', f),
        twoNamespaces: instance('<Ext><f:x>1</f:x><g:x>2</g:x></Ext>', f),
        declaredName: instance('<Open><Required>1</Required><Required>2</Required></Open>', f),
      },
    });
    expect(collisions.map((v) => [v.xsd, v.value])).toEqual([
      [true, { error: '/Root/Ext/f:x: x is already a property of the object', code: 'name-collision' }],
      [true, { error: '/Root/Ext/g:x: x comes from two namespaces', code: 'name-collision' }],
      [true, { error: '/Root/Open/Required: Required is already a property of the object', code: 'name-collision' }],
    ]);
  });

  it('on substitution groups: a choice between the head and its members, also transitive and blocked ones', async () => {
    const files = {
      'subst.xsd': schema(`
	<xs:complexType name="Doc"><xs:sequence><xs:element name="Number" type="xs:string"/></xs:sequence></xs:complexType>
	<xs:complexType name="Bill"><xs:complexContent><xs:extension base="Doc"><xs:sequence>
		<xs:element name="Amount" type="xs:decimal"/>
	</xs:sequence></xs:extension></xs:complexContent></xs:complexType>
	<xs:element name="Document" type="Doc" abstract="true"/>
	<xs:element name="Invoice" type="Bill" substitutionGroup="Document"/>
	<xs:element name="Credit" substitutionGroup="Document"/>
	<xs:element name="Draft" type="Doc" substitutionGroup="Document" abstract="true"/>
	<xs:element name="Sketch" type="Doc" substitutionGroup="Draft"/>
	<xs:element name="Note" type="xs:string"/>
	<xs:element name="Memo" type="xs:token" substitutionGroup="Note"/>
	<xs:element name="Closed" type="Doc" block="extension"/>
	<xs:element name="OpenBill" type="Bill" substitutionGroup="Closed"/>
	<xs:element name="Plain" type="Doc" substitutionGroup="Closed"/>
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element ref="Document" maxOccurs="2"/>
				<xs:element ref="Note" minOccurs="0"/>
				<xs:element ref="Closed" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const number = '<Number>1</Number>';
    const { schema: out, verdicts } = await check(files, {
      invoice: [instance(`<Invoice>${number}<Amount>9.5</Amount></Invoice>`), true],
      creditTakesHeadType: [instance(`<Credit>${number}</Credit>`), true],
      transitive: [instance(`<Sketch>${number}</Sketch>`), true],
      mixedMembers: [instance(`<Credit>${number}</Credit><Invoice>${number}<Amount>1</Amount></Invoice>`), true],
      abstractHead: [instance(`<Document>${number}</Document>`), false],
      abstractMember: [instance(`<Draft>${number}</Draft>`), false],
      tooMany: [instance(`<Credit>${number}</Credit><Credit>${number}</Credit><Credit>${number}</Credit>`), false],
      none: [instance(''), false],
      head: [instance(`<Credit>${number}</Credit><Note>n</Note>`), true],
      member: [instance(`<Credit>${number}</Credit><Memo> m </Memo>`), true],
      headAndMember: [instance(`<Credit>${number}</Credit><Note>n</Note><Memo>m</Memo>`), false],
      plainMember: [instance(`<Credit>${number}</Credit><Plain>${number}</Plain>`), true],
      blockedMember: [instance(`<Credit>${number}</Credit><OpenBill>${number}<Amount>1</Amount></OpenBill>`), false],
    });
    expect(verdicts.find((v) => v.name === 'mixedMembers')?.value).toEqual({
      Credit: [{ Number: '1' }],
      Invoice: [{ Number: '1', Amount: 1 }],
    });
    expect(verdicts.find((v) => v.name === 'member')?.value).toEqual({ Credit: [{ Number: '1' }], Memo: 'm' });
    expect(Object.keys(out.properties ?? {})).toEqual([
      'Invoice',
      'Credit',
      'Sketch',
      'Note',
      'Memo',
      'Closed',
      'Plain',
    ]);
  });

  it('on xsi:type: a derived type in #type, an abstract type, and the declared type named on its own', async () => {
    const files = {
      'types.xsd': schema(`
	<xs:complexType name="Vehicle" abstract="true"><xs:sequence><xs:element name="Plate" type="xs:string"/></xs:sequence></xs:complexType>
	<xs:complexType name="Car"><xs:complexContent><xs:extension base="Vehicle"><xs:sequence>
		<xs:element name="Seats" type="xs:int"/>
	</xs:sequence></xs:extension></xs:complexContent></xs:complexType>
	<xs:complexType name="Animal"><xs:sequence><xs:element name="Name" type="xs:string"/></xs:sequence></xs:complexType>
	<xs:complexType name="Dog"><xs:complexContent><xs:extension base="Animal"><xs:sequence>
		<xs:element name="Breed" type="xs:string" minOccurs="0"/>
	</xs:sequence></xs:extension></xs:complexContent></xs:complexType>
	<xs:complexType name="Price"><xs:simpleContent><xs:extension base="xs:decimal">
		<xs:attribute name="currency" type="xs:string"/>
	</xs:extension></xs:simpleContent></xs:complexType>
	<xs:complexType name="Euro"><xs:simpleContent><xs:restriction base="Price"><xs:fractionDigits value="2"/></xs:restriction></xs:simpleContent></xs:complexType>
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Vehicle" type="Vehicle" minOccurs="0"/>
				<xs:element name="Pet" type="Animal" minOccurs="0" maxOccurs="2"/>
				<xs:element name="Cost" type="Price" minOccurs="0"/>
				<xs:element name="Kept" type="Animal" block="extension" minOccurs="0"/>
				<xs:element name="Maybe" type="Animal" nillable="true" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const xsi = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    const { verdicts } = await check(files, {
      car: [instance('<Vehicle xsi:type="Car"><Plate>K</Plate><Seats>4</Seats></Vehicle>', xsi), true],
      abstract: [instance('<Vehicle><Plate>K</Plate></Vehicle>', xsi), false],
      abstractNamed: [instance('<Vehicle xsi:type="Vehicle"><Plate>K</Plate></Vehicle>', xsi), false],
      pets: [instance('<Pet><Name>a</Name></Pet><Pet xsi:type="Dog"><Name>b</Name><Breed>c</Breed></Pet>', xsi), true],
      declaredNamed: [instance('<Pet xsi:type="Animal"><Name>a</Name></Pet>', xsi), true],
      fieldWithoutType: [instance('<Pet><Name>a</Name><Breed>c</Breed></Pet>', xsi), false],
      unknownType: [instance('<Pet xsi:type="Cat"><Name>a</Name></Pet>', xsi), false],
      euro: [instance('<Cost xsi:type="Euro" currency="EUR">1.25</Cost>', xsi), true],
      euroDigits: [instance('<Cost xsi:type="Euro">1.255</Cost>', xsi), false],
      blocked: [instance('<Kept xsi:type="Dog"><Name>b</Name></Kept>', xsi), false],
      nilTyped: [instance('<Maybe xsi:type="Dog" xsi:nil="true"/>', xsi), true],
    });
    const value = (name: string) => verdicts.find((v) => v.name === name)?.value;
    expect(value('car')).toEqual({ Vehicle: { '#type': '{urn:t}Car', Plate: 'K', Seats: 4 } });
    expect(value('pets')).toEqual({ Pet: [{ Name: 'a' }, { '#type': '{urn:t}Dog', Name: 'b', Breed: 'c' }] });
    expect(value('declaredNamed')).toEqual({ Pet: [{ '#type': '{urn:t}Animal', Name: 'a' }] });
    expect(value('euro')).toEqual({ Cost: { '#type': '{urn:t}Euro', currency: 'EUR', value: 1.25 } });
    expect(value('nilTyped')).toEqual({ Maybe: { '#type': '{urn:t}Dog', value: null } });
  });

  it('on xsi:type on an element of a simple type: only the declared type, which changes nothing', async () => {
    const files = {
      'simple.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="N" type="xs:decimal" minOccurs="0"/>
				<xs:element name="C" type="Code" minOccurs="0"/>
				<xs:element name="L" minOccurs="0"><xs:simpleType><xs:restriction base="xs:token"/></xs:simpleType></xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="Code"><xs:restriction base="xs:token"><xs:length value="2"/></xs:restriction></xs:simpleType>
	<xs:simpleType name="Short"><xs:restriction base="Code"><xs:pattern value="[A-Z]+"/></xs:restriction></xs:simpleType>`),
    };
    const ns = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema"';
    const { verdicts } = await check(files, {
      declared: [instance('<N xsi:type="xs:decimal">5</N><C xsi:type="Code">ab</C>', ns), true],
      declaredWrongValue: [instance('<C xsi:type="Code">abc</C>', ns), false],
    });
    expect(verdicts[0]?.value).toEqual({ N: 5, C: 'ab' });
    // A derived simple type has no JSON form. An anonymous type can't be named, so its base is no valid choice.
    const { verdicts: errors } = await compare({
      files,
      entry: 'simple.xsd',
      root: 'Root',
      instances: {
        derived: instance('<N xsi:type="xs:integer">5</N>', ns),
        derivedNamed: instance('<C xsi:type="Short">AB</C>', ns),
        anonymous: instance('<L xsi:type="xs:token">a</L>', ns),
      },
    });
    expect(errors.map((v) => [v.xsd, v.value])).toEqual([
      [true, { error: '/Root/N: xsi:type xs:integer on an element of a simple type', code: 'xsi-type-simple' }],
      [true, { error: '/Root/C: xsi:type Short on an element of a simple type', code: 'xsi-type-simple' }],
      [false, { error: '/Root/L: xsi:type xs:token on an element of a simple type', code: 'xsi-type-simple' }],
    ]);
  });

  it('on XML names: the name characters of XML 1.0, Second Edition, and one definition per built-in name type', async () => {
    const files = {
      'names.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="N" type="xs:NCName" minOccurs="0" maxOccurs="unbounded"/>
				<xs:element name="Short" type="ShortName" minOccurs="0"/>
				<xs:element name="P" type="Pattern" minOccurs="0"/>
				<xs:element name="T" type="xs:NMTOKEN" minOccurs="0"/>
			</xs:sequence>
			<xs:attribute name="id" type="xs:ID"/>
		</xs:complexType>
	</xs:element>
	<xs:simpleType name="ShortName"><xs:restriction base="xs:NCName"><xs:maxLength value="3"/></xs:restriction></xs:simpleType>
	<xs:simpleType name="Pattern"><xs:restriction base="xs:string"><xs:pattern value="\\i\\c*"/></xs:restriction></xs:simpleType>`),
    };
    const { schema: out } = await check(files, {
      names: [instance('<N>a</N><N>é1</N><N>a١</N><N>_x.y-z</N>'), true],
      digitFirst: [instance('<N>١٢</N>'), false],
      titlecase: [instance('<N>ǅa</N>'), false],
      letterNumber: [instance('<N>aⅫ</N>'), false],
      colon: [instance('<N>a:b</N>'), false],
      short: [instance('<Short>abc</Short>'), true],
      tooLong: [instance('<Short>abcd</Short>'), false],
      shortDigitFirst: [instance('<Short>1a</Short>'), false],
      pattern: [instance('<P>a:b١</P>'), true],
      patternTitlecase: [instance('<P>ǅ</P>'), false],
      token: [instance('<T>١a</T>'), true],
      tokenLetterNumber: [instance('<T>Ⅻ</T>'), false],
      id: [instance('', 'id="x1"'), true],
      idDigitFirst: [instance('', 'id="1x"'), false],
    });
    // Each built-in name type is one definition; derived types refer to it and add their own facets.
    expect(def(out, 'NCName')).toMatchObject({ type: 'string', xml: { whiteSpace: 'collapse' } });
    expect(def(out, 'ShortName')).toMatchObject({ $ref: '#/$defs/NCName', type: 'string', maxLength: 3 });
    expect(def(out, 'ShortName')).not.toHaveProperty('pattern');
    expect((prop(out, 'N').items as JsonSchema).$ref).toBe('#/$defs/NCName');
    expect(prop(out, 'id')).toMatchObject({ $ref: '#/$defs/ID' });
    // The name characters appear in the definitions of NCName, ID and NMTOKEN and in the own pattern, nowhere else.
    const patterns: string[] = [];
    const collect = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'pattern' && typeof inner === 'string') {
            patterns.push(inner);
          } else {
            collect(inner);
          }
        }
      }
    };
    collect(out);
    expect(patterns.filter((p) => p.includes('\\u0041-\\u005A'))).toEqual([
      def(out, 'NCName').pattern,
      def(out, 'Pattern').pattern,
      def(out, 'NMTOKEN').pattern,
      def(out, 'ID').pattern,
    ]);
  });

  it('on empty elements: they take the fixed or default value, but not with white space in them', async () => {
    const files = {
      'empty.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="D" type="xs:integer" default="5" minOccurs="0"/>
				<xs:element name="F" type="xs:string" fixed="abc" minOccurs="0"/>
				<xs:element name="B" type="xs:boolean" fixed="true" minOccurs="0"/>
				<xs:element name="U" default="x" minOccurs="0"/>
				<xs:element name="P" minOccurs="0" default="2.5">
					<xs:complexType>
						<xs:simpleContent>
							<xs:extension base="xs:decimal"><xs:attribute name="unit" type="xs:string"/></xs:extension>
						</xs:simpleContent>
					</xs:complexType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      empty: [instance('<D/><F></F><B/><U/><P unit="m"/>'), true],
      written: [instance('<D>7</D><F>abc</F><B>true</B><P>3</P>'), true],
      space: [instance('<D> </D>'), false],
      wrongFixed: [instance('<F>abd</F>'), false],
      emptyWithComment: [instance('<D><!-- none --></D>'), true],
    });
  });

  it('on repeated groups that need more occurrences than a greedy reading gives', async () => {
    const files = {
      'groups.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:choice>
				<xs:sequence minOccurs="2" maxOccurs="2">
					<xs:element name="A" type="xs:string" maxOccurs="2"/>
				</xs:sequence>
				<xs:sequence minOccurs="2" maxOccurs="2">
					<xs:element name="C" type="xs:string" maxOccurs="2"/>
					<xs:element name="D" type="xs:string" minOccurs="0"/>
				</xs:sequence>
				<xs:choice minOccurs="0" maxOccurs="unbounded">
					<xs:element name="E" type="xs:string" minOccurs="3" maxOccurs="5"/>
					<xs:element name="F" type="xs:string" minOccurs="3" maxOccurs="5"/>
				</xs:choice>
			</xs:choice>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      twoA: [instance('<A/><A/>'), true],
      fourA: [instance('<A/><A/><A/><A/>'), true],
      oneA: [instance('<A/>'), false],
      fiveA: [instance('<A/><A/><A/><A/><A/>'), false],
      splitBeforeD: [instance('<C/><C/><D/>'), true],
      sixE: [instance('<E/><E/><E/><E/><E/><E/>'), true],
      twoE: [instance('<E/><E/>'), false],
    });
  });

  it('on xsi:nil: any value of it needs a nillable element, and it has to be a boolean', async () => {
    const files = {
      'nil.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="S" type="xs:string" minOccurs="0"/>
				<xs:element name="N" type="xs:string" nillable="true" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const xsi = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    await check(files, {
      nilFalseNotNillable: [instance(`<S ${xsi} xsi:nil="false">x</S>`), false],
      nilFalseNillable: [instance(`<N ${xsi} xsi:nil="false">x</N>`), true],
      nilTrueNillable: [instance(`<N ${xsi} xsi:nil="1"/>`), true],
      nilNoBoolean: [instance(`<N ${xsi} xsi:nil="yes">x</N>`), false],
    });
  });

  it('on the lexical forms of numbers: no exponent for decimals, digits only for integers', async () => {
    const files = {
      'numbers.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Dec" type="xs:decimal" minOccurs="0"/>
				<xs:element name="Int" type="xs:integer" minOccurs="0"/>
				<xs:element name="Small" type="xs:int" nillable="true" minOccurs="0"/>
				<xs:element name="Dbl" type="xs:double" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      plain: [instance('<Dec>+1.50</Dec><Int>-007</Int><Small>12</Small><Dbl>1E4</Dbl>'), true],
      decimalExponent: [instance('<Dec>-1E4</Dec>'), false],
      decimalFractionOnly: [instance('<Dec>.5</Dec>'), true],
      integerFraction: [instance('<Int>+0.0</Int>'), false],
      integerExponent: [instance('<Int>1e2</Int>'), false],
      nillableExponent: [instance('<Small>1e2</Small>'), false],
    });
  });

  it('on mixed="1", a prohibited attribute in an attribute group and xs:anySimpleType', async () => {
    const files = {
      'misc.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="M" minOccurs="0"><xs:complexType mixed="1"/></xs:element>
				<xs:element name="R" type="Derived" minOccurs="0"/>
				<xs:element name="S" type="xs:anySimpleType" minOccurs="0"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:element name="X"/>
	<xs:complexType name="Base"><xs:attribute name="a"/></xs:complexType>
	<xs:complexType name="Derived">
		<xs:complexContent><xs:restriction base="Base"><xs:attributeGroup ref="Group"/></xs:restriction></xs:complexContent>
	</xs:complexType>
	<xs:attributeGroup name="Group"><xs:attribute name="a" use="prohibited"/></xs:attributeGroup>`),
    };
    const { schema: out } = await check(files, {
      mixedText: [instance('<M>text</M>'), true],
      kept: [instance('<R a="x"/>'), true],
      other: [instance('<R b="x"/>'), false],
      simpleText: [instance('<S> any text </S>'), true],
      simpleChild: [instance('<S><X/></S>'), false],
    });
    expect(prop(out, 'S')).toMatchObject({ type: 'string' });
  });

  it('on value equality: time zones, fractional seconds, hexBinary case and numbers in unions', async () => {
    const files = {
      'values.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="T" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType>
						<xs:restriction base="xs:dateTime">
							<xs:enumeration value="2002-01-01T12:00:00-00:00"/>
							<xs:enumeration value="2002-01-01T13:00:00.50+01:00"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="Day" type="xs:date" fixed="2002-01-01Z" minOccurs="0"/>
				<xs:element name="H" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:hexBinary"><xs:enumeration value="0aFF"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="U" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType>
						<xs:restriction>
							<xs:simpleType><xs:union memberTypes="xs:boolean xs:int xs:NCName"/></xs:simpleType>
							<xs:enumeration value="1"/>
							<xs:enumeration value="007"/>
							<xs:enumeration value="abc"/>
						</xs:restriction>
					</xs:simpleType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const { schema: out } = await check(files, {
      utc: [
        instance('<T>2002-01-01T12:00:00Z</T><T>2002-01-01T12:00:00+00:00</T><T>2002-01-01T12:00:00.000-00:00</T>'),
        true,
      ],
      fraction: [instance('<T>2002-01-01T13:00:00.5+01:00</T><T>2002-01-01T13:00:00.500+01:00</T>'), true],
      otherTime: [instance('<T>2002-01-01T12:00:01Z</T>'), false],
      noZone: [instance('<T>2002-01-01T12:00:00</T>'), false],
      day: [instance('<Day>2002-01-01Z</Day>'), true],
      dayEmpty: [instance('<Day/>'), true],
      otherDay: [instance('<Day>2002-01-02Z</Day>'), false],
      hex: [instance('<H>0AFF</H><H>0aff</H>'), true],
      otherHex: [instance('<H>0AFE</H>'), false],
      union: [instance('<U>true</U><U>7</U><U>+0007</U><U>abc</U>'), true],
      unionOther: [instance('<U>8</U>'), false],
      unionFalse: [instance('<U>false</U>'), false],
    });
    expect(prop(out, 'Day')).toMatchObject({ default: '2002-01-01Z' });
    expect(prop(out, 'Day')).not.toHaveProperty('const');
  });

  it('on block of a substitution group head type and on members of an anonymous type', async () => {
    const files = {
      'block.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element ref="Head" minOccurs="0" maxOccurs="unbounded"/>
				<xs:element ref="Second" minOccurs="0" maxOccurs="unbounded"/>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:element name="Head" type="HeadType" block="extension"/>
	<xs:complexType name="HeadType"><xs:sequence><xs:element name="A" type="xs:string"/></xs:sequence></xs:complexType>
	<xs:element name="Member" substitutionGroup="Head">
		<xs:complexType>
			<xs:complexContent>
				<xs:extension base="HeadType"><xs:sequence><xs:element name="B" type="xs:string"/></xs:sequence></xs:extension>
			</xs:complexContent>
		</xs:complexType>
	</xs:element>
	<xs:element name="Second" type="Blocking"/>
	<xs:complexType name="Blocking" block="restriction"><xs:sequence><xs:element name="A" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType>
	<xs:complexType name="Narrow"><xs:complexContent><xs:restriction base="Blocking"/></xs:complexContent></xs:complexType>
	<xs:element name="SecondMember" type="Narrow" substitutionGroup="Second"/>`),
    };
    await check(files, {
      heads: [instance('<Head><A/></Head><Second/>'), true],
      anonymousExtension: [instance('<Member><A/><B/></Member>'), false],
      typeBlocksRestriction: [instance('<SecondMember/>'), false],
    });
  });

  it('on choices without possible particles and on wildcards in repeated groups', async () => {
    const files = {
      'choice.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:choice minOccurs="0" maxOccurs="unbounded">
					<xs:element name="A" type="xs:string"/>
					<xs:choice><xs:element name="None" type="xs:string" minOccurs="0" maxOccurs="0"/></xs:choice>
				</xs:choice>
				<xs:element name="W" minOccurs="0">
					<xs:complexType>
						<xs:choice maxOccurs="unbounded"><xs:any namespace="##any" processContents="skip"/></xs:choice>
					</xs:complexType>
				</xs:element>
				<xs:element name="Bounded" minOccurs="0">
					<xs:complexType>
						<xs:sequence maxOccurs="2">
							<xs:element name="A" type="xs:string" minOccurs="0"/>
							<xs:any namespace="##other" processContents="skip" minOccurs="0" maxOccurs="unbounded"/>
						</xs:sequence>
					</xs:complexType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    const { verdicts } = await check(files, {
      choice: [instance('<A/><A/>'), true],
      wildcard: [instance('<W><e1><a1>x</a1></e1><e2/></W>'), true],
      manyInFewOccurrences: [
        instance('<Bounded><A/><o:x xmlns:o="urn:o"/><o:x xmlns:o="urn:o"/><o:x xmlns:o="urn:o"/></Bounded>'),
        true,
      ],
    });
    expect(verdicts.find((v) => v.name === 'wildcard')?.value).toEqual({
      W: { '#choice': [{ e1: { a1: 'x' } }, { e2: '' }] },
    });
  });

  it('on a local element that contains itself through a group: a definition of its anonymous type', async () => {
    const files = {
      'local.xsd': schema(`
	<xs:element name="Root"><xs:complexType><xs:group ref="Expr"/></xs:complexType></xs:element>
	<xs:group name="Expr">
		<xs:choice>
			<xs:element name="Num" type="xs:integer"/>
			<xs:element name="Neg"><xs:complexType><xs:group ref="Expr"/></xs:complexType></xs:element>
		</xs:choice>
	</xs:group>`),
    };
    const { schema: out } = await check(files, {
      number: [instance('<Num>1</Num>'), true],
      nested: [instance('<Neg><Neg><Num>2</Num></Neg></Neg>'), true],
      wrong: [instance('<Neg><Neg><Num>x</Num></Neg></Neg>'), false],
      empty: [instance('<Neg/>'), false],
    });
    expect(prop(out, 'Neg')).toMatchObject({ type: 'object' });
    expect(prop(prop(out, 'Neg'), 'Neg')).toEqual({ $ref: '#/$defs/Neg', xml: { namespace: 'urn:t' } });
    expect(prop(def(out, 'Neg'), 'Neg')).toEqual({ $ref: '#/$defs/Neg', xml: { namespace: 'urn:t' } });
  });

  it('on INF, -INF and NaN: strings for float and double, as far as bounds, patterns and enumerations allow', async () => {
    const files = {
      'special.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="D" type="xs:double" minOccurs="0" maxOccurs="unbounded"/>
				<xs:element name="Max" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:float"><xs:maxExclusive value="10"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="FromInf" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:double"><xs:minInclusive value="INF"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="E" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType>
						<xs:restriction base="xs:double"><xs:enumeration value="1.5"/><xs:enumeration value="NaN"/></xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="P" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:double"><xs:pattern value="[^a]*"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="U" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:union memberTypes="xs:decimal xs:double"/></xs:simpleType>
				</xs:element>
				<xs:element name="L" minOccurs="0">
					<xs:simpleType><xs:list itemType="xs:float"/></xs:simpleType>
				</xs:element>
			</xs:sequence>
			<xs:attribute name="a" type="xs:double"/>
		</xs:complexType>
	</xs:element>`),
    };
    const { verdicts } = await check(files, {
      all: [instance('<D>INF</D><D>-INF</D><D>NaN</D><D> 1e3 </D>', 'a="-INF"'), true],
      plusInf: [instance('<D>+INF</D>'), false],
      lowercase: [instance('<D>inf</D>'), false],
      belowMax: [instance('<Max>-INF</Max><Max>9.5</Max>'), true],
      infAboveMax: [instance('<Max>INF</Max>'), false],
      nanWithBound: [instance('<Max>NaN</Max>'), false],
      fromInf: [instance('<FromInf>INF</FromInf>'), true],
      numberBelowInf: [instance('<FromInf>1e308</FromInf>'), false],
      enumerated: [instance('<E>NaN</E><E>1.50</E>'), true],
      notEnumerated: [instance('<E>INF</E>'), false],
      pattern: [instance('<P>INF</P><P>-INF</P>'), true],
      patternExcludesNaN: [instance('<P>NaN</P>'), false],
      union: [instance('<U>1.5</U><U>INF</U>'), true],
      list: [instance('<L>1 INF -INF NaN</L>'), true],
      beyondDouble: [instance('<D>1E309</D><D>-1E309</D>'), true],
    });
    expect(verdicts.find((v) => v.name === 'all')?.value).toEqual({ a: '-INF', D: ['INF', '-INF', 'NaN', 1000] });
    expect(verdicts.find((v) => v.name === 'list')?.value).toEqual({ L: [1, 'INF', '-INF', 'NaN'] });
  });

  it('on xs:float enumerations: values compare as 32-bit floats', async () => {
    const files = {
      'float.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="F" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType>
						<xs:restriction base="xs:float"><xs:enumeration value="0.1"/><xs:enumeration value="3"/></xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="D" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:double"><xs:enumeration value="0.1"/></xs:restriction></xs:simpleType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      same: [instance('<F>0.1</F><F>0.10000000149011612</F><F>0.1000000001</F><F>3.0000001</F>'), true],
      other: [instance('<F>0.1000001</F>'), false],
      double: [instance('<D>0.1</D>'), true],
      doubleOther: [instance('<D>0.10000000149011612</D>'), false],
    });
  });

  it('on names such as __proto__, constructor and toString: ordinary properties of their own', async () => {
    const files = {
      'proto.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="__proto__" minOccurs="0">
					<xs:complexType>
						<xs:sequence><xs:element name="polluted" type="xs:string"/></xs:sequence>
						<xs:attribute name="isAdmin" type="xs:boolean" use="required"/>
					</xs:complexType>
				</xs:element>
				<xs:element name="constructor" type="xs:string"/>
				<xs:element name="toString" type="xs:string" minOccurs="0"/>
				<xs:element name="Ext" minOccurs="0">
					<xs:complexType>
						<xs:sequence><xs:any namespace="##any" processContents="skip" maxOccurs="unbounded"/></xs:sequence>
						<xs:anyAttribute processContents="skip"/>
					</xs:complexType>
				</xs:element>
			</xs:sequence>
			<xs:attribute name="__proto__" type="xs:string"/>
			<xs:attribute name="hasOwnProperty" type="xs:int"/>
		</xs:complexType>
	</xs:element>`),
    };
    const { schema: out, verdicts } = await check(files, {
      all: [
        instance(
          '<__proto__ isAdmin="true"><polluted>x</polluted></__proto__><constructor>c</constructor><toString>t</toString>' +
            '<Ext __proto__="a"><constructor>1</constructor><valueOf>2</valueOf></Ext>',
          '__proto__="p" hasOwnProperty="1"',
        ),
        true,
      ],
      withoutConstructor: [instance('<toString>t</toString>'), false],
      wrongAttribute: [instance('<constructor>c</constructor>', 'hasOwnProperty="x"'), false],
    });
    expect(Object.getOwnPropertyNames(out?.properties ?? {})).toEqual([
      '@__proto__',
      'hasOwnProperty',
      '__proto__',
      'constructor',
      'toString',
      'Ext',
    ]);
    const json = verdicts.find((v) => v.name === 'all')?.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(json)).toEqual([
      '@__proto__',
      'hasOwnProperty',
      '__proto__',
      'constructor',
      'toString',
      'Ext',
    ]);
    expect(Object.getOwnPropertyNames(json['Ext'])).toEqual(['__proto__', 'constructor', 'valueOf']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('on xs:float bounds: they compare as 32-bit floats', async () => {
    const files = {
      'floatbounds.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="Range" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType>
						<xs:restriction base="xs:float"><xs:minInclusive value="0.1"/><xs:maxInclusive value="0.3"/></xs:restriction>
					</xs:simpleType>
				</xs:element>
				<xs:element name="Above" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:float"><xs:minExclusive value="0.1"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="Below" minOccurs="0" maxOccurs="unbounded">
					<xs:simpleType><xs:restriction base="xs:float"><xs:maxExclusive value="16777217"/></xs:restriction></xs:simpleType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>`),
    };
    await check(files, {
      inRange: [instance('<Range>0.30000001</Range><Range>0.09999999999</Range><Range>0.2</Range>'), true],
      outOfRange: [instance('<Range>0.3000001</Range>'), false],
      sameAsLowerBound: [instance('<Above>0.10000000149011612</Above>'), false],
      roundsToLowerBound: [instance('<Above>0.1000000001</Above>'), false],
      above: [instance('<Above>0.1000001</Above>'), true],
      roundsToUpperBound: [instance('<Below>16777216</Below>'), false],
      below: [instance('<Below>16777215</Below>'), true],
    });
  });

  it('on what a simple or empty type has no room for: attributes, and white space in empty content', async () => {
    const files = {
      'room.xsd': schema(`
	<xs:element name="Root">
		<xs:complexType>
			<xs:sequence>
				<xs:element name="S" type="xs:string" minOccurs="0"/>
				<xs:element name="I" type="xs:int" nillable="true" minOccurs="0"/>
				<xs:element name="E" type="Empty" minOccurs="0"/>
				<xs:element name="C" minOccurs="0">
					<xs:complexType><xs:sequence><xs:element name="X" type="xs:int"/></xs:sequence></xs:complexType>
				</xs:element>
				<xs:element name="N" minOccurs="0">
					<xs:simpleType><xs:restriction base="xs:integer"><xs:maxInclusive value="10"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="Dec" minOccurs="0">
					<xs:simpleType><xs:restriction base="xs:decimal"><xs:maxInclusive value="10000"/></xs:restriction></xs:simpleType>
				</xs:element>
				<xs:element name="Whole" minOccurs="0">
					<xs:simpleType><xs:restriction base="xs:decimal"><xs:fractionDigits value="0"/></xs:restriction></xs:simpleType>
				</xs:element>
			</xs:sequence>
		</xs:complexType>
	</xs:element>
	<xs:complexType name="Empty"/>
	<xs:complexType name="Derived"><xs:complexContent><xs:extension base="Empty"/></xs:complexContent></xs:complexType>`),
    };
    await check(files, {
      plain: [instance('<S>t</S><I>1</I><E/><C> <X>1</X> </C><N>3</N><Dec>1.5</Dec><Whole>7.0</Whole>'), true],
      attributeOnString: [instance('<S zz="1">t</S>'), false],
      attributeOnInt: [instance('<I zz="1">1</I>'), false],
      xmlLang: [instance('<S xml:lang="de">t</S>'), false],
      spaceInEmpty: [instance('<E> </E>'), false],
      fractionOfDerivedInteger: [instance('<N>1.0</N>'), false],
      exponentOfDerivedDecimal: [instance('<Dec>1e3</Dec>'), false],
    });
  });
});
