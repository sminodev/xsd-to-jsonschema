This changelog loosely follows [Keep a Changelog](http://keepachangelog.com/en/1.0.0/).
Release versions follow [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [unreleased]

- Add `describeSchema()` and `describeSchemaFile()`: the schema and problems of `convert()` plus a structure report with
  particles in order, compositors, wildcards, identity constraints and raw facets, each linked to its property by a JSON
  Pointer; see [Structure report](docs/structure.md).
- Export `isMultipleOf()`, the decimal `multipleOf` check for Ajv; see [Validating with Ajv](docs/validation.md).
- Require Node.js 22.13 or later to support the ESLint 10 toolchain.
- Check the npm package in CI on the exact minimum Node.js version.
- Write a repeated sequence, choice or group reference as one property with an object per occurrence, such as
  `#sequence`. This replaces the `repeated-group` error.
- Write an element name declared by several particles as one array. `duplicate-name` reports only names that can't share
  a property, and the schema stays valid.
- Add the `approximated-occurrences` warning for a name inside and outside a choice or optional group.
- Support choices with several branches that can be empty and choices inside optional sequences. This replaces the
  `ambiguous-choice` and `unsupported-optional-group` errors.
- Apply `fixed` and `default` to the text of elements with simple content, also on the root, and to untyped elements.
- Report enumeration values outside the base enumeration as `invalid-facet`.
- Report the source position of problems in named union members.
- `convertFile` reads only relative paths inside the entry's directory or the new `baseDirectory` (CLI: `--base-dir`). A
  schema location outside it, a symbolic link to outside, an absolute path or a `file:` URL is reported as
  `unsafe-input`, and no schema is written.
- Reject imports with another target namespace and schema sets above the size limits. The option
  `limits: { maxFileBytes, maxTotalBytes, maxDocuments }` (CLI: `--max-file-bytes`, `--max-total-bytes`,
  `--max-documents`) sets them, by default 4 MiB per file, 16 MiB in total and 128 documents; `resource-limit` names
  the limit in effect. Then, as with `unsafe-input`, no schema is written.
- Report a DOCTYPE declaration as `unsafe-input`, except the one form that changes nothing: it is ignored and reported
  as `neutralized-doctype`; see [Schema input](docs/output.md#schema-input). A second byte order mark or white space
  before the XML declaration is `invalid-xml`.
- Describe mixed content as self-contained markup: each child element declares the namespaces its names use.
- Add `xml.whiteSpace` (`replace` or `collapse`) to string values that XML normalizes, such as `xs:token`,
  `xs:normalizedString`, dates, lists and types with a `whiteSpace` facet, so that XML can be converted to JSON the
  schema accepts. A union gets it when all members agree. Enumeration, `fixed` and `default` values of such types are
  normalized too.
- Document that `format` mode rejects valid `xs:dateTime` and `xs:time` values without a time zone, and where element,
  attribute and type documentation ends up as `description`.
- **Breaking:** write `xs:list` values, also `xs:NMTOKENS`, `xs:IDREFS` and `xs:ENTITIES`, as arrays of typed items
  marked with `xml.list`. Lengths become `minItems` and `maxItems`, enumerations compare values, the items of
  `xs:IDREFS` and `xs:ENTITIES` are NCNames, and a pattern on a list is reported as `unsupported-list-pattern`. This
  replaces the `unsupported-list` error.
- **Breaking:** support `nillable`: a nil element is `null`, or an object with its attributes and the text property
  `null`. The property is an `anyOf` with the nil form, marked with `xml.nillable`.
- **Breaking:** mark objects with `xs:any` or `xs:anyAttribute` with `xml.anyElement` or `xml.anyAttribute`. Content
  a wildcard takes is written without a schema; colliding names have no JSON form.
- Normalize the text of a union for each member, in member order: each `anyOf` branch keeps its `xml.whiteSpace`, and
  the first member that accepts the text gives the value, also for enumeration, `fixed` and `default` values. A
  union of members with different JSON types checks each member in its lexical form; `unsupported-union` reports only
  what that leaves out.
- Check the lexical form of `xs:base64Binary` with a pattern.
- Apply the facets of a `simpleContent` restriction, such as `whiteSpace`, `fractionDigits` and `totalDigits`, to the
  text, and report a `whiteSpace` facet that relaxes its base as `invalid-facet`.
- Report `unsupported-mixed` only for mixed content that can hold elements.
- Add the `unchecked-qname-prefix` warning: QName values are checked as `prefix:local` without the namespace binding.
- **Breaking:** support substitution groups: a particle that refers to a head is a choice between the head and its
  members, each under its own name. This replaces the `unsupported-element` error for heads.
- **Breaking:** support `xsi:type` for complex types: named complex types get an optional `#type` (`xml.xsiType`), and
  an element of a type with derived types is an `anyOf` of them. An abstract type without derived types is reported as
  `unsupported-element`. On a simple type, `xsi:type` may only name the declared type, recorded as `xml.type`.
- Give a document without target namespace the namespace of each document that includes it (chameleon include).
  `unsupported-include` reports only an included document with another target namespace.
- Translate `\i`, `\c` and the name types with the name characters of XML 1.0, Second Edition, as XML Schema 1.0 refers
  to them, and write each built-in name type once in `$defs`.
- Compare enumeration and `fixed` values by value: dates and times accept `Z`, `+00:00` and `-00:00` alike and
  seconds with trailing zeros, `xs:hexBinary` either case, and string unions the other spellings of a boolean or
  decimal member value. Such a value becomes a pattern; a fixed value then moves to `default`. A float or double value
  of a string union is reported as `unsupported-union`.
- Write `xs:anySimpleType` and attributes without a type as strings.
- Read `mixed="1"` as mixed content.
- Keep the attribute of a base type that a prohibited attribute in an attribute group names; only a prohibited
  attribute written in the restriction removes it.
- Apply `block` of the head's type, and the block of the head to members with an anonymous type, in substitution
  groups.
- Write a choice without possible particles as no constraint when it may be left out and as `{"not": {}}`
  otherwise, never as an empty `oneOf`.
- **Breaking:** give colliding names longer keys, planned from the whole content model: elements of one local name from
  several namespaces `{namespace}local`, an attribute named like an element or the text property `@local`, attributes of
  one local name from several namespaces `@{namespace}local`, each with `xml.name`. This replaces most `duplicate-name`
  errors.
- **Breaking:** write `INF`, `-INF` and `NaN` of `xs:float` and `xs:double` as strings, as far as the facets allow:
  an `anyOf` of the number and an `enum` of those strings.
- **Breaking:** write elements without a type or of `xs:anyType` without a schema, like wildcard content, marked
  with `xml.anyType` and reported as `unsupported-any`.
- Write a local element that contains itself through a group as a definition instead of failing with a stack
  overflow.
- Report numbers a JSON number can't keep apart from their neighbours as `rounded-number`: bounds and values with
  more than 15 significant digits or beyond 2^53 - 1, and `fractionDigits` on types whose values may have more than
  15 significant digits. Report the range of `xs:long` and `xs:unsignedLong` as `unsupported-bound`.
- Add the `unchecked-id` warning: `xs:ID` and `xs:IDREF` values are checked as names, not for uniqueness or targets.
- Reserve the name of the text property in every object, also in wildcard content.
- Decode schema files as their byte order mark and XML declaration say: UTF-8, UTF-16 with a byte order mark,
  ISO-8859-1 and US-ASCII, strictly. Add the error `unsupported-encoding` for other encodings; bad bytes are
  `invalid-xml`. Neither gives a schema. The size limits count the bytes of the file.
- Write a choice whose branches each require a property and share none with a size that grows linearly with the
  branches (anchors, `dependentRequired`, `dependentSchemas`), also for substitution groups; other choices keep the
  form that grows with the square of the branches.
- Compare bounds, `fixed` and enumeration values of `xs:float` as 32-bit floats: each value is the range of numbers that
  round to it.
- Mark numbers of `xs:decimal` and its restrictions with `xml.decimal`.
- Report a list whose item type contains the list as `circular-type`; write local element types nested more than 64 deep
  as definitions; give `resource-limit` and no schema for a schema that nests deeper than the converter can follow,
  instead of an exception.
- Take as `textProperty` only an NCName other than `__proto__`, or `#text`.
- Write the branches of a union flat: a member that is a union without facets gives its branches, a named union with
  facets is a `$ref`.
- Write names such as `__proto__`, `constructor` and `toString` as own properties; close an object with a property
  named `__proto__` with `propertyNames`.
- Treat only space, tab, line feed and carriage return as XML whitespace; U+00A0 and other Unicode spaces stay in
  values and in `fixed`, `default` and enumeration values.
- Give the nil form of a nillable element the attributes of each type `xsi:type` may select, with `#type`.
- Document that element order isn't checked, with an example, and that a JSON document the schema accepts proves no
  XML validity.
- Support `xs:redefine` of groups and attribute groups, with a reference to the replaced definition. A redefined
  type or `xs:override` is `unsupported-redefine`, and then no schema is written.

## 1.0.0

Initial release of the XML Schema to JSON Schema Draft 2020-12 converter, with import/include resolution,
browser and Node.js APIs, and a CLI.
