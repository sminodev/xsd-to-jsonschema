# Structure report

The JSON Schema describes the JSON form of a document. Some of what the XML Schema says doesn't survive that
mapping: JSON objects have no element order, so a sequence and an `all` look alike, and nested groups are flat.
Wildcards keep only the fact that they exist, identity constraints are left out, and some facets can't be expressed at
all (see [Problems](output.md#problems)). Tools that need those details, such as a comparison of two schema versions,
can ask for a structure report next to the schema.

`describeSchema()` takes the same input as `convert()`, and `describeSchemaFile()` (from `xsd-to-jsonschema/node`) the
same as `convertFile()`:

```js
import { describeSchemaFile } from 'xsd-to-jsonschema/node';

const { schema, problems, structure } = describeSchemaFile('order.xsd');
```

`schema` and `problems` are exactly what `convert()` returns for the same input; the one difference is that
`describeSchemaFile` names itself in messages about locations it doesn't read. `structure` is undefined when there is no
schema. This holds as long as the report fits `limits.maxStructureSize` (see [Limits](#limits)): above it there is
neither a schema nor a structure, and `problems` ends with a `resource-limit` that names the limit and its value.

## Overview

A shortened report of the [order example](../examples/order):

```json
{
  "root": {
    "kind": "element",
    "name": "{urn:example:order}Order",
    "path": "/{urn:example:order}Order",
    "min": 1,
    "max": 1,
    "pointer": "",
    "global": true,
    "type": "#1",
    "nillable": false,
    "abstract": false,
    "source": { "file": "order.xsd", "line": 9, "column": 3 }
  },
  "types": {
    "#1": {
      "kind": "complex",
      "owner": "{urn:example:order}Order",
      "content": { "kind": "sequence", "particles": [] }
    },
    "{urn:example:common}Text40": { "kind": "simple", "facets": { "builtin": "string", "maxLength": 40 } }
  },
  "globals": { "elements": ["{urn:example:common}Note", "{urn:example:order}Order"], "attributes": [] },
  "unplaced": []
}
```

- `root` is the root element.
- `types` lists every complex and simple type the root reaches, once, by id: `{namespace}local` for a named type, and
  `#1`, `#2` and so on, in the order they are found, for an anonymous one. Elements and attributes refer to their type
  by id, so a type that contains itself is a reference and the report stays finite. Built-in types are not listed;
  they are referred to as `{http://www.w3.org/2001/XMLSchema}name`.
- `globals` lists the global declarations of the whole schema set, which wildcards may take: `elements`, the expanded
  names of the global elements, and `attributes`, the global attributes, each an attribute node with its type and
  value.
- `unplaced` lists the problems that belong to no node of the tree; see [Problems](#problems).

## Names and paths

Every name is expanded and always has braces: `{urn:example:order}Order`, and `{}code` for a name without namespace.
Only the root has a whole path, `/{namespace}local`. A node inside a named type can be reached on many paths, and on
infinitely many when the type contains itself, so the other nodes carry their own name only. A path to a node is the
names on the way from the root, joined with `/`: for example `/{urn:o}order/{urn:o}item/@{}code` for the attribute
`code` of `item`. Model groups add no step, and an element that stands in for another in a substitution group adds its
own name.

## Particles

The content of a complex type is a tree of particles in document order.

| `kind`                        | What it is                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `sequence`, `choice` or `all` | A model group with `min`, `max` and `particles`. `ref` names a referenced `xs:group`.        |
| `element`                     | An element particle; see below.                                                              |
| `any`                         | `xs:any` with `namespace` as written, `processContents`, `targetNamespace`, `min` and `max`. |

`max` is a number or `unbounded`. A particle with `maxOccurs="0"` is left out, as XML Schema leaves it out.

An element has:

- `name`, `min`, `max`, and `global` when the particle refers to a global element;
- `type`, the id of its type, and `value`, the [facets](#value-facets) of its value or of the text of simple content,
  with the declaration's fixed value. `{http://www.w3.org/2001/XMLSchema}anyType`, also for an element without a type,
  allows any attributes and mixed content with any elements, each validated where a declaration exists;
- `nillable`, `abstract`, and `default` and `fixed` as written;
- `block` and `final` in effect: the attribute, or `blockDefault` and `finalDefault` of the schema document (`final`
  only for global elements);
- `idType`: `ID`, `IDREF`, `IDREFS`, `ENTITY` or `ENTITIES`, where the value derives from one of them;
- `substitutes`: the other elements that may stand in for it, each an element node of its own. The root lists them
  too; they may be the root of a document instead, and as the schema of this root has no place for them, they have no
  pointer;
- `typeAlternatives`: the types `xsi:type` may select, the declared one included unless it is abstract, when there is
  more than one;
- `identity`: its `xs:key`, `xs:keyref` and `xs:unique`, each with `name`, `selector` and `fields` as written, `refer`
  for a keyref, and `namespaces` for the prefixes the XPaths use.

## Types

A complex type has:

- `name` (named) or `owner`, the declaration of an anonymous type: an element as `{namespace}local`, an attribute as
  `@{namespace}local`. Unlike an attribute's `name`, which is its expanded name, `owner` says the kind of the
  declaration too. It is no unique id: local declarations of the same name share it;
- `abstract`, and `block` and `final` in effect, as for elements;
- `mixed` in effect: the `mixed` of `complexContent` where it is written, otherwise that of the complex type, otherwise
  false (XML Schema 1.0, Structures 3.4.2). An extension that adds no content of its own and isn't mixed itself has the
  content type of its base;
- `derivation`: the `base` type and the `method`, `extension` or `restriction`;
- `attributes`: those in effect, inherited ones included and prohibited ones left out. Each has `name` (the expanded
  name, `{namespace}local` as for elements; only a path writes an attribute's step as `@{namespace}local`), `global`
  (a global attribute or a reference to one, as `global` of an element particle), `use` (`required` or `optional`),
  `type`, `value`, `default`, `fixed`, `idType`, and `group` when it comes from an attribute group;
- `anyAttribute`: the attribute wildcards that apply, from the type, its attribute groups and, for an extension, its
  base;
- `attributeWildcard`: the wildcard in effect, as XML Schema 1.0 combines them. Those of the type and its attribute
  groups intersect, and an extension adds its base's (that of `anyType` allows every attribute). `namespaces` is
  `{ "any": true }`, `{ "not": ns }` for every namespace except `ns` and none, or `{ "only": [...] }`, with `""` for no
  namespace; `processContents` is that of the type's own wildcard, else of the first group's;
- `content`: the content model in effect. An extension's content is a sequence of its base's content and its own, as
  in XML Schema; the content of `anyType` is a `lax` wildcard for any number of elements;
- `text`: for simple content, the text property with its `value`;
- `uncertain`: what the report can't state for sure, each with a `code` and a `message`: `attribute-wildcard` where
  XML Schema 1.0 can't express the combined wildcard, `mixed` where it depends on a base that isn't found, and
  `occurrences` for a `minOccurs` or `maxOccurs` that isn't valid; such a particle counts as occurring once.

A simple type has `name` or `owner` (as for complex types, `@` for an attribute's), `base` (the type a restriction
derives from), `facets` and `idType`.

## Value facets

`value` and `facets` hold the facets of a value as the schema writes them, including those the JSON Schema leaves out:
bounds of dates, lengths of binary data, patterns of lists and patterns of numbers.

| Field                                                          | Meaning                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `builtin`                                                      | Local name of the built-in type the derivation ends at; `anySimpleType` for lists and unions the schema defines, while a built-in list such as `NMTOKENS` keeps its name |
| `variety`                                                      | `atomic`, `list` or `union`                                                                                                                                              |
| `item`, `members`                                              | The facets of a list's items and of a union's member types                                                                                                               |
| `enumeration`                                                  | The allowed values, as written                                                                                                                                           |
| `patterns`                                                     | One array per restriction step: a value matches one pattern of each step                                                                                                 |
| `length`, `minLength`, `maxLength`                             | For a list, these count items                                                                                                                                            |
| `minInclusive`, `maxInclusive`, `minExclusive`, `maxExclusive` | Bounds as written                                                                                                                                                        |
| `totalDigits`, `fractionDigits`                                | Digit limits                                                                                                                                                             |
| `whiteSpace`                                                   | How XML normalizes the value; absent for a union, whose members decide                                                                                                   |
| `fixed`                                                        | The fixed value of the element or attribute declaration                                                                                                                  |

Each facet is the one in effect after all restriction steps, with only the narrowest values: a bound of a later step
replaces the base's bound on the same side, inclusive or exclusive, and `length` replaces `minLength` and `maxLength`.
The facets a built-in type implies, such as the range of `xs:int`, are not repeated.

## Pointers

Each node that has a property in the JSON Schema says where it is:

- `key` is the property name in the object of the enclosing type.
- `pointer` is the JSON Pointer of the property, relative to that object: `/properties/Title`, or
  `/properties/#sequence/items/properties/K` for an element of a repeated group. The root's pointer is `''`.
- The `pointer` of a type is the place of its object as a definition, such as `/$defs/Tree`, or `''` for the
  anonymous type of the root. A type written in place, inside the property of its element, has none.

The object behind a property is found by following `$ref`, the `items` of an array, and the first branch of an
`anyOf` or `oneOf` that wraps it (the nil form of a nillable element, the types `xsi:type` selects). An abstract type
has no object of its own; the objects of the types derived from it hold its properties.

Nodes without a property have no pointer: the elements of mixed content, which is written as one string, and an abstract
element that only its substitutes stand in for. Two particles that collide on one name (reported as `duplicate-name`)
both point to the one property that was written.

## Problems

`problems` on a node holds the indexes of the problems that concern it, in the `problems` of the result: those found
at its declaration, its particle, its type, a facet, or an attribute group it uses. A problem that concerns a named
type is listed on that type. Problems about files, such as `missing-file`, belong to no node and are listed in
`unplaced`.

## Limits

- The report covers what `convert()` supports: XML Schema 1.0. Where no schema is written, such as for a redefined
  type, there is no report.
- Namespaces of wildcards and the XPaths of identity constraints are reported as written, not evaluated.
- The report lists the particles of a group again wherever the group is referred to, and each type lists its inherited
  attributes and those of its attribute groups again. Groups that each refer twice to the next one therefore make a
  report that doubles with every level, although the JSON Schema stays small. `limits.maxStructureSize` (default
  20000000, a positive safe integer) bounds the whole report in structure units. Every value counts 1, every field
  name 1, and a string also its length, so pointers, identity constraints, type alternatives and attribute lists count
  wherever they are written. The unit is no measure of memory. Above the limit `describeSchema()` returns neither a
  schema nor a structure, and a `resource-limit` names the limit. The same holds where the report nests deeper than
  the converter's stack reaches, even where `convert()` still writes the schema. `maxOutputEntries` bounds the JSON
  Schema, not the report; `convert()` doesn't use `maxStructureSize`.
