# Loading schemas and handling diagnostics

## Schema input

`convertFile()` and the CLI load the entry file and resolve relative schema locations within its directory. For schemas
split across sibling directories, set `baseDirectory` (CLI `--base-dir`) to their common parent. Absolute schema
locations, `file:` URLs and paths or symlinks that escape the base directory stop conversion with `unsafe-input`. Remote
URLs produce `missing-file`.

For already decoded XSDs, `convert()` accepts a path-to-text map or a synchronous loader. The loader receives absolute
import URLs unchanged, so you can supply a local or cached copy. For example,
`files: { 'order.xsd': orderXsd, 'line.xsd': lineXsd }` resolves an include of `line.xsd` from `order.xsd`.

**Encoding.** Files support UTF-8, UTF-16 with a byte order mark (BOM), ISO-8859-1 and US-ASCII. The converter checks
bytes against the declaration and BOM. Invalid bytes, conflicting or misplaced BOMs, whitespace before the XML
declaration and late or unterminated declarations produce `invalid-xml` and stop conversion, including in imports. An
unsupported encoding produces `unsupported-encoding`. `convert()` receives strings and ignores encoding declarations.

**DOCTYPE.** The converter never loads an external DTD or expands DTD-defined entities. It can ignore a single DOCTYPE
before the root and reports `neutralized-doctype` when doing so. Its internal subset may contain comments, unused
general entities with literal text, unused empty parameter entities, and `CDATA` namespace defaults repeated literally
on the root. The defaults must match without character references. Entity use in document text, external or predefined
entity declarations, parameter references, other declarations and malformed subsets stop conversion with `unsafe-input`.
The same applies to markup declarations after the root. Comments, CDATA and processing instructions may mention an
entity without using it.

## Options and limits

Select a global element with `root` (CLI `--root`). For example,
`convertFile('order.xsd', { root: 'Order', options: { textProperty: '#text' } })` puts simple-content text in `#text`.

