# What the converter writes

`convert()` and, in Node.js, `convertFile()` write one JSON Schema 2020-12 document for one global element of an XML
Schema 1.0. The schema describes the JSON form of that element: the same data, with elements and attributes as JSON
properties. The `xml` annotations tell you how to get from one form to the other. Constructs that XML Schema 1.1
added, such as assertions, type alternatives, open content and `xs:override`, are reported as problems.

The README walks through [`examples/order`](../examples/order), an order schema split over three files, together
with the generated [`order.schema.json`](../examples/order/order.schema.json). This page lists the rules behind it.

## The JSON form

The converter converts schemas, not documents. The schema it writes expects this JSON form of an XML document, which
[`order.json`](../examples/order/order.json) shows for [`order.xml`](../examples/order/order.xml):

- The document is the JSON value of its root element.
- An element of a simple type is a string, number, integer or boolean, depending on the type. A list, and a union
  whose members have different JSON types, is a string.
- An element with attributes or child elements is an object. Attributes and child elements become properties named
  after their local names; their namespaces are left out of the name and kept in the `xml` annotations.
- The text of an element with simple content and attributes is the property `value`; mixed content is `value` as
  well, a string with the markup of the child elements.
- An element that may occur more than once (`maxOccurs` > 1) is always an array, even with one item. An element that
  occurs at most once is never an array.
- A missing optional element or attribute is a missing property; an empty element of a string type is an empty
  string.
- `xsi:nil` and `xsi:type` have no JSON form, and the order of the child elements isn't kept (see [Limits](#limits)).

## Root and definitions

- The root schema is the content of the root element, even if the element uses a named type. Its `xml` annotation
  holds the element name and namespace. The `description` comes from the element's documentation, or from its type's
  if the element has none.
- Named simple and complex types go into `$defs` and are referenced with `$ref`, in the order they are first used.
  Types the root element never reaches are left out.
- A global element with an anonymous complex type that other elements reference with `ref` gets a `$defs` entry named
  after the element. A reference back to the root element becomes `{"$ref": "#"}`.
- Definitions are named after the local name. If two types share a local name, the second one gets the last two path
  segments of its namespace as a prefix, for example `orders_common.Code` for `https://example.org/orders/common`.

## Objects

- A complex type becomes `{"type": "object", "properties": …, "required": …, "additionalProperties": false}`. If
  `xs:any` or `xs:anyAttribute` allow other elements or attributes, `additionalProperties` is left out, so the object
  accepts other properties as well. A derived type keeps that from its base when it extends it.
- Properties are named after local names. Attributes come first (attribute groups are expanded), then the elements in
  the order of the XML Schema. An element reference takes the name of the element it points to.
- If a type extends another one (`complexContent` with `extension`), the properties of the base type come first. A
  restriction uses its own content model and keeps the attributes of the base type, except those marked
  `prohibited`.
- For an element with text and attributes (`simpleContent` with `extension`), the text goes into a property called
  `value` (see the `textProperty` option), marked with `"xml": {"text": true}`. If the base is a complex type with
  simple content, the text type and the attributes of the base are kept.
- An element with mixed content (`mixed="true"`) gets its attributes and the property `value` as well. `value` is a
  string with the text and the child elements as XML markup, such as `Hello <b>World</b>`, marked with
  `"xml": {"text": true, "mixed": true}`. The child elements are not checked.
- A property is required if its element has `minOccurs` of 1 or more inside a required group, or if its attribute
  has `use="required"`.

## Content models

| XML Schema                       | JSON Schema                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `maxOccurs` > 1                  | an array: `{"type": "array", "items": …}` with `minItems` (if `minOccurs` > 0) and `maxItems` (unless unbounded) |
| `maxOccurs="0"`                  | nothing: the element may not occur, so the closed object rejects it                                              |
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

