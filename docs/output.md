# Output format

The generated JSON Schema describes one global element of an XSD 1.0 schema set. Start with the
[sample XML](../examples/order/order.xml) and its [JSON form](../examples/order/order.json). For a particular issue, go
to [simple types and values](values.md), [input options and diagnostics](diagnostics.md), or the
[structure report](structure.md).

## Compatibility

XSD 1.1 assertions, type alternatives, open content and `xs:override` are unsupported and reported in `problems`.

## JSON representation

| XML instance                        | JSON form                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root element                        | Its value directly, without a root-name wrapper.                                                                                                                            |
| Simple element                      | A typed value, such as `2`, `true` or `"AB1"`. An empty string element is `""`.                                                                                             |
| Element with attributes or children | An object. Declared attributes and child elements use their local names unless they [collide](#property-names). Simple content uses the text property, `value` by default.  |
| Repeated element                    | An array even for one occurrence. A missing optional element or attribute has no property.                                                                                  |
| Repeated group                      | An array of objects under a key such as `#sequence`, one object per occurrence.                                                                                             |
| Defaulted or fixed element          | An element with no character or element children takes its declared value. `<Count/>` with `default="5"` is `5`. Whitespace inside the element is content.                  |
| Nil element                         | `null`, or an object containing its attributes and a null text property.                                                                                                    |
| Substitution or `xsi:type`          | A substitute uses its own name. A selected complex type is recorded in `#type`. XML control attributes such as `xsi:nil` and `xsi:schemaLocation` do not become properties. |

## Root and definitions

By default the entry file must declare exactly one global element. Set `root` to select one from any loaded file. It can
be a local name, a prefix resolved in the entry document, or an expanded name such as `{urn:example:order}Order`.

The root annotation carries its name and namespace. Its description comes from the element, falling back to the type.
Named types are emitted in `$defs` in first-use order and referenced with `$ref`. A referenced global element with an
anonymous complex type gets a definition named for the element. A reference back to the root uses `{"$ref":"#"}`. Unused
types are omitted.

An included XSD without a target namespace takes the namespace of each including document. If types with the same local
name collide, the later definition gets a prefix from its namespace's last two path segments. For example,
`https://example.org/orders/common` gives `orders_common.Code`. `xs:redefine` supports groups and attribute groups. A
same-name reference inside the replacement refers to the original. Redefining a simple or complex type stops conversion
with `unsupported-redefine`.

## Objects

Objects normally have `additionalProperties: false`. Attributes appear first, including those from attribute groups,
followed by elements in schema order. A required attribute uses `use="required"`. A required group requires elements
whose `minOccurs` is positive.

- **Complex content.** An extension includes inherited properties and wildcards. A restriction supplies its own content
  model and retains base attributes unless prohibited. An extension of `xs:anyType` that adds only attributes inherits
  mixed content and both wildcards. Its declared attributes still enforce their constraints, and an instance with
  attributes or wildcard children may omit the text property.
- **Simple content.** `value` holds the typed text alongside attributes. Facets of a `simpleContent` restriction narrow
  the text as they would a simple type. An inline simple type in the restriction replaces the base text type.
- **Mixed content.** The text property holds self-contained inner XML, for example
  `Please ring <c:b xmlns:c="urn:example:common">twice</c:b>.` Comments and processing instructions are omitted. The
  converter reports `unsupported-mixed` when the content model can contain elements. The generated schema checks the
  string but cannot validate its child markup.
- **Documentation.** Element and attribute documentation becomes the property's `description`. A reference's own
  documentation takes precedence for a global attribute. A named type keeps its description in `$defs`. An anonymous
  type can supply the property's description when its declaration has none. For repeated elements the element's
  description belongs to the array and the type's to `items` or its definition.

## Property names

Keys depend on the whole content model, including inherited properties, choice branches and substitution groups. The
same field keeps its key when another optional field is absent.

| Collision                                         | JSON keys                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Elements named `code` in two namespaces           | `{"{urn:a}code": "x", "{urn:b}code": "y"}`. Use `{}code` for no namespace.                                                                   |
| An element and an attribute named `code`          | `code` for the element, `@code` for the attribute. Attributes with the same local name in different namespaces use `@{namespace}code`.       |
| Element or attribute named like the text property | The text key stays reserved in every object. With the default `value`, a child becomes `{namespace}value` and an attribute becomes `@value`. |

Renamed fields carry the original local name in `xml.name`. To keep XML names such as `value` as fields, set
`options.textProperty` to `#text`. If a repeated group already needs `#text`, the converter reports `duplicate-name`.
For XML names inherited by JavaScript objects, such as `constructor` or `__proto__`, follow the
[Ajv configuration](validation.md#configuration).

## Content models

| XSD                                       | JSON constraint                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Element with `maxOccurs` greater than one | Array with `items`. A positive minimum sets `minItems` and a finite maximum sets `maxItems`. `maxOccurs="0"` omits the property.                                                                                           |
| Sequence, `all`, or group reference       | The particle properties appear on the enclosing object. Multiple occurrences of one compatible element name share an array. Bounds add across a sequence. Each choice branch checks its own bounds.                        |
| Optional sequence                         | Fields may be absent together. If any are present, the required members of that group must also be present. An enclosed choice applies only when the group is present.                                                     |
| Choice                                    | Exactly one branch where distinguishable. An optional choice can also omit all branch fields. Shared properties or multiple branches that can be empty may require `anyOf`. An impossible required choice admits no value. |

The [order example](development.md#follow-a-choice-through-the-order-example) illustrates disjoint branches. `Pickup`
and `DeliveryDate` each identify one branch, so `oneOf` requires exactly one of them. `dependentRequired` ties
`DeliveryTime` to `DeliveryDate`. `dependentSchemas` adds further constraints when a branch needs them. This keeps wide
disjoint choices linear in size. When branches share names or lack a required field, each branch can explicitly exclude
the others' properties, which can grow quadratically.

### Repeated groups

Each occurrence of a repeated group gets its own object. For example, a sequence of `a` and `b` with `maxOccurs="3"`
keeps the pairs in `<R><a>1</a><b>x</b><a>2</a><b>y</b></R>` together.

```json
{
  "#sequence": [
    { "a": 1, "b": "x" },
    { "a": 2, "b": "y" }
  ]
}
```

The key is `#sequence`, `#choice` or a group name such as `#Address`. Distinct groups with the same name gain `:2`, `:3`
and so on in document order, counting base content first. Repeated references to the same group in one object share its
property. Nested repeated groups get their own arrays. Non-repeated groups contribute their fields to the enclosing
object.

Occurrence bounds apply to the array. If one occurrence can be empty, the XML cannot show an empty occurrence. Omit that
item and allow the whole property to be absent. Some inputs admit several valid groupings. With `(a+){2}`, three
elements can be split as one plus two or two plus one. With `(a{1,2}){2}`, two elements must be split one per group.

## Simple types

The [value reference](values.md) explains how each type is represented and which facets survive conversion.

- [Built-in types](values.md#built-in-types), [Facets and values](values.md#facets-and-values).
- [Whitespace](values.md#whitespace), [Patterns](values.md#patterns), [Equal values](values.md#equal-values).
- [Lists](values.md#lists), [Unions](values.md#unions).
- [Decimal digit limits](values.md#decimal-digit-limits), [Special float values](values.md#special-float-values).
- [Dates and times](values.md#dates-and-times), [Binary data](values.md#binary-data).

## Nil

An element with `nillable="true"` and no fixed value can use `xsi:nil="true"` or `"1"`. A default still permits nil.
`xsi:nil="false"` keeps the ordinary content.

| Nil element                             | JSON value                     |
| --------------------------------------- | ------------------------------ |
| `<Birth xsi:nil="true"/>`               | `null`                         |
| `<Address kind="home" xsi:nil="true"/>` | `{"kind":"home","value":null}` |

Required attributes remain required, and attributes keep their usual keys (including `@value` for an attribute named
`value`). A named type selected with `xsi:type` also keeps its `#type`. A nillable element carries `xml.nillable`. Its
`anyOf` starts with ordinary content, followed by the allowed nil forms. For repeated elements these branches apply to
each item, so `[1, null, 3]` can be valid.

## Substitution groups and xsi:type

Substitution changes the **element name**. A reference to a head accepts the concrete head and its eligible descendants,
each under its own name. A member inherits the head's type if it declares none. The head's and type's blocking rules
apply, including to anonymous member types. An abstract head with no eligible members produces `unsupported-element`.

With `maxOccurs` greater than one, each member present has a nonempty array bounded by `maxOccurs`. For example, a group
may contain both `"Invoice": […]` and `"Credit": […]`. The JSON Schema cannot check the combined count or preserve the
order between those arrays.

`xsi:type` changes the **type of the same element**. For example, a `Vehicle` selecting `Car` can have the JSON value
`{"#type":"{urn:example}Car","Plate":"K","Seats":4}`. Without a namespace, the expanded name is `{}Car`.

- A named complex type allows its own name in `#type`. A derived type requires `#type` and must satisfy the
  declaration's blocking rules. `anyOf` lists the allowed concrete forms. An abstract type with no concrete alternative
  produces `unsupported-element`.
- Fixed and default values also apply when a derived type has simple content. Whitespace normalization can erase the
  difference between empty content supplied by a fixed value and explicit text. Validate the XML when this distinction
  matters.
- A nil element selecting a derived type keeps `#type`, its attributes and null text, for example
  `{"#type":"{urn:example}Dog","chip":"123","value":null}`. An abstract declared type always requires a concrete
  selection. A repeated group also needing the key `#type` produces `duplicate-name`.
- On a simple element, `xsi:type` may name the declared type recorded in `xml.type`. Selecting another simple type has
  no JSON representation.

## Elements of xs:anyType

An `xs:anyType` element, including an untyped declaration that inherits no type from a substitution head, accepts
arbitrary content. Its annotation is `xml.anyType`, and conversion reports `unsupported-any`. Use the
[wildcard rules](#wildcards) for its JSON form. An empty element is `""` or its fixed or default value.

If `xsi:type` selects a complex type, the object carries `#type`. Its fields follow the named definition when that type
is reachable from the root. Other complex types use the wildcard mapping. Selecting a simple type here has no JSON
representation.

## Wildcards

`xs:any` and `xs:anyAttribute` accept content without a JSON constraint on its namespace, count or value, even when a
global declaration matches. The converter reports `unsupported-any`. When producing JSON, use the following rules for
wildcard content.

- An element containing only text keeps the text as written. An empty element is `""`. Attributes use string values
  under their local names. An element containing only attributes has no text property.
- Child elements use local names. Repeated siblings with the same name form an array. Whitespace between children is
  dropped when it is only formatting. Text mixed with children becomes one self-contained markup string in the text
  property.
- Namespace declarations and `xsi:` attributes are omitted. The text property stays reserved. A child with that name
  uses `{namespace}local` and an attribute uses `@local`.

For example, `<Ext a="1"><x>one</x><x> two </x><y b="2">y</y></Ext>` becomes
`{"a":"1","x":["one"," two "],"y":{"b":"2","value":"y"}}`.

There is no JSON form for siblings with the same local name in different namespaces, an attribute and child with the
same local name, or a wildcard field that collides with a declared one. An object open for one wildcard can still admit
JSON fields outside that wildcard's XML scope.

## The `xml` annotation

`xml` is a custom annotation based on the OpenAPI XML object. It records XML metadata without adding validation
constraints.

The [Ajv example](validation.md) registers the annotation so the validator accepts it. Alternatively, set `options.xml`
to `false` to omit it.

| Member         | Where                         | Meaning                                                                                                                                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Root, properties              | Local name of the root element, or of a property whose key isn't its local name; see [Property names](#property-names).                                                    |
| `namespace`    | Root, properties              | Namespace URI of a qualified element or attribute.                                                                                                                         |
| `attribute`    | Properties                    | `true` for an attribute.                                                                                                                                                   |
| `text`         | Text property                 | `true` for simple content.                                                                                                                                                 |
| `mixed`        | Text property                 | `true` for text containing child elements as XML markup.                                                                                                                   |
| `group`        | Group property                | `true` for an array of repeated group occurrences.                                                                                                                         |
| `whiteSpace`   | String values, union branches | `replace` or `collapse`: how XML normalizes the value; see [Whitespace](values.md#whitespace).                                                                             |
| `list`         | Arrays                        | `true` for the items of an `xs:list`, as opposed to repeated elements; see [Lists](values.md#lists).                                                                       |
| `nillable`     | Element values                | `true` when the element is declared nillable. The first `anyOf` branch holds content and the remaining branches hold any allowed nil forms. See [Nil](#nil).               |
| `anyElement`   | Objects                       | `true` for an object with `xs:any`; see [Wildcards](#wildcards).                                                                                                           |
| `anyAttribute` | Objects                       | `true` for an object with `xs:anyAttribute`.                                                                                                                               |
| `xsiType`      | `#type`                       | `true` for the property that holds the type `xsi:type` selects; see [Substitution groups and xsi:type](#substitution-groups-and-xsitype).                                  |
| `type`         | Simple types                  | `{namespace}local` of a named simple type, or of the built-in type of an element: the only type `xsi:type` may name for its value.                                         |
| `decimal`      | Number values                 | `true` for `xs:decimal` and its restrictions: the XML text has no exponent, and an integer value may be written `1.0`. Integer types and `xs:float`/`xs:double` have none. |
| `anyType`      | Element values                | `true` for an element of `xs:anyType`, written without a schema; see [Elements of xs:anyType](#elements-of-xsanytype).                                                     |

## Problems

A conversion can return a partial schema alongside errors. The [diagnostics reference](diagnostics.md#problems) explains
every code, its severity and where to find the declaration that triggered it.

- [Warnings](diagnostics.md#warnings)
- [Unsupported constructs and mappings](diagnostics.md#errors-unsupported-constructs-and-mappings)
- [Invalid XSD declarations](diagnostics.md#errors-mistakes-in-the-xml-schema)
- [Files and root selection](diagnostics.md#errors-files-and-the-root-element)

## Schema input

See [loading schemas](diagnostics.md#schema-input) for local file boundaries, custom loaders, encodings and DOCTYPE
handling, and [options and limits](diagnostics.md#options-and-limits) for API names, CLI flags and defaults.

## Limits

- **Order and identity.** A sequence of `a` then `b` gives the same JSON object as `b` then `a`. Validate the XML itself
  when order, ID uniqueness, reference targets, `xs:key` or `xs:unique` matter. JSON also lacks namespace bindings for
  checking QName prefixes. QName enumerations and fixed values compare the prefixed text.
- **Open or mixed content.** Wildcard contents and mixed markup remain unchecked. Repeated substitution groups lose
  member order and the total count across member arrays. On a simple element, `xsi:type` can only name the declared
  type.
- **Values.** Normalization can erase whitespace or the original spelling of a number. Check the
  [value reference](values.md) for precision, equivalent timezones, list patterns and other type-specific limits.
- **Depth.** Anonymous local complex types nested more than 64 levels become definitions. More than 1,000 levels of
  local types or nested lists and unions give `resource-limit`. Deep groups, group references and derivation chains may
  exhaust the stack sooner, depending on schema shape and runtime. The converter returns a diagnostic without a schema.

### Validator setup

The [Ajv guide](validation.md) shows a Draft 2020-12 setup for choices, `xml` annotations and decimal steps.
