# Structure report

Use `describeSchemaFile()` when you need to know what the source XSD declares. For example, the JSON Schema for an order
can check required fields, but only the structure report tells you whether the XSD arranged them in a sequence or an
`all` group.

```js
import { describeSchemaFile } from 'xsd-to-jsonschema/node';

const { structure, problems } = describeSchemaFile('examples/order/order.xsd');
if (!structure || problems.some((p) => p.severity === 'error')) throw new Error('Could not describe the order.');
const rootType = structure.types[structure.root.type];
console.log(structure.root.name); // {urn:example:order}Order
if (rootType?.kind === 'complex') console.log(rootType.content?.kind); // sequence
```

`describeSchema()` accepts the same schema texts or loader as `convert()`. `describeSchemaFile()` accepts the same file
options as `convertFile()`. Both return `schema`, `problems` and `structure`. A successful report accompanies the usual
conversion result. When conversion yields no schema or the report exceeds a [limit](#limits), `structure` is undefined.

## Overview

| Field      | Where to look                                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`     | The selected element. Follow `root.type` into `types` to inspect its declaration.                                                                                                                                                                                           |
| `types`    | Every reachable named or anonymous type, including list item types and union members. Named types use `{namespace}local`, anonymous types use `#1`, `#2`, … in discovery order. Recursion refers back to the same ID. Built-ins use their expanded names and have no entry. |
| `globals`  | All global element names and attribute declarations in the loaded schema set, including candidates for wildcards. Both lists use UTF-16 code-unit order on expanded names.                                                                                                  |
| `unplaced` | Indexes into the result's `problems` for diagnostics outside the tree, such as a missing file.                                                                                                                                                                              |

## Names and paths

Names always include braces, even for an empty namespace (`{}code`). The root carries the only absolute path. To build a
path during traversal, append element names and prefix attribute steps with `@`, for example
`/{urn:o}order/{urn:o}item/@{}code`. Groups add no step. A substitute contributes its own element name. A reused or
recursive type can be reached through several paths.

## Particles

`content` is a tree in document order. Every particle carries `min` and `max` (`max` can be `"unbounded"`). Particles
with `maxOccurs="0"` are omitted.

| `kind`                      | Contents                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `sequence`, `choice`, `all` | Child `particles` in order and, for a group reference, its expanded `ref`.                              |
| `any`                       | `namespace` as written, `targetNamespace` and `processContents`.                                        |
| `element`                   | Its expanded `name`, `type` ID, effective `value` facets and whether it refers to a global declaration. |

An element also records `nillable`, `abstract`, `default`, `fixed`, effective `block` and `final`, and the `idType`
family where applicable. `substitutes` holds eligible element nodes. `typeAlternatives` lists the complex types
`xsi:type` may select when there is a choice. Root substitutes have no pointer in the selected root's schema. `identity`
preserves `xs:key`, `xs:keyref` and `xs:unique` with the selector, fields, prefix bindings and, for a key reference,
`refer`.

## Types

Named types have `name`. An anonymous type records its owning declaration in `owner`, with `@` for attributes. Use the
type ID as its identifier because multiple local declarations can share an owner name.

- **Simple types** carry effective `facets`, a restriction's `base` and `idType` where applicable.
- **Complex types** record effective `abstract`, `block`, `final` and `mixed`, the derivation `base` and `method`, and
  the effective `content`. An extension sequences inherited and added content. Explicit `complexContent/@mixed`
  overrides the type's `mixed`. An extension adding no content of its own can inherit mixed content.
- **Attributes and text.** `attributes` includes inherited attributes and omits prohibited ones. Each declaration
  records its expanded name, type, use, value and applicable defaults, fixed values or group. `text` describes a
  simple-content text property.
- **Wildcards.** `anyAttribute` lists the contributing declarations. `attributeWildcard` describes their effective
  namespace set (`{ "any": true }`, `{ "only": [...] }` or `{ "not": ns }`) and `processContents`. `""` denotes no
  namespace. The `not` form excludes both `ns` and no namespace. Attribute-group wildcards intersect with the type's
  wildcard. Extensions add their base wildcard. The type's own wildcard supplies `processContents` when present,
  otherwise the first group's does.
- **Uncertain results.** `uncertain` gives a code and explanation for an inexpressible combined wildcard
  (`attribute-wildcard`), an unresolved mixed-content base (`mixed`), or an invalid occurrence count (`occurrences`,
  treated as one).

## Value facets

`value` on a declaration and `facets` on a type expose effective XSD constraints, including rules the JSON Schema cannot
enforce. Use the [value reference](values.md) to see how they map to JSON.

| Field                                                          | Meaning                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtin`, `variety`                                           | Underlying built-in name and `atomic`, `list` or `union`. User-defined lists and unions use `anySimpleType`; built-in lists keep their name. |
| `item`, `members`                                              | Facets of list items or union member types.                                                                                                  |
| `enumeration`, `patterns`                                      | Enumeration values as written. Patterns are grouped by restriction step and are alternatives within each step.                               |
| `length`, `minLength`, `maxLength`                             | Length in the type's units. For lists, this counts items.                                                                                    |
| `minInclusive`, `maxInclusive`, `minExclusive`, `maxExclusive` | Effective bounds as written.                                                                                                                 |
| `totalDigits`, `fractionDigits`, `whiteSpace`                  | Digit limits and normalization. Union members determine their own whitespace handling.                                                       |
| `fixed`                                                        | Fixed value from the element or attribute declaration.                                                                                       |

A tighter facet replaces the inherited one. A single `length` replaces minimum and maximum lengths. Implicit built-in
bounds, such as the range of `xs:int`, are omitted.

## Pointers

`key` names a JSON property within its enclosing type. Its `pointer` is relative to that type's schema. For example,
`/properties/Title` identifies an order title and `/properties/#sequence/items/properties/K` identifies a child in a
repeated sequence. The root's pointer is the empty string. A named type's pointer may be `/$defs/Tree` and an anonymous
root type's pointer is `''`. A type emitted inline under a property has no separate type pointer.

To reach an object's properties, follow `$ref`, array `items`, or the first content branch of a wrapping `anyOf` or
`oneOf`. Abstract types have no object of their own. Children stored as mixed markup and abstract elements represented
only by substitutes have no property pointer. Two particles sharing a key after a `duplicate-name` diagnostic point to
the same property.

## Problems

Use `source.file`, `source.line` and `source.column`, when available, to locate a declaration in the XSD. The `problems`
array on a node contains indexes into the conversion result's `problems`. Diagnostics on a named type belong to that
type. File-level diagnostics and others without a corresponding node are in `unplaced`. The
[diagnostics reference](diagnostics.md#problems) lists the codes.

## Limits

Repeated group expansion and inherited attributes can make the report much larger than the schema.
`limits.maxStructureSize` defaults to 20,000,000 units. Each value and each field name counts once, and strings also
count their length. Exceeding the budget or the stack depth returns `resource-limit` with neither schema nor report. If
you need only the schema, `convert()` and `convertFile()` skip the report and its budget.

The report covers XSD 1.0 and preserves wildcard namespaces and identity-constraint XPaths as written. Evaluating them
against an instance requires an XML validator.