| Option                                  | CLI flag                        | Default                                                                   |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `options.textProperty`                  | `--text-property`               | `value`. Use an NCName other than `__proto__`, or `#text`.                |
| `options.dateTime`                      | `--date-time`                   | `pattern`. See [Dates and times](values.md#dates-and-times) for `format`. |
| `options.xml`                           | `--no-xml` disables annotations | `true`                                                                    |
| `baseDirectory` (file API)              | `--base-dir`                    | Entry file's directory                                                    |
| `limits.maxFileBytes`                   | `--max-file-bytes`              | 4 MiB per document                                                        |
| `limits.maxTotalBytes`                  | `--max-total-bytes`             | 16 MiB in total                                                           |
| `limits.maxDocuments`                   | `--max-documents`               | 128 documents                                                             |
| `limits.maxOutputEntries`               | `--max-output-entries`          | 200,000 schema entries                                                    |
| `limits.maxStructureSize` (report only) | —                               | 20,000,000 [structure units](structure.md#limits)                         |

Limits must be positive safe integers. File input counts bytes on disk, string input counts UTF-8 bytes. A chameleon
include loaded into two namespaces counts twice. Output entries count each `properties` key and each `anyOf` or `oneOf`
branch wherever it is emitted. A referenced definition counts once. Keywords such as `required`, `enum` and `allOf` do
not count. Exceeding a limit returns `resource-limit` without a schema.

## Problems

Inspect `problems` even when the conversion returns `schema`. An `error` can mean the schema enforces only part of the
XSD. A `warning` identifies a mapping limit or adjustment. Every problem has a stable `code`, `severity` and `message`,
plus `file`, `line` and `column` when available. An unreadable import points to the referring declaration. The library
returns these records to the caller. The [CLI](../README.md#install-in-another-project) prints them on stderr.

### Warnings

| Code                              | Meaning                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approximated-occurrences`        | A name occurring inside and outside a choice or optional group is only checked by its total count.                                                                                |
| `rounded-number`                  | JSON number precision can merge distinct values. Reported for large or high-precision bounds and values, or for a fraction limit on a type that can exceed 15 significant digits. |
| `approximated-total-digits`       | Decimal `totalDigits` without a representable `fractionDigits` limit is checked only as a numeric bound.                                                                          |
| `lexical-pattern`                 | A pattern on a number or boolean constrains XML text, not the JSON value.                                                                                                         |
| `unreachable-enumeration`         | An enumeration value excluded by another facet is removed.                                                                                                                        |
| `unsupported-any`                 | Wildcard content or an element of `xs:anyType` is unconstrained.                                                                                                                  |
| `unsupported-mixed`               | Mixed content that can hold elements is an XML markup string; child elements aren't checked.                                                                                      |
| `unsupported-bound`               | A date/time bound or a bound outside the safe integer range for `xs:long` or `xs:unsignedLong` is omitted.                                                                        |
| `unsupported-identity-constraint` | `xs:key`, `xs:keyref` or `xs:unique` isn't checked.                                                                                                                               |
| `unsupported-length`              | An octet length on `xs:base64Binary` is omitted.                                                                                                                                  |
| `unsupported-list-pattern`        | The array representation loses the spelling of the list, so the list pattern is omitted.                                                                                          |
| `unsupported-union`               | A union of members with different JSON types is a string; what a member's lexical form can't check is left out.                                                                   |
| `unchecked-id`                    | The schema checks ID and IDREF names. Uniqueness and reference targets need XML validation. Reported once per schema.                                                             |
| `unchecked-qname-prefix`          | An `xs:QName` value is checked as `prefix:local`; whether the prefix is bound to a namespace isn't checked.                                                                       |
| `neutralized-doctype`             | A DOCTYPE declaration that changes nothing is ignored; see [Schema input](#schema-input).                                                                                         |

### Errors: unsupported constructs and mappings

| Code                         | Meaning                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-name`             | Two particles need incompatible types for one key, or a group key collides with `#type` or the text property. The converter keeps the first.                                        |
| `unsupported-element`        | An abstract element without members, an element of an abstract type without derived types, an abstract root element, or `xs:alternative`.                                           |
| `unsupported-facet`          | `xs:assertion`, `xs:explicitTimezone`, an unknown facet or a numerically unrepresentable digit constraint is omitted.                                                               |
| `unsupported-include`        | An included document declares a target namespace other than that of the including document.                                                                                         |
| `unsupported-particle`       | A sequence, choice or `all` contains something other than an element, a group or `xs:any`. Also covers `xs:assert` or `xs:openContent` in a complex type. The construct is ignored. |
| `unsupported-redefine`       | `xs:redefine` of a type, or `xs:override`; no schema is written.                                                                                                                    |
| `unsupported-simple-content` | The base of a `simpleContent` derivation lacks simple content; the text is a string.                                                                                                |
| `unsupported-value`          | `fixed` or `default` on an element with complex content is ignored.                                                                                                                 |
| `untranslatable-pattern`     | A pattern containing a block escape such as `\p{IsBasicLatin}` is dropped.                                                                                                          |

### Errors: mistakes in the XML Schema

| Code                  | Meaning                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `circular-group`      | A group or attribute group contains itself.                                                                                            |
| `circular-type`       | A type derives from itself.                                                                                                            |
| `duplicate-component` | Two global components of the same kind have the same name.                                                                             |
| `invalid-facet`       | An invalid facet value, such as `maxLength="abc"`, or a `whiteSpace` that relaxes its base; the facet or enumeration value is dropped. |
| `invalid-value`       | A fixed or default literal is invalid for its type. Check the reported declaration.                                                    |
| `unknown-attribute`   | An attribute reference can't be resolved.                                                                                              |
| `unknown-element`     | An element reference can't be resolved.                                                                                                |
| `unknown-group`       | A group or attribute-group reference can't be resolved.                                                                                |
| `unknown-prefix`      | A prefix has no namespace declaration.                                                                                                 |
| `unknown-type`        | A type or base type isn't defined.                                                                                                     |

### Errors: files and the root element

| Code                   | Meaning                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid-xml`          | A schema file isn't well-formed XML.                                                                                                       |
| `missing-file`         | A schema file is missing or can't be read, such as a URL that `convertFile` doesn't read.                                                  |
| `namespace-mismatch`   | An `xs:import` names another namespace than the target namespace of the imported document.                                                 |
| `not-a-schema`         | A file isn't an XML Schema document.                                                                                                       |
| `resource-limit`       | An input, output, report or nesting limit was reached. The message identifies the limit. No schema is written.                             |
| `root-required`        | No root is selected and the entry has no global element or more than one.                                                                  |
| `unknown-root`         | The selected root isn't a global element in the loaded schema set.                                                                         |
| `unsafe-input`         | A path leaves the base directory, a schema location is absolute or a `file:` URL, or a markup declaration is unsafe. No schema is written. |
| `unsupported-encoding` | A file declares an unsupported character encoding. No schema is written. See [Schema input](#schema-input).                                |
