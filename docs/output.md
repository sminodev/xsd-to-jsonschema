# What the converter writes

`convert()` and, in Node.js, `convertFile()` write one JSON Schema 2020-12 document for one global element of an XML Schema. The
schema describes the JSON form of that element: the same data, with elements and attributes as JSON properties. The
`xml` annotations tell you how to get from one form to the other.

The README walks through [`examples/order`](../examples/order), an order schema split over three files, together
with the generated [`order.schema.json`](../examples/order/order.schema.json). This page lists the rules behind it.

## Root and definitions

- The root schema is the content of the root element, even if the element uses a named type. Its `xml` annotation
  holds the element name and namespace. The `description` comes from the element's documentation, or from its type's
  if the element has none.
- Named simple and complex types go into `$defs` and are referenced with `$ref`, in the order they are first used.
  Types the root element never reaches are left out.
- A global element with an anonymous complex type that other elements reference with `ref` gets a `$defs` entry named
  after the element. A reference back to the root element becomes `{"$ref": "#"}`.
- Definitions are named after the local name. If two types share a local name, the second one gets the last two path
  segments of its namespace as a prefix, for example `HKP_BAS_1.3.Code` for `http://example.org/XMLSchema/HKP_BAS/1.3`.

## Objects

- A complex type becomes `{"type": "object", "properties": …, "required": …, "additionalProperties": false}`.
- Properties are named after local names. Attributes come first (attribute groups are expanded), then the elements in
  the order of the XML Schema. An element reference takes the name of the element it points to.
- If a type extends another one (`complexContent` with `extension`), the properties of the base type come first. A
  restriction uses its own content model and keeps the attributes of the base type, except those marked
  `prohibited`.
- For an element with text and attributes (`simpleContent` with `extension`), the text goes into a property called
  `value` (see the `textProperty` option), marked with `"xml": {"text": true}`.
- A property is required if its element has `minOccurs` of 1 or more inside a required group, or if its attribute
  has `use="required"`.

## Content models

| XML Schema                       | JSON Schema                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `maxOccurs` > 1                  | an array: `{"type": "array", "items": …}` with `minItems` (if `minOccurs` > 0) and `maxItems` (unless unbounded) |
| sequence, `all`, group reference | the properties of their particles, in the enclosing object                                                       |
| sequence with `minOccurs="0"`    | optional properties; `dependentRequired` makes sure that once one of them is there, the required ones are too    |
| choice                           | a `oneOf` with one branch per particle: the branch requires its own properties and sets the others to `false`    |
| choice with `minOccurs="0"`      | one more branch that sets all branch properties to `false`, unless one of the branches can be empty anyway       |
| several choices in one object    | an `allOf` of their `oneOf`s                                                                                     |
| a choice inside a branch         | a `oneOf` inside that branch                                                                                     |

The properties of all branches stay in the object's `properties`, so the object is still closed and keeps the order
of the XML Schema. The `false` entries are what make the branches exclusive: a property of another branch is
rejected, whether its value is valid or not.

## Simple types

| XML Schema                                                          | JSON Schema                                                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `xs:string`, `xs:token`, `xs:anyURI` and the other string types     | `{"type": "string"}`; `xs:language`, `xs:Name`, `xs:NCName` and `xs:QName` also get their pattern          |
| `xs:boolean`                                                        | `{"type": "boolean"}`                                                                                      |
| `xs:decimal`, `xs:float`, `xs:double`                               | `{"type": "number"}`                                                                                       |
| `xs:integer` and the types derived from it                          | `{"type": "integer"}`, with the bounds of `xs:int`, `xs:short`, `xs:unsignedByte` and so on                |
| `xs:date`, `xs:dateTime`, `xs:time`, `xs:duration`                  | the `format` `date`, `date-time`, `time` or `duration`; with `dateTime: "pattern"` the XML Schema format   |
| `xs:gYear`, `xs:gYearMonth`, `xs:gMonth`, `xs:gDay`, `xs:gMonthDay` | a pattern                                                                                                  |
| `xs:base64Binary`                                                   | `{"type": "string", "contentEncoding": "base64"}`                                                          |
| `xs:hexBinary`                                                      | a string with a pattern for pairs of hex digits                                                            |
| `length`, `minLength`, `maxLength`                                  | `minLength` and `maxLength` in characters, the strictest along the derivation chain                        |
| `pattern`                                                           | `pattern`, anchored and translated (see below)                                                             |
| `enumeration`                                                       | `enum` with values of the JSON type; values that another facet rules out are dropped, and so is that facet |
| `minInclusive`, `maxInclusive`                                      | `minimum`, `maximum` (numbers only)                                                                        |
| `minExclusive`, `maxExclusive`                                      | `exclusiveMinimum`, `exclusiveMaximum` (numbers only)                                                      |
| `fractionDigits`                                                    | `multipleOf` 10<sup>−n</sup>; with `0`, a decimal becomes an integer                                       |
| `totalDigits`                                                       | `exclusiveMinimum` and `exclusiveMaximum` ±10<sup>n</sup>: exact for integers, only a bound for decimals   |
| `whiteSpace`                                                        | nothing, since it only normalizes the XML text                                                             |
| `fixed`, `default`                                                  | `const`, `default`, with the JSON type of the declared type: `fixed="1"` on an integer becomes `1`         |