| XML Schema                                                          | JSON Schema                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xs:string`, `xs:token`, `xs:anyURI` and the other string types     | `{"type": "string"}`; `xs:language`, `xs:Name`, `xs:NCName` and `xs:QName` also get their pattern                                                                                                                              |
| `xs:boolean`                                                        | `{"type": "boolean"}`                                                                                                                                                                                                          |
| `xs:decimal`, `xs:float`, `xs:double`                               | `{"type": "number"}`                                                                                                                                                                                                           |
| `xs:integer` and the types derived from it                          | `{"type": "integer"}`, with the bounds of `xs:int`, `xs:short`, `xs:unsignedByte` and so on                                                                                                                                    |
| `xs:date`, `xs:dateTime`, `xs:time`, `xs:duration`                  | a pattern of the XML Schema format, which knows the days of each month and leap years; with `dateTime: "format"` the `format` `date`, `date-time`, `time` or `duration` (see below)                                            |
| `xs:gYear`, `xs:gYearMonth`, `xs:gMonth`, `xs:gDay`, `xs:gMonthDay` | a pattern                                                                                                                                                                                                                      |
| `xs:base64Binary`                                                   | `{"type": "string", "contentEncoding": "base64"}`; `contentEncoding` is an annotation, so the base64 syntax isn't checked                                                                                                      |
| `xs:hexBinary`                                                      | a string with a pattern for pairs of hex digits                                                                                                                                                                                |
| `length`, `minLength`, `maxLength`                                  | `minLength` and `maxLength` in characters, the strictest along the derivation chain; two characters per octet for `xs:hexBinary`. On `xs:base64Binary` and the built-in list types they count octets or items and are left out |
| `pattern`                                                           | `pattern`, anchored and translated (see below)                                                                                                                                                                                 |
| `enumeration`                                                       | `enum` with values of the JSON type; values that another facet rules out are dropped, and so is that facet                                                                                                                     |
| `minInclusive`, `maxInclusive`                                      | `minimum`, `maximum` (numbers only)                                                                                                                                                                                            |
| `minExclusive`, `maxExclusive`                                      | `exclusiveMinimum`, `exclusiveMaximum` (numbers only)                                                                                                                                                                          |
| `fractionDigits`                                                    | `multipleOf` 10<sup>−n</sup>; with `0`, a decimal becomes an integer                                                                                                                                                           |
| `totalDigits`                                                       | `exclusiveMinimum` and `exclusiveMaximum` ±10<sup>n</sup>: exact for integers, only a bound for decimals                                                                                                                       |
| `whiteSpace`                                                        | nothing, since it only normalizes the XML text                                                                                                                                                                                 |
| `xs:union`                                                          | the JSON type the member types share (integer and number count as number) and an `anyOf` of the member types; the patterns and enumerations of a restriction on the union apply to the whole value                             |
| `fixed`, `default`                                                  | `const`, `default`, with the JSON type of the declared type: `fixed="1"` on an integer becomes `1`                                                                                                                             |

A derived simple type is merged with its base, so each definition in `$defs` is complete on its own.

With `dateTime: "format"`, the values have to follow RFC 3339 instead of XML Schema: times and date-times need a time
zone, dates can't have one, and durations can't be negative. JSON Schema 2020-12 treats `format` as an annotation,
so a validator only checks it when told to; Ajv needs [`ajv-formats`](https://github.com/ajv-validator/ajv-formats).

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
Ajv, which is strict by default, wants them registered (`ajv.addKeyword('xml')`). Pass `xml: false` to leave the
annotations out.

| Member      | Where            | Description                                                                |
| ----------- | ---------------- | -------------------------------------------------------------------------- |
| `name`      | root             | local name of the root element                                             |
| `namespace` | root, properties | namespace URI of a qualified element or attribute                          |
| `attribute` | properties       | `true` for an attribute                                                    |
| `text`      | `value` property | `true` for the text of an element with simple content                      |
| `mixed`     | `value` property | `true` if the text is mixed content: text and child elements as XML markup |

## Problems

Some XML Schema features have no exact counterpart in JSON Schema. The converter still writes the closest schema it
can and tells you about each case in `problems`:

- An `error` means the schema differs from the XML Schema. Check it before you rely on the output.
- A `warning` means the schema is a bit more permissive than the XML Schema: it accepts some values the XML Schema
  would reject.

Every problem has a stable `code`, the `file` and, where known, the `line` and `column`. The tables list every code
the converter reports.

### Warnings: the schema accepts more

| Code                              | What happened                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `approximated-total-digits`       | `totalDigits` on a decimal is only checked as a bound                                        |
| `lexical-pattern`                 | a pattern on a number or boolean restricts the XML text, so JSON values ignore it            |
| `unreachable-enumeration`         | an enumeration value that another facet rules out; it is dropped                             |
| `unsupported-any`                 | `xs:any` or `xs:anyAttribute`; the object accepts other properties without checking them     |
| `unsupported-mixed`               | mixed content is a string of XML markup; the elements in it are not checked                  |
| `unsupported-bound`               | a minimum or maximum on a date or time type                                                  |
| `unsupported-identity-constraint` | `xs:key`, `xs:keyref` or `xs:unique`; uniqueness and references aren't checked               |
| `unsupported-length`              | a length on `xs:base64Binary` or a built-in list type counts octets or items; it is left out |
| `unsupported-union`               | an `xs:union` whose member types have different JSON types is checked as a string only       |

### Errors: constructs JSON Schema can't express

| Code                         | What happened                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ambiguous-choice`           | a choice where more than one branch can be empty                                                                                                             |
| `duplicate-name`             | the same name twice in one object, for example an attribute and an element                                                                                   |
| `repeated-group`             | a sequence or choice with `maxOccurs` > 1 is written as if it occurred once                                                                                  |
| `unsupported-element`        | an element that heads a substitution group, `abstract` or `nillable` on an element, or `xs:alternative`                                                      |
| `unsupported-facet`          | `xs:assertion`, `xs:explicitTimezone` or an unknown facet; it is ignored                                                                                     |
| `unsupported-include`        | an included document with another target namespace (chameleon include)                                                                                       |
| `unsupported-list`           | `xs:list` is written as a plain string                                                                                                                       |
| `unsupported-optional-group` | a choice inside an optional sequence; the sequence is written as if it were required                                                                         |
| `unsupported-particle`       | something other than an element, a group or `xs:any` inside a sequence, choice or `all`, or `xs:assert` or `xs:openContent` in a complex type; it is ignored |
| `unsupported-redefine`       | `xs:redefine` or `xs:override` is ignored                                                                                                                    |
| `unsupported-simple-content` | a `simpleContent` restriction with facets, which are not applied, or a base without simple content                                                           |
| `unsupported-value`          | `fixed` or `default` on an element with complex content is ignored                                                                                           |
| `untranslatable-pattern`     | a pattern with a block escape such as `\p{IsBasicLatin}`; it is dropped                                                                                      |

