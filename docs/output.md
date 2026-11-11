# Output format

`convert()` and `convertFile()` generate a JSON Schema Draft 2020-12 document for one global XSD element.
The resulting schema validates the JSON representation described below, not the XML document itself.

[`examples/order`](../examples/order) contains a multi-file XSD, its
[generated schema](../examples/order/order.schema.json) and corresponding XML and JSON examples.

## Compatibility

The supported XML Schema 1.0 constructs and their limits are listed below. XML Schema 1.1 assertions, type
alternatives, open content and `xs:override` are unsupported and reported in `problems`.

## JSON representation

[`order.xml`](../examples/order/order.xml) and [`order.json`](../examples/order/order.json) show the same data in
both formats:

- The document is the JSON value of the root element. There is no wrapping property for the root name.
- Simple values map to strings, numbers, integers or booleans according to their XSD type.
- An element with attributes or child elements becomes an object. Its attributes and child elements become
  properties under their local names; namespaces are recorded in `xml` annotations, not in property names.
- Text with attributes goes into `value`, or the name selected by `textProperty`. Mixed content also uses a text
  property containing the child markup as a string.
- An element with `maxOccurs` greater than 1 is always an array, even with one item. By contrast, an element allowed
  at most once isn't an array.
- A missing optional element or attribute is a missing property. An empty string element is `""`.

## Root and definitions

- Without an explicit `root`, the entry document must declare exactly one global element. An explicit `root` can instead
  select a global element from any loaded document, including imports and includes. Names may be local names,
  prefixed names resolved in the entry document, or expanded names such as `{urn:example:order}Order`.
- The root schema describes the root element's content, even when the element has a named type. Its `xml`
  annotation holds the element name and namespace. `description` comes from the element's documentation, falling
  back to the type's documentation.
- Named simple and complex types are stored in `$defs` and referenced through `$ref`. Definitions follow first-use
  order, and unreferenced types are omitted.
- A referenced global element with an anonymous complex type gets a definition named after that element. A reference
  back to the root uses `{"$ref": "#"}`.
- Definition names use local names. When two types share a name, the second gets a prefix from the last two path
  segments of its namespace. For example, `https://example.org/orders/common` produces `orders_common.Code` for
  a conflicting `Code` type.

## Objects

- A complex type becomes an object with `properties`, `required` where needed, and `additionalProperties: false`.
  `xs:any` or `xs:anyAttribute` leaves the object open by omitting `additionalProperties`. An extending type keeps
  its base type's open-content behavior.
- Attributes come first, with attribute groups expanded, followed by elements in XML Schema order. An element
  reference uses the referenced element's name.
- `complexContent` extension includes base properties first. A restriction uses its own content model and keeps the
  base attributes except those marked `prohibited`.
- `simpleContent` extension places the text in `value`, or the configured `textProperty`, marked with
  `"xml": {"text": true}`. A complex base type's simple content and attributes are retained.
- Mixed content becomes a string such as `Hello <b>World</b>` in the text property, alongside any attributes. It is
  marked with `"xml": {"text": true, "mixed": true}`. The child markup isn't validated.
- An element property is required when its `minOccurs` is at least 1 inside a required group. An attribute is required
  when it has `use="required"`.

## Content models

| XML Schema                         | JSON Schema                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `maxOccurs` greater than 1         | An array with `items`, `minItems` when `minOccurs` is positive, and `maxItems` unless unbounded.          |
| `maxOccurs="0"`                    | No property; a closed object rejects it.                                                                  |
| Sequence, `all` or group reference | The particles' properties in the enclosing object.                                                        |
| Sequence with `minOccurs="0"`      | Optional properties. `dependentRequired` requires the mandatory group members when any member is present. |
| Choice                             | A `oneOf` branch per particle, requiring its own properties and rejecting the other branches' properties. |
| Choice with `minOccurs="0"`        | An extra branch rejecting all branch properties, unless a branch can already be empty.                    |
| Several choices in one object      | An `allOf` containing their `oneOf` constraints.                                                          |
| A nested choice                    | A `oneOf` inside its branch.                                                                              |

