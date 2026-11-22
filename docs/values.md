# Simple types and values

Use this reference when choosing the JSON value for an XSD element, attribute or simple-content text field. The
[output guide](output.md) covers the enclosing object.

## Built-in types

| XML Schema type                                                                 | JSON value                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xs:string`, `xs:token`, `xs:anyURI`, `xs:anySimpleType` and other string types | String. `xs:language` and the XML name types have patterns. References to the same name type share a definition in `$defs`. `xs:anyURI` has no URI-syntax check.               |
| `xs:boolean`                                                                    | Boolean.                                                                                                                                                                       |
| `xs:integer` and its derivatives                                                | Integer with the type's bounds. `xs:long` omits both bounds and `xs:unsignedLong` keeps only its minimum of zero because their maxima exceed JavaScript's exact integer range. |
| `xs:decimal`                                                                    | Number, marked with `xml.decimal`.                                                                                                                                             |
| `xs:float`, `xs:double`                                                         | Number or one of the strings `"INF"`, `"-INF"`, `"NaN"`.                                                                                                                       |
| Date and time types, `xs:duration`                                              | String with a pattern. Four types also support [format mode](#dates-and-times).                                                                                                |
| `xs:hexBinary`, `xs:base64Binary`                                               | String with a pattern for the [binary encoding](#binary-data).                                                                                                                 |
| `xs:NMTOKENS`, `xs:IDREFS`, `xs:ENTITIES`                                       | Nonempty array of strings. `IDREFS` and `ENTITIES` require NCNames.                                                                                                            |

## Facets and values

Each derived type includes inherited constraints. `fixed` and `default` use the declared JSON type, so `fixed="1"` on an
integer yields `const: 1`. On simple content they apply to the text property. `default` is an annotation. If a fixed
value has several equivalent representations, a constraint admits those representations and `default` records the value.

| XSD facet                                                      | How the schema checks it                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `length`, `minLength`, `maxLength`                             | Character count for strings, item count for lists, octet count for hex. Base64 octet limits produce `unsupported-length`. |
| `enumeration`                                                  | `enum` for ordinary values. Types with equivalent forms may use a pattern, interval or tuple.                             |
| `pattern`                                                      | A translated regular expression on string values. JSON numbers, booleans and arrays lose the source spelling.             |
| `minInclusive`, `maxInclusive`, `minExclusive`, `maxExclusive` | Numeric bounds with the corresponding inclusive or exclusive endpoint. Bounds on dates and times generate a warning.      |
| `fractionDigits`, `totalDigits`                                | Decimal steps and bounds. See [Decimal digit limits](#decimal-digit-limits).                                              |
| `whiteSpace`                                                   | Records how to normalize the XML text before validating the JSON.                                                         |

## Whitespace

`replace` turns tabs, line feeds and carriage returns into spaces. `collapse` also trims and joins runs of spaces. Other
characters, including nonbreaking spaces, stay in the value. For example, `<Code> AB1 </Code>` of type `xs:token`
becomes `"AB1"` and meets `length="3"`.

`xs:string` preserves whitespace by default, `xs:normalizedString` replaces it and `xs:token` collapses it. Lists
collapse before splitting, and a union tries normalization separately for each member. A restriction can tighten the
rule. Enumeration, fixed and default values follow the same normalization as instance text.

The applicable `xml.whiteSpace` annotation appears on the simple type, array items or union branch. A union also carries
it when all members agree. Apply it when reading XML. A JSON Schema validator receives the resulting value and performs
no normalization.

## Patterns

The converter anchors translated patterns as `^(?:…)$` and uses Unicode regular expressions. Patterns at one restriction
step are alternatives. A value must match a pattern at **every** step in the derivation.

- `^` and `$` match literal characters. `.` excludes carriage return and line feed. `\d` includes Unicode decimal
  digits, `\s` matches XML whitespace, and `\w` excludes punctuation, separators and Unicode category C.
- `\i`, `\c` and the built-in name types use XML 1.0 Second Edition name characters. Class subtraction such as
  `[a-z-[aeiou]]` uses a lookahead. An escaped hyphen outside a class becomes a literal hyphen.
- Block escapes such as `\p{IsBasicLatin}` produce `untranslatable-pattern`. The schema omits that pattern.

## Equal values

Enumerations and fixed constraints compare in the XSD value space. Hexadecimal case, zero-offset timezone aliases (`Z`,
`+00:00`, `-00:00`) and trailing zeros in fractional seconds can all represent the same value. For instance, an
enumeration of `0a` on `xs:hexBinary` admits `"0a"` and `"0A"`. Add the pattern `[0-9A-F]+` and only `"0A"` passes. A
derived enumeration may name the value with either spelling.

For string-valued unions, boolean members accept `true` or `1` for true, and decimal and integer members accept the
corresponding sign and zero variants. A float or double member has more spellings than the converter can express. In
that case it compares enumerated text or emits a fixed value as `default` and reports `unsupported-union`. Durations
compare as written. The converter does not translate different timezone offsets to the same instant.

## Unions

`xs:union` tries members in declaration order. The first member accepting the text determines normalization and how an
enumerated value compares. Compatible JSON types share an `anyOf` (`integer` and `number` share `number`). Nested unions
without their own facets contribute their branches directly. A named union with facets gets a `$ref`. A branch accepting
the entire shared type can make `anyOf` unnecessary when all members normalize alike.

Members of different JSON types produce a JSON string. Numeric and boolean members check their lexical form and any
translatable patterns. Numeric ranges, digit limits and member enumerations that the lexical check cannot represent
produce `unsupported-union`. A union containing a list also produces a string and this diagnostic, with no member check.

## Lists

An `xs:list` splits collapsed whitespace into typed items. `<Sizes> 1 +02 3 </Sizes>` with integer items becomes
`[1, 2, 3]`. An empty list is `[]` unless an item count rules it out. Repeated list elements become arrays of lists,
such as `[[6], [7, 8]]`. Only the list itself carries `xml.list`.

List lengths count items. Enumerations and fixed values compare item by item. For example, an enumerated `0a ff` of
`xs:hexBinary` accepts `["0A", "FF"]`. Floats compare at 32-bit precision in each position. A pattern on the original
list text produces `unsupported-list-pattern` because the JSON array no longer contains that text.

## Special float values

For `xs:float` and `xs:double`, finite values normally use JSON numbers. Infinity and NaN use `"INF"`, `"-INF"` and
`"NaN"` when allowed by the facets. `+INF` is invalid. A finite lower bound rules out negative infinity, a finite upper
bound rules out positive infinity, and either rules out NaN. An inclusive bound of NaN admits only NaN and an exclusive
one admits nothing. Patterns and enumerations can further restrict the three strings.

`xs:float` compares at 32-bit precision. An enumeration or fixed value of `0.1` accepts `0.10000000149011612` because
both round to the same float. The schema uses rounding intervals for values and bounds. Numbers at or above
`3.4028235677973366e38` round to positive infinity, so `minInclusive="INF"` admits those numbers as well as `"INF"`.
Negative overflow works symmetrically. On `xs:float`, `fixed="1e39"` therefore selects positive infinity. For
`xs:double`, JSON represents infinity only with the strings. An out-of-range numeric `fixed` or `default` literal on
`xs:double` produces `invalid-value`. In numeric unions the member accepting the literal determines the precision.

JSON input already parsed as a JavaScript number may have lost precision. For `xs:float` a decimal literal extremely
close to a rounding boundary can round twice, first to double and then to float. See the
[`rounded-number` diagnostic](diagnostics.md#warnings).

## Binary data

`xs:hexBinary` takes pairs of hex digits. `xs:base64Binary` accepts valid quartets, padding only at the end and zero
unused bits before padding. Its lexical form permits spaces after whitespace normalization. `"Zm9v YmFy"` and the empty
string are valid, `"AB=="` is invalid. The schema also carries `contentEncoding: "base64"`. Base64 octet lengths are
omitted with a warning.

## Decimal digit limits

With `totalDigits="6"` and `fractionDigits="2"`, `999999`, `99999.9` and `9999.99` are valid. `99999.99` exceeds six
digits. Each `anyOf` branch checks one scale `s` from zero to `fractionDigits` with `multipleOf: 10^-s` and exclusive
bounds at ±10^(totalDigits−s). A zero fraction limit makes a decimal an integer. Integer `totalDigits` uses exclusive
bounds at ±10^n.

Without a representable fraction limit, decimal `totalDigits` gives only an approximate bound and
`approximated-total-digits`. A digit facet that would produce a zero step or infinite bound is omitted with
`unsupported-facet`. For exact decimal steps in Ajv use the exported
[`isMultipleOf` helper](validation.md#decimal-validation).

## Dates and times

The default `dateTime: 'pattern'` accepts XSD forms, including optional timezones, and checks month lengths and leap
years. In `xs:duration`, fractional seconds require digits on both sides of the decimal point, as in `PT0.5S`.

Select `options: { dateTime: 'format' }` (CLI `--date-time format`) for `date`, `date-time`, `time` and `duration`
formats. This changes which values pass. For example, `2026-11-04T08:30:00` is valid XSD but RFC 3339 requires a
timezone for a date-time or time. A date with a timezone and a negative duration also fail format validation. Enable
format checking in your validator as shown in the [Ajv guide](validation.md#configuration).