### Errors: mistakes in the XML Schema

| Code                  | What happened                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `circular-group`      | a group or attribute group that contains itself                                                      |
| `circular-type`       | a type derived from itself                                                                           |
| `duplicate-component` | two global components of the same kind with the same name                                            |
| `invalid-facet`       | a facet value that doesn't fit, such as `maxLength="abc"`; the facet or enumeration value is dropped |
| `invalid-value`       | a `fixed` or `default` value that doesn't fit the type                                               |
| `unknown-attribute`   | a reference to an attribute that isn't declared                                                      |
| `unknown-element`     | a reference to an element that isn't declared                                                        |
| `unknown-group`       | a reference to a group or attribute group that isn't defined                                         |
| `unknown-prefix`      | a prefix without a namespace declaration                                                             |
| `unknown-type`        | a type or base type that isn't defined                                                               |

### Errors: files and the root element

| Code            | What happened                                                       |
| --------------- | ------------------------------------------------------------------- |
| `invalid-xml`   | a schema file isn't well-formed XML                                 |
| `missing-file`  | a schema file is missing or can't be read                           |
| `not-a-schema`  | a file isn't an XML Schema document                                 |
| `root-required` | no root element given, and the entry declares none or more than one |
| `unknown-root`  | the entry declares no global element with that name                 |

If the entry file can't be read or no root element is found, `schema` is `undefined`.

## Limits

- JSON objects have no order, so the order of elements isn't checked.
- JSON values lose some details of the XML text, such as leading zeros or a `+` sign in a number, or whitespace an
  XML parser would collapse.
- `xs:list` and `xs:redefine` aren't converted. `xs:any` only opens the object, and the elements inside mixed content
  aren't checked (see above). Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`) aren't checked.
- Each element is described with its declared type. The members of a substitution group can't stand in for its head,
  a type derived with `xsi:type` can't replace the declared one, and `xsi:nil` has no JSON form.
- `xs:anyURI` is a plain string; its URI syntax isn't checked.
- `xs:float` and `xs:double` allow `INF`, `-INF` and `NaN`, which JSON numbers can't hold.
- `fractionDigits` becomes `multipleOf` 0.01, 0.00001 and so on. Validators that divide binary floating point
  numbers get this wrong: Ajv, by default, says 1.12 is no multiple of 0.01, and 1 no multiple of 0.00001. JSON
  numbers are decimal, so the check has to work on their decimal form, as Java's `BigDecimal` does. In Ajv, replace
  the keyword with an exact one (`src/test-support/oracle.ts` shows how); its option `multipleOfPrecision` only
  helps for small numbers.
- `xs:long` gets no bounds and `xs:unsignedLong` only its minimum of 0. Their limits lie beyond 2<sup>53</sup>, where
  JavaScript numbers stop being exact, so a validator like Ajv couldn't check them reliably.
- With `strict: true`, Ajv also turns on `strictRequired` and complains about choice branches, because a branch
  requires properties it doesn't define itself. The schema is still valid JSON Schema; set `strictRequired: false`.