All branch properties remain in the enclosing object's `properties`. Within each branch, `false` rejects properties
from the other branches regardless of their values. Repeated groups, ambiguous choices and choices inside optional
sequences have limitations listed under [Problems](#problems).

## Simple types

### Built-in types

| XML Schema                                                          | JSON Schema                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `xs:string`, `xs:token`, `xs:anyURI` and other string types         | `string`; `xs:language`, `xs:Name`, `xs:NCName` and `xs:QName` also get a pattern.                |
| `xs:boolean`                                                        | `boolean`.                                                                                        |
| `xs:decimal`, `xs:float`, `xs:double`                               | `number`.                                                                                         |
| `xs:integer` and derived types                                      | `integer`, with the relevant bounds; see [Limits](#limits) for `xs:long` and `xs:unsignedLong`.   |
| `xs:date`, `xs:dateTime`, `xs:time`, `xs:duration`                  | A pattern by default, or `format` when selected; see [Dates and times](#dates-and-times).         |
| `xs:gYear`, `xs:gYearMonth`, `xs:gMonth`, `xs:gDay`, `xs:gMonthDay` | A string with a pattern.                                                                          |
| `xs:base64Binary`                                                   | A string with `contentEncoding: "base64"`. This is an annotation; it doesn't check base64 syntax. |
| `xs:hexBinary`                                                      | A string with a pattern for pairs of hexadecimal digits.                                          |

### Facets and values

| XML Schema                         | JSON Schema                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `length`, `minLength`, `maxLength` | Character limits using the strictest constraints in the derivation chain. For `xs:hexBinary`, two characters per octet. Octet or item limits on `xs:base64Binary` and built-in list types are omitted.   |
| `pattern`                          | An anchored, translated pattern; see [Patterns](#patterns).                                                                                                                                              |
| `enumeration`                      | `enum` with values converted to their JSON type. Values excluded by another facet are removed, and that facet is then omitted.                                                                           |
| `minInclusive`, `maxInclusive`     | `minimum`, `maximum` for numbers.                                                                                                                                                                        |
| `minExclusive`, `maxExclusive`     | `exclusiveMinimum`, `exclusiveMaximum` for numbers.                                                                                                                                                      |
| `fractionDigits`                   | `multipleOf` set to 10<sup>−n</sup>. With `0`, a decimal becomes an integer.                                                                                                                             |
| `totalDigits`                      | Exclusive bounds at ±10<sup>n</sup> for integers; exact scale alternatives for decimals with a representable `fractionDigits` limit. Otherwise only a bound, with a warning.                             |
| `whiteSpace`                       | No JSON constraint; it normalizes XML text.                                                                                                                                                              |
| `xs:union`                         | The shared JSON type and an `anyOf` of the member types. Integer and number members share `number`. Restrictions on the union apply to the whole value. Incompatible member types fall back to a string. |
| `fixed`, `default`                 | `const`, `default`, using the declared type: `fixed="1"` on an integer becomes `1`, not `"1"`.                                                                                                           |

Derived simple types are merged with their bases, so each definition includes its inherited constraints.

### Decimal digit limits

For `totalDigits="6"` and `fractionDigits="2"`, the schema accepts `999999`, `99999.9` and `9999.99`, but rejects
`999999.5` and `99999.99`. A single maximum of `9999.99` would incorrectly exclude valid integers.

The converter emits an `anyOf` branch for each decimal scale from zero through `fractionDigits`. Scale `s` requires
`multipleOf: 10^-s` and exclusive bounds at `+/-10^(totalDigits-s)`. The branches are alternatives, so the constraint
matches the value's actual number of fraction digits, not the maximum allowed scale. Inherited digit facets and
additional numeric bounds still apply, including when filtering enumeration values.

Without a representable `fractionDigits` limit, the converter can only approximate decimal `totalDigits` and reports
`approximated-total-digits`. If digit facets would produce infinite bounds or a zero step in JavaScript numbers,
they are omitted with an `unsupported-facet` error rather than emitted as invalid JSON Schema constraints.

For decimal `multipleOf` validation, see [Validating with Ajv](validation.md#decimal-validation).

### Dates and times

The default `dateTime: 'pattern'` uses XML Schema date and time forms, including optional time zones. The patterns
account for month lengths and leap years.

With `dateTime: 'format'`, the converter emits `date`, `date-time`, `time` or `duration` formats. These differ from
XML Schema: RFC 3339 times and date-times require a time zone, dates don't allow one, and the duration
format doesn't allow negative values.

Because Draft 2020-12 treats `format` as an annotation by default, format validation must be enabled in the validator; see
[Ajv configuration](validation.md#configuration).

### Patterns

The converter translates XML Schema patterns into anchored JavaScript regular expressions using the `u` flag:
`^(?:…)$`.

- `^` and `$` are ordinary characters in XML Schema patterns, so they are escaped.
- `.` excludes line feed and carriage return. `\d` becomes any decimal digit (`\p{Nd}`); `\s` means space, tab,
  line feed and carriage return. `\w` excludes punctuation, separators and Unicode category C. `\i` and `\c`
  represent XML name characters.
- `\-` outside a character class becomes a plain hyphen. Class subtraction such as `[a-z-[aeiou]]` uses a lookahead.
- Patterns in one restriction step are alternatives, whereas patterns across restriction steps must all match. The
  converter combines them with lookaheads.
- Block escapes such as `\p{IsBasicLatin}` aren't translated. The pattern is dropped and reported as
  `untranslatable-pattern`.

## The `xml` annotation

`xml` is a custom annotation based on the OpenAPI XML object. It records XML metadata without adding validation
constraints.

The [Ajv example](validation.md) registers the annotation so the validator accepts it. Alternatively, set
`options.xml` to `false` to omit it.

| Member      | Where            | Meaning                                                  |
| ----------- | ---------------- | -------------------------------------------------------- |
| `name`      | Root             | Local name of the root element.                          |
| `namespace` | Root, properties | Namespace URI of a qualified element or attribute.       |
| `attribute` | Properties       | `true` for an attribute.                                 |
| `text`      | Text property    | `true` for simple content.                               |
| `mixed`     | Text property    | `true` for text containing child elements as XML markup. |

## Problems

The result includes a `problems` array even when a schema is returned:

- An `error` reports invalid input, unresolved references or an unsupported conversion. The generated schema may
  not enforce the XSD constraints.
- A `warning` reports a mapping limit or adjustment, such as an enumeration value excluded by another facet.

Each problem has a stable `code`, `severity` and `message`. `file`, `line` and `column` identify the source where
known. An unreadable entry includes its path even without a source line; an unreadable import points to the
importing declaration. If the entry file can't be read or no root element is found, `schema` is `undefined`.

The library returns diagnostics without logging them. For CLI output streams and exit codes, see the
[quick start](../README.md#quick-start).

### Warnings

| Code                              | Meaning                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approximated-occurrences`        | A name occurring inside and outside a choice or optional group is only checked by its total count.                                                                                                                                                                                                                                                            |
| `approximated-total-digits`       | Decimal `totalDigits` without a representable `fractionDigits` limit is checked only as a numeric bound.                                                                                                                                                                                                                                                      |
| `circular-group`                  | A group or attribute group contains itself.                                                                                                                                                                                                                                                                                                                   |
| `circular-type`                   | A type derives from itself.                                                                                                                                                                                                                                                                                                                                   |
| `duplicate-component`             | Two global components of the same kind have the same name.                                                                                                                                                                                                                                                                                                    |
| `duplicate-name`                  | Two particles can't share a property: one element name with different types. Also a repeated group named `type` next to `#type`, or one whose key is the name of the text property. The first one is kept.                                                                                                                                                    |
| `invalid-facet`                   | An invalid facet value, such as `maxLength="abc"`, or a `whiteSpace` that relaxes its base; the facet or enumeration value is dropped.                                                                                                                                                                                                                        |
| `invalid-value`                   | A `fixed` or `default` value doesn't fit its type.                                                                                                                                                                                                                                                                                                            |
| `invalid-xml`                     | A schema file isn't well-formed XML.                                                                                                                                                                                                                                                                                                                          |
| `lexical-pattern`                 | A pattern on a number or boolean constrains XML text, not the JSON value.                                                                                                                                                                                                                                                                                     |
| `missing-file`                    | A schema file is missing or can't be read, such as a URL that `convertFile` doesn't read.                                                                                                                                                                                                                                                                     |
| `namespace-mismatch`              | An `xs:import` names another namespace than the target namespace of the imported document.                                                                                                                                                                                                                                                                    |
| `not-a-schema`                    | A file isn't an XML Schema document.                                                                                                                                                                                                                                                                                                                          |
| `resource-limit`                  | The schema set exceeds a size limit, or the schema nests deeper than the converter can follow (local element types more than 1000 levels deep, or model groups so deep that the stack runs out); the message names the limit. No schema is written. See [Schema input](#schema-input).                                                                        |
| `root-required`                   | No root is selected and the entry has no global element or more than one.                                                                                                                                                                                                                                                                                     |
| `rounded-number`                  | A bound, enumeration, fixed or default value is rounded because a JSON number cannot hold it exactly: more than 15 significant digits, or a magnitude beyond 2^53 - 1, where decimals next to it round onto the same number. Also `fractionDigits` on a type whose values may have more than 15 significant digits: such a value is rounded before the check. |
| `unchecked-qname-prefix`          | An `xs:QName` value is checked as `prefix:local`; whether the prefix is bound to a namespace isn't checked.                                                                                                                                                                                                                                                   |
| `unknown-attribute`               | An attribute reference can't be resolved.                                                                                                                                                                                                                                                                                                                     |
| `unknown-element`                 | An element reference can't be resolved.                                                                                                                                                                                                                                                                                                                       |
| `unknown-group`                   | A group or attribute-group reference can't be resolved.                                                                                                                                                                                                                                                                                                       |
| `unknown-prefix`                  | A prefix has no namespace declaration.                                                                                                                                                                                                                                                                                                                        |
| `unknown-root`                    | The selected root isn't a global element in the loaded schema set.                                                                                                                                                                                                                                                                                            |
| `unknown-type`                    | A type or base type isn't defined.                                                                                                                                                                                                                                                                                                                            |
| `unreachable-enumeration`         | An enumeration value excluded by another facet is removed.                                                                                                                                                                                                                                                                                                    |
| `unsafe-input`                    | A file has a DOCTYPE declaration other than the harmless form or a markup declaration after the root element, the entry is outside the base directory, or a schema location leaves it; no schema is written. See [Schema input](#schema-input).                                                                                                               |
| `unsupported-any`                 | `xs:any` or `xs:anyAttribute` leaves the object open, or an element is of `xs:anyType`; such content is written without a schema and isn't checked.                                                                                                                                                                                                           |
| `unsupported-bound`               | A minimum or maximum on a date or time type isn't applied, or the range of `xs:long` or `xs:unsignedLong` beyond 2^53, which JSON numbers can't hold exactly.                                                                                                                                                                                                 |
| `unsupported-element`             | An abstract element without members, an element of an abstract type without derived types, an abstract root element, or `xs:alternative`.                                                                                                                                                                                                                     |
| `unsupported-facet`               | `xs:assertion`, `xs:explicitTimezone`, an unknown facet or a numerically unrepresentable digit constraint is omitted.                                                                                                                                                                                                                                         |
| `unsupported-identity-constraint` | `xs:key`, `xs:keyref` or `xs:unique` isn't checked.                                                                                                                                                                                                                                                                                                           |
| `unsupported-include`             | An included document declares a target namespace other than that of the including document.                                                                                                                                                                                                                                                                   |
| `unsupported-length`              | An octet length on `xs:base64Binary` is omitted.                                                                                                                                                                                                                                                                                                              |
| `unsupported-list-pattern`        | A pattern on a list restricts the whole text, which the array doesn't keep; it is left out.                                                                                                                                                                                                                                                                   |
| `unsupported-mixed`               | Mixed content that can hold elements is an XML markup string; child elements aren't checked.                                                                                                                                                                                                                                                                  |
| `unsupported-particle`            | A sequence, choice or `all` contains something other than an element, a group or `xs:any`. Also covers `xs:assert` or `xs:openContent` in a complex type. The construct is ignored.                                                                                                                                                                           |
| `unsupported-redefine`            | `xs:redefine` of a type, or `xs:override`; no schema is written.                                                                                                                                                                                                                                                                                              |
| `unsupported-simple-content`      | The base of a `simpleContent` derivation lacks simple content; the text is a string.                                                                                                                                                                                                                                                                          |
| `unsupported-union`               | A union of members with different JSON types is a string; what a member's lexical form can't check is left out.                                                                                                                                                                                                                                               |
| `unsupported-value`               | `fixed` or `default` on an element with complex content is ignored.                                                                                                                                                                                                                                                                                           |
| `untranslatable-pattern`          | A pattern containing a block escape such as `\p{IsBasicLatin}` is dropped.                                                                                                                                                                                                                                                                                    |

## Limits

- XML child-element order isn't checked. Listing properties in schema order doesn't enforce that order in JSON.
- JSON values lose lexical details such as a number's leading zeros or `+` sign, and whitespace that XML parsing
  would normalize.
- `xs:list` and `xs:redefine` aren't converted. Wildcards leave objects open, mixed-content markup isn't validated,
  and identity constraints aren't checked.
- Each element uses its declared type. Substitution-group members and `xsi:type` can't replace it, and `xsi:nil` has
  no JSON representation.
- `xs:anyURI` becomes a string without URI-syntax validation.
- Numeric values and bounds use JavaScript numbers. Precision lost during parsing cannot be recovered.
  The `INF`, `-INF` and `NaN` values allowed by `xs:float` and `xs:double` have no JSON representation.
- `xs:long` is emitted without bounds; `xs:unsignedLong` keeps only its minimum of 0. Their limits exceed the exact
  integer range of JavaScript numbers.

### Validator setup

See [Validating with Ajv](validation.md) for a Draft 2020-12 setup that handles choice branches, `xml` annotations
and decimal `multipleOf` constraints.
