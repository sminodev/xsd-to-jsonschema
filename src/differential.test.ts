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
	</xs:complexType>`),
    };
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
      },
      { dateTime: 'pattern' },
    );
  });
});