A derived simple type is merged with its base, so each definition in `$defs` is complete on its own.

### Patterns

XML Schema patterns always match the whole value and come with their own regex flavor. The converter anchors them
(`^(?:…)$`) and translates them for JavaScript regular expressions with the `u` flag, which JSON Schema uses:

- `^` and `$` are ordinary characters in XML Schema, so they are escaped.
- `.` matches everything except line feed and carriage return. `\d` means any decimal digit (`\p{Nd}`), `\s` only
  space, tab, line feed and carriage return, and `\w` everything except punctuation, separators and the Unicode
  category C (control, format and unassigned characters and the like). `\i` and `\c` stand for the characters
  allowed in XML names.
- `\-` outside a character class is a plain hyphen. Class subtraction like `[a-z-[aeiou]]` becomes a lookahead.
- Multiple patterns in one restriction step are alternatives: the value has to match one of them. If several steps
  of a derivation chain have patterns, the value has to match all steps, which the converter expresses with
  lookaheads.
- Block escapes such as `\p{IsBasicLatin}` have no JavaScript equivalent. The pattern is dropped and reported as
  `untranslatable-pattern`.

## The `xml` annotation

`xml` is an annotation in the spirit of the OpenAPI XML object. Most validators ignore keywords they don't know;
Ajv in strict mode wants them registered (`ajv.addKeyword('xml')`). Pass `xml: false` to leave the annotations out.

| Member      | Where            | Description                                           |
| ----------- | ---------------- | ----------------------------------------------------- |
| `name`      | root             | local name of the root element                        |
| `namespace` | root, properties | namespace URI of a qualified element or attribute     |
| `attribute` | properties       | `true` for an attribute                               |
| `text`      | `value` property | `true` for the text of an element with simple content |

## Problems

Some XML Schema features have no exact counterpart in JSON Schema. The converter still writes the closest schema it
can and tells you about each case in `problems`:

- An `error` means the schema differs from the XML Schema. Check it before you rely on the output.
- A `warning` means the schema is a bit more permissive than the XML Schema: it accepts some values the XML Schema
  would reject.

Every problem has a stable `code`, the `file` and, where known, the `line` and `column`.

| Code                                                                                                                                                                                  | Severity        | What happened                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `approximated-total-digits`                                                                                                                                                           | warning         | `totalDigits` on a decimal is only checked as a bound                                       |
| `lexical-pattern`                                                                                                                                                                     | warning         | a pattern on a number or boolean; it restricts the XML text, so JSON values ignore it       |
| `unsupported-bound`                                                                                                                                                                   | warning         | a minimum or maximum on a date or time type                                                 |
| `unreachable-enumeration`                                                                                                                                                             | warning         | an enumeration value that another facet rules out; it is dropped                            |
| `unsupported-any`                                                                                                                                                                     | error / warning | `xs:any` (error) or `xs:anyAttribute` (warning); other elements and attributes are rejected |
| `unsupported-list`, `unsupported-union`                                                                                                                                               | error           | `xs:list` and `xs:union` are written as plain strings                                       |
| `unsupported-mixed`                                                                                                                                                                   | error           | mixed content; the text between elements is dropped                                         |
| `repeated-group`                                                                                                                                                                      | error           | a sequence or choice with `maxOccurs` > 1 is written as if it occurred once                 |
| `unsupported-optional-group`, `unsupported-simple-content`, `unsupported-element`, `unsupported-redefine`, `unsupported-include`, `unsupported-facet`, `unsupported-value`            | error           | other constructs that JSON Schema can't express                                             |
| `untranslatable-pattern`                                                                                                                                                              | error           | a pattern with a block escape such as `\p{IsBasicLatin}`; it is dropped                     |
| `ambiguous-choice`                                                                                                                                                                    | error           | a choice where more than one branch can be empty                                            |
| `duplicate-name`                                                                                                                                                                      | error           | the same name twice in one object                                                           |
| `unknown-type`, `unknown-element`, `unknown-attribute`, `unknown-group`, `unknown-prefix`, `circular-type`, `circular-group`, `invalid-facet`, `invalid-value`, `duplicate-component` | error           | a mistake in the XML Schema itself                                                          |
| `missing-file`, `invalid-xml`, `not-a-schema`                                                                                                                                         | error           | a schema file is missing, is no XML, or is no XML Schema                                    |
| `root-required`, `unknown-root`                                                                                                                                                       | error           | no root element given where one is needed, or no such element                               |

If the entry file can't be read or no root element is found, `schema` is `undefined`.

## Limits

- JSON objects have no order, so the order of elements isn't checked.
- JSON values lose some details of the XML text, such as leading zeros or a `+` sign in a number, or whitespace an
  XML parser would collapse.
- `xs:list`, `xs:union`, `xs:any`, mixed content and `xs:redefine` aren't converted (see above). Identity
  constraints (`xs:key`, `xs:keyref`, `xs:unique`) are ignored.
- Ajv in strict mode complains about choice branches (`strictRequired`), because a branch requires properties it
  doesn't define itself. The schema is still valid JSON Schema; set `strictRequired: false`.
