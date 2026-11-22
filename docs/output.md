# Output format

`convert()` and `convertFile()` generate a JSON Schema Draft 2020-12 document for one global XSD element.
The resulting schema validates the JSON representation described below, not the XML document itself.
What the mapping leaves out, such as element order or wildcard namespaces, is available from `describeSchema()`; see the
[structure report](structure.md).

[`examples/order`](../examples/order) contains a multi-file XSD, its
[generated schema](../examples/order/order.schema.json) and corresponding XML and JSON examples.

## Compatibility

The supported XML Schema 1.0 constructs and their limits are listed below. XML Schema 1.1 assertions, type
alternatives, open content and `xs:override` are unsupported and reported in `problems`.

## JSON representation

[`order.xml`](../examples/order/order.xml) and [`order.json`](../examples/order/order.json) show the same data in
both formats:

- The document is the JSON value of the root element. There is no wrapping property for the root name.
- Simple values map to strings, numbers, integers or booleans according to their XSD type. A string value is the
  text after XML whitespace normalization; see [Whitespace](#whitespace).
- An element with attributes or child elements becomes an object. Its attributes and child elements become
  properties under their local names; namespaces are recorded in `xml` annotations, not in property names. Names
  that would collide get longer keys; see [Property names](#property-names).
- Text with attributes goes into `value`, or the name selected by `textProperty`. Mixed content also uses a text
  property containing the child markup as a string.
- An element with `maxOccurs` greater than 1 is always an array, even with one item. By contrast, an element allowed
  at most once isn't an array.
- A sequence, choice or group reference with `maxOccurs` greater than 1 is one property holding an array with an
  object per occurrence; see [Repeated groups](#repeated-groups).
- An element name declared by several particles of one object is always an array holding the occurrences of all of
  them.
- `xs:float` and `xs:double` values are numbers, and `"INF"`, `"-INF"` or `"NaN"` as strings, which JSON numbers
  can't hold.
- An element without a type, or of type `xs:anyType`, is written without a schema, like content a wildcard takes;
  see [Elements of xs:anyType](#elements-of-xsanytype).
- A missing optional element or attribute is a missing property. An empty string element is `""`. An element
  without element or character children whose declaration has `fixed` or `default` takes that value:
  `<Count/>` with `default="5"` is `5`. With white space in it, `<Count> </Count>`, it has content of its own.
- The value of an `xs:list` is an array of its items: `<Sizes>1 2 3</Sizes>` becomes `[1, 2, 3]`; see [Lists](#lists).
- A nillable element with `xsi:nil="true"` is `null`, or an object with its attributes and the text property `null`;
  see [Nil](#nil).
- Content that `xs:any` or `xs:anyAttribute` takes is written without a schema; see [Wildcards](#wildcards).
- A member of a substitution group appears under its own name, and an element whose `xsi:type` selects a complex type
  has that type in `#type`; see [Substitution groups and xsi:type](#substitution-groups-and-xsitype).
- `xsi:` attributes such as `xsi:schemaLocation` or `xsi:nil` control XML Schema and never become properties.

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
- A document without `targetNamespace` that is included into a document with one takes the including document's
  namespace (chameleon include). Its components belong to that namespace, and names without prefix in it refer to
  them. Included into two namespaces, it yields two sets of components, such as `Contact` and `o.Contact` in `$defs`.
- `xs:redefine` includes a document and replaces its groups and attribute groups; a reference to the same name
  inside a replacing definition means the replaced one, so `<xs:group name="G"><xs:sequence><xs:group ref="G"/>…`
  extends `G`. The JSON form is the usual one. A redefined simple or complex type is reported as
  `unsupported-redefine`, and no schema is written, as one that ignores the redefinition would look usable but be
  wrong.
- Definition names use local names. When two types share a name, the second gets a prefix from the last two path
  segments of its namespace. For example, `https://example.org/orders/common` produces `orders_common.Code` for
  a conflicting `Code` type.

## Objects

- A complex type becomes an object with `properties`, `required` where needed, and `additionalProperties: false`.
  `xs:any` or `xs:anyAttribute` leaves the object open by omitting `additionalProperties`, and marks it with
  `"xml": {"anyElement": true}` or `"xml": {"anyAttribute": true}`. An extending type keeps its base type's
  wildcards.
- Attributes come first, with attribute groups expanded, followed by elements in XML Schema order. An element
  reference uses the referenced element's name.
- `complexContent` extension includes base properties first. A restriction uses its own content model and keeps the
  base attributes except those marked `prohibited`.
- `simpleContent` extension places the text in `value`, or the configured `textProperty`, marked with
  `"xml": {"text": true}`. A complex base type's simple content and attributes are retained.
- A `simpleContent` restriction narrows the text like a simple type restriction: its facets, such as `whiteSpace`,
  `fractionDigits`, `totalDigits`, lengths or `pattern`, are merged with those of the base text type, and a simple
  type written in the restriction replaces the base text type. Facets that have no JSON Schema form are reported as
  for simple types.
- Mixed content becomes a string such as `Hello <b>World</b>` in the text property, alongside any attributes. It is
  marked with `"xml": {"text": true, "mixed": true}`. The child markup isn't validated. It keeps the names as
  written, and each child element declares the namespaces its names use, so that the string can be read on its own:
  `Please ring <c:b xmlns:c="urn:example:common">twice</c:b>.` Comments and processing instructions are left out.
  `unsupported-mixed` is reported only when the content model, inherited particles included, can hold an element.
- An element property is required when its `minOccurs` is at least 1 inside a required group. An attribute is required
  when it has `use="required"`.
- A property's `description` is the documentation of its element or attribute declaration. For an attribute reference,
  the reference's own documentation wins over that of the global attribute. The type's documentation stays with the
  type: in its definition in `$defs`, reached through `$ref`, or on the type schema in place for an anonymous complex
  type. An anonymous type's documentation becomes the property's only when the declaration has none.
- For an element with `maxOccurs` greater than 1, the element's documentation is on the array and the type's on
  `items`, or in the definition that `items` refers to. An attribute without documentation of its own has no
  `description`; its type's documentation stays in the definition.

## Property names

The keys of an object are planned from its whole content model, inherited content, all branches and the members of
substitution groups included, never from a document. An optional element keeps its key when a document leaves it out.

- Elements of one local name from different namespaces all get the key `{namespace}local`, with `{}local` for no
  namespace: `{"{urn:a}code": "x", "{urn:b}code": "y"}`.
- An attribute of the local name of an element gets the key `@local`, and the element keeps its local name.
  Attributes of one local name from different namespaces get `@{namespace}local`.
- The name of the text property is reserved in every object, whether it has text or not: an element of that name
  gets `{namespace}local`, an attribute `@local`. Next to the text of simple content, the attribute `value` is
  `{"@value": "v", "value": 4.5}`; an object with a child element and an attribute named `value` is
  `{"@value": "a", "{urn:example}value": "e"}`. Group keys and `#type` start with `#`, which no XML name does.
- A property whose key isn't its local name has `xml.name` with the local name, next to `xml.namespace` and
  `xml.attribute`.
- Names such as `__proto__`, `constructor` or `toString` are ordinary element and attribute names: own properties in
  `properties` and in the JSON. An object with a property named `__proto__` is closed by `propertyNames`, the list of
  its keys, instead of `additionalProperties: false`, as Ajv leaves such a property out of `properties`; see
  [Validating with Ajv](validation.md).

`textProperty` is an NCName other than `__proto__`, or `#text`; any other value is an option error, so the text property
never takes the form of another kind of key. For schemas that use `value` or `text` as element or attribute names,
`textProperty: '#text'` keeps those names as they are. A repeated group named `text` would then take the key `#text`;
that is reported as `duplicate-name`.

## Content models

| XML Schema                         | JSON Schema                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `maxOccurs` greater than 1         | An array with `items`, `minItems` when `minOccurs` is positive, and `maxItems` unless unbounded.          |
| `maxOccurs="0"`                    | No property; a closed object rejects it.                                                                  |
| Choice with no possible particle   | Nothing, if it may be left out; otherwise `{"not": {}}`, as no content meets it.                          |
| Model group with `maxOccurs` > 1   | A property such as `#sequence`, an array with an object per occurrence.                                   |
| One element name in two particles  | One array. Bounds add up across a sequence; each branch of a choice checks its own.                       |
| Sequence, `all` or group reference | The particles' properties in the enclosing object.                                                        |
| Sequence with `minOccurs="0"`      | Optional properties. `dependentRequired` requires the mandatory group members when any member is present. |
| Choice                             | A `oneOf`, one branch per particle; see below for how the branches keep each other out.                   |
| Choice with `minOccurs="0"`        | An extra branch rejecting all branch properties, unless a branch can already be empty.                    |
| Choice inside an optional sequence | A constraint with two branches: none of the sequence's properties, or the whole sequence.                 |
| Several choices in one object      | An `allOf` containing their `oneOf` constraints.                                                          |
| A nested choice                    | A `oneOf` inside its branch.                                                                              |

All branch properties remain in the enclosing object's `properties`. Where every branch requires a property and no
two branches share one, the first required property of each branch is its anchor:

- `oneOf` requires exactly one anchor, `{"required": ["Pickup"]}` or `{"required": ["DeliveryDate"]}`; for a choice
  with `minOccurs="0"`, a further branch has none of them;
- `dependentRequired` ties every other property of a branch to its anchor, `"DeliveryTime": ["DeliveryDate"]`;
- `dependentSchemas` applies the rest of a branch, such as its other required properties, when its anchor is there.

This form grows linearly with the number of branches, also for the members of a substitution group. A choice whose
branches share a property, or one with a branch that requires nothing, is written differently: within each branch,
`false` rejects the properties of the other branches, so it grows with the square of the number of branches; with
shared properties or several branches that can be empty, it is an `anyOf`, because several branches can match.

### Repeated groups

A model group that can occur more than once keeps its occurrences together, because the elements of one occurrence
belong to each other. For `<xs:sequence maxOccurs="3">` around the elements `a` and `b`,
`<R><a>1</a><b>x</b><a>2</a><b>y</b></R>` becomes:

```json
{
  "#sequence": [
    { "a": 1, "b": "x" },
    { "a": 2, "b": "y" }
  ]
}
```

- The property is `#sequence` or `#choice`, or `#` and the group's name for an `xs:group` reference: `#Address`. A
  further group of the same name in the object adds `:2`, `:3` in document order, counting the groups of a base type
  first and every branch of a choice. Names start with `#`, so they can't collide with an element or attribute.
- Each occurrence is a closed object following the same rules, so repeated groups nest. Non-repeated groups inside it
  add their properties to it.
- A reference that reaches the same group twice in one object shares its property.
- The array has `minItems` and `maxItems` from `minOccurs` and `maxOccurs`, and the property is required when
  `minOccurs` is positive. If an occurrence can be empty, XML can't show it: the property is then optional, without
  `minItems`, and empty occurrences have no item.
- Where a content model allows several readings of the same XML, for example `(a+){2}` for three `a`, any reading within
  the group's bounds is valid: here `[{ "a": [1, 2] }, { "a": [3] }]` or `[{ "a": [1] }, { "a": [2, 3] }]`. A reader
  picks one the schema accepts: `(a{1,2}){2}` needs two occurrences for two `a`, `[{ "a": ["x"] }, { "a": ["y"] }]`.

## Simple types

### Built-in types

| XML Schema                                                                      | JSON Schema                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xs:string`, `xs:token`, `xs:anyURI`, `xs:anySimpleType` and other string types | `string`; `xs:language` gets a pattern. The name types `xs:Name`, `xs:NCName`, `xs:ID`, `xs:IDREF`, `xs:ENTITY`, `xs:NMTOKEN` and `xs:QName` are one definition each in `$defs` with their pattern; elements, attributes and derived types refer to it with `$ref`. |
| `xs:NMTOKENS`, `xs:IDREFS`, `xs:ENTITIES`                                       | An array of strings with `minItems: 1`; see [Lists](#lists). `xs:IDREFS` and `xs:ENTITIES` items are NCNames, `xs:NMTOKENS` items any name characters.                                                                                                              |
| `xs:boolean`                                                                    | `boolean`.                                                                                                                                                                                                                                                          |
| `xs:decimal`                                                                    | `number`.                                                                                                                                                                                                                                                           |
| `xs:float`, `xs:double`                                                         | A `number`, or one of the strings `INF`, `-INF` and `NaN`; see [Special float values](#special-float-values).                                                                                                                                                       |
| `xs:integer` and derived types                                                  | `integer`, with the relevant bounds; see [Limits](#limits) for `xs:long` and `xs:unsignedLong`.                                                                                                                                                                     |
| `xs:date`, `xs:dateTime`, `xs:time`, `xs:duration`                              | A pattern by default, or `format` when selected; see [Dates and times](#dates-and-times).                                                                                                                                                                           |
| `xs:gYear`, `xs:gYearMonth`, `xs:gMonth`, `xs:gDay`, `xs:gMonthDay`             | A string with a pattern.                                                                                                                                                                                                                                            |
| `xs:base64Binary`                                                               | A string with a pattern of the XML Schema lexical form and `contentEncoding: "base64"`; see [Binary data](#binary-data).                                                                                                                                            |
| `xs:hexBinary`                                                                  | A string with a pattern for pairs of hexadecimal digits.                                                                                                                                                                                                            |

### Facets and values

| XML Schema                         | JSON Schema                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `length`, `minLength`, `maxLength` | Character limits using the strictest constraints in the derivation chain. For `xs:hexBinary`, two characters per octet; for a list, `minItems` and `maxItems`. Octet limits on `xs:base64Binary` are omitted.                                             |
| `pattern`                          | An anchored, translated pattern; see [Patterns](#patterns).                                                                                                                                                                                               |
| `enumeration`                      | `enum` with values converted to their JSON type. Values excluded by another facet are removed, and that facet is then omitted. Values with several spellings become a pattern; see [Equal values](#equal-values).                                         |
| `minInclusive`, `maxInclusive`     | `minimum`, `maximum` for numbers.                                                                                                                                                                                                                         |
| `minExclusive`, `maxExclusive`     | `exclusiveMinimum`, `exclusiveMaximum` for numbers.                                                                                                                                                                                                       |
| `fractionDigits`                   | `multipleOf` set to 10<sup>−n</sup>. With `0`, a decimal becomes an integer.                                                                                                                                                                              |
| `totalDigits`                      | Exclusive bounds at ±10<sup>n</sup> for integers; exact scale alternatives for decimals with a representable `fractionDigits` limit. Otherwise only a bound, with a warning.                                                                              |
| `whiteSpace`                       | No JSON constraint. `replace` and `collapse` are recorded as `xml.whiteSpace`; see [Whitespace](#whitespace).                                                                                                                                             |
| `xs:union`                         | The shared JSON type and an `anyOf` of the member types, in member order. Integer and number members share `number`. Restrictions on the union apply to the whole value. See [Unions](#unions) for members of different JSON types.                       |
| `fixed`, `default`                 | `const`, `default`, using the declared type: `fixed="1"` on an integer becomes `1`, not `"1"`. With simple content they apply to the text property. A fixed value with several spellings is a pattern and a `default`; see [Equal values](#equal-values). |

Derived simple types are merged with their bases, so each definition includes its inherited constraints.

### Unions

An `xs:union` becomes an `anyOf` of its members, in the order the union names them. A member without facets that
accepts every value of the shared JSON type makes the `anyOf` unnecessary, and it is left out, unless the members
normalize whitespace differently; see [Whitespace](#whitespace).

The branches don't nest: a member that is a union without facets of its own gives its branches in its place, in order,
and a named member that is a union with facets of its own is a `$ref` to its definition.

When the members have different JSON types, such as `xs:integer` and an enumeration of `xs:token`, the value is a JSON
string: the text as the member that accepts it normalizes it. Each member is then checked in its lexical form: a number
or boolean member by a pattern of its XML Schema lexical form and its own `pattern` facets. What a pattern can't check,
such as the range of `xs:int`, bounds, digit limits or enumerations of a number member, is left out and reported as
`unsupported-union`. An enumeration on the union itself compares values; see [Equal values](#equal-values). A union with
a list member stays a string without member checks, also reported as `unsupported-union`.

### Special float values

`xs:float` and `xs:double` also have the values `INF`, `-INF` and `NaN`, which JSON numbers can't hold. They are the
strings `"INF"`, `"-INF"` and `"NaN"`, in elements, attributes, lists, unions and simple content; a finite value is a
number. `+INF` is no value in XML Schema 1.0. A literal beyond the range of a double, such as `1E309`, has no JSON
number; a reader writes it as `INF` or `-INF`, as XML Schema 1.1 rounds it. The facets decide which of the three a
type allows:

- An inclusive bound of `NaN` allows exactly `NaN`, an exclusive one no value; every other bound rules out `NaN`.
- A finite minimum rules out `-INF`, a finite maximum `INF`. A bound of `INF` or `-INF` limits the numbers instead:
  on `xs:double`, `minInclusive="INF"` allows only `"INF"`; on `xs:float` also the numbers that round to `INF`, as
  below.
- A `pattern` applies to the three strings, an `enumeration` lists those it allows.

The schema is an `anyOf` of the number and an `enum` of the allowed strings, `{"anyOf": [{"type": "number", "maximum":
10}, {"enum": ["-INF"]}]}`, or one `enum` of numbers and strings for an enumeration. A type that allows none of them is
a plain number, one that allows no number an `enum` of strings. An `xs:float` is a 32-bit float, so an enumeration value
of it stands for all numbers that round to the same float: the schema has the range of numbers halfway to the
neighbouring floats, `{"exclusiveMinimum": 0.09999999776482582, "exclusiveMaximum": 0.10000000521540642}` for `0.1`, so
`0.10000000149011612` is the same value. Bounds and `fixed` of `xs:float` compare the same way: `minInclusive="0.1"`
starts at the lower end of the range of `0.1`, and `fixed="0.1"` is the whole range, with the value in `default`.

The same holds at the ends of the range of a float: every number from 2^128 - 2^103 (3.4028235677973366e38) on rounds
to the float `INF`, every number up to its negative to `-INF`. So an `xs:float` type that allows `INF` also allows these
numbers, beside the string, and one that rules out `INF` rules them out: `minInclusive="INF"` allows `"INF"` and the
numbers from 3.4028235677973366e38 on, `maxExclusive="INF"` the numbers below it, and `fixed="INF"` is `"INF"` or such
a number, with `"INF"` in `default`. A literal of the schema beyond the range of a float, such as `fixed="1e39"`,
`-1e39` in an enumeration or `default="1e400"`, which even a double can't hold, is `INF` or `-INF` in the same way; as
a `default` it is written `"INF"` or `"-INF"`. The
string is the form these values are written in; the numbers are further JSON forms of the same value, as a document
can write it, `1e39` for instance. On `xs:double`, `INF` and `-INF` are the strings only.

A union with a float or double member has no `type` of its own; its members decide.

### Equal values

Enumeration and `fixed` compare values, not text. A JSON number or boolean compares by value anyway. Where the JSON
value is a string but several spellings mean the same value, the schema lists them in a pattern instead of `enum` or
`const`:

- dates and times: the time zone `Z` also as `+00:00` and `-00:00`, and seconds with or without trailing zeros, so the
  enumeration `2002-01-01T12:00:00-00:00` accepts `2002-01-01T12:00:00Z` and `2002-01-01T12:00:00.0+00:00`;
- `xs:hexBinary`: either case, `0aFF` and `0AFF`;
- a union whose value is a string: a boolean member value as `true` or `1`, a decimal or integer member value with
  or without leading and trailing zeros and a plus sign.

A fixed value written as a pattern keeps the value in `default`, which an empty element takes. With another pattern
on the type, the spellings are one more pattern in `allOf`. A float or double value of a union whose value is a string
has too many spellings for a pattern: a fixed value is then only a `default`, and an enumeration compares the text;
both are reported as `unsupported-union`.

### Lists

An `xs:list`, also the built-in `xs:NMTOKENS`, `xs:IDREFS` and `xs:ENTITIES`, becomes an array of its items, marked
with `"xml": {"list": true}`. XML collapses the whitespace of a list and splits it at spaces, so
`<Numbers> 1 +02\n 3 </Numbers>` with integer items becomes `[1, 2, 3]` and an empty element `[]`.

- Each item is a value of the item type, with its facets, under the rules for simple values. An item type that is a
  union with members of different JSON types gives string items checked as described in [Unions](#unions).
- `length`, `minLength` and `maxLength` count items and become `minItems` and `maxItems`. The built-in list types need
  at least one item: `minItems: 1`.
- An enumeration compares values: it becomes an `enum` of arrays. With the enumeration `1 2` on a list of integers,
  `"+01 002"` is valid and becomes `[1, 2]`.
- `fixed` and `default` become arrays too: `fixed="true 0"` on a list of booleans gives `"const": [true, false]`.
- A list of `xs:float` compares its items as floats (see [Special float values](#special-float-values)), so an
  enumerated or fixed list is not an array of numbers but one array schema per value: exactly as many items, each the
  numbers, or the string `INF` or `-INF`, that are the float at its place. Several enumerated values are an `anyOf` of
  these; a list whose items belong to different values, such as `1 4` for the values `1 2` and `3 4`, matches none.
- A `pattern` on a list restricts the text of the whole list and can't be checked on the array. It is left out and
  reported as `unsupported-list-pattern`.
- An element of a list type with `maxOccurs` greater than 1 is an array of lists: `[[6], [7, 8]]`. Only the inner
  arrays carry `xml.list`, so a reader of XML can tell the items of a list from repeated elements.
- A union with a list member is a string, reported as `unsupported-union`.

### Binary data

`xs:hexBinary` gets a pattern for pairs of hexadecimal digits. `xs:base64Binary` gets a pattern of its lexical form
in XML Schema (Part 2, 3.2.16): quartets of the base64 alphabet, padding with `=` only at the end, and only the
characters before the padding that leave the unused bits zero. Single spaces may separate the characters, as XML
leaves them after collapsing whitespace: `"Zm9v YmFy"` is valid, `"AB=="` and `"*** ERROR ***"` are not. The empty
string is valid. `contentEncoding: "base64"` stays as an annotation. Lengths count octets and are omitted with
`unsupported-length`.

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

**Valid XML is rejected in `format` mode when a time zone is missing.** XML Schema makes the time zone optional, so
`2026-11-04T08:30:00` is a valid `xs:dateTime` and `08:30:00` a valid `xs:time`, but `format` rejects both. Data
written without time zones fails on every such value. A date with a time zone, such as
`2026-11-04+01:00`, is rejected too. Use the default `pattern` for XML data that doesn't always carry a time zone.

Because Draft 2020-12 treats `format` as an annotation by default, format validation must be enabled in the validator; see
[Ajv configuration](validation.md#configuration).

### Whitespace

XML normalizes the text of most simple types before checking it: `replace` turns tabs, line feeds and carriage returns
into spaces, and `collapse` also joins runs of spaces and removes them at both ends. The JSON value is the normalized
text. For `xs:token` with `length="3"`, `<Code> AB1 </Code>` is valid XML and its JSON value is `"AB1"`. Only space,
tab, line feed and carriage return are XML whitespace: a no-break space (U+00A0) or an em space (U+2003) is content
and stays, also in `fixed`, `default` and enumeration values and when a list is split.

The schema records the normalization of every string value that XML normalizes, as `"xml": {"whiteSpace": "replace"}`
or `"collapse"`:

- `xs:normalizedString` replaces. `xs:token` and its derivations collapse, and so do the date and time types,
  `xs:anyURI`, `xs:QName`, `xs:base64Binary`, `xs:hexBinary`, the other types that become JSON strings in either
  `dateTime` mode. A list collapses before it is split into items. A `whiteSpace` facet in the derivation chain
  tightens the built-in value.
- `xs:string` without a `whiteSpace` facet keeps its text as written and has no annotation. Numbers and booleans have
  none either; a JSON number or boolean has no whitespace.
- The annotation belongs to the simple type: it is in the type's definition in `$defs`, or next to the other `xml`
  members for a type in place, on `items` for an array. It applies to element values, attribute values and the text
  property of simple content.
- Enumeration, `fixed` and `default` values are normalized the same way: `fixed=" x  y "` on `xs:token` becomes
  `"const": "x y"`.
- XML normalizes the text of a union for each member on its own, trying the members in order; the first member that
  accepts its normalized text decides. So each `anyOf` branch has the annotation of its member, and the union has
  the normalization all its members share, if any. For a union of `xs:date` and an empty `xs:string`,
  `<T> 2026-11-11 </T>` is valid and its JSON value is `"2026-11-11"`. For `xs:token` and `xs:string`, in this order,
  the token member accepts every text, so the value is always collapsed. Enumeration, `fixed` and `default` values of
  a union are normalized the same way.
- The root element keeps the annotation of its type next to its `name` and `namespace`.

Validators don't normalize. Whoever converts XML to JSON applies the annotation before validating; JSON that already
holds normalized values needs nothing. With `options.xml` set to `false`, the annotation is omitted like all `xml`
members.

### Patterns

The converter translates XML Schema patterns into anchored JavaScript regular expressions using the `u` flag:
`^(?:…)$`.

- `^` and `$` are ordinary characters in XML Schema patterns, so they are escaped.
- `.` excludes line feed and carriage return. `\d` becomes any decimal digit (`\p{Nd}`); `\s` means space, tab, line
  feed and carriage return. `\w` excludes punctuation, separators and Unicode category C. `\i` and `\c` represent XML
  name characters as XML 1.0, Second Edition, defines them, to which XML Schema 1.0 refers; so do the name types.
  Characters that later editions added, such as titlecase letters (`ǅ`), letter numbers (`Ⅻ`) and characters beyond the
  Basic Multilingual Plane, are no name characters; `١` (ARABIC-INDIC DIGIT ONE) may follow a name start but not begin a
  name. A pattern with `\i` or `\c` is long.
- `\-` outside a character class becomes a plain hyphen. Class subtraction such as `[a-z-[aeiou]]` uses a lookahead.
- Patterns in one restriction step are alternatives, whereas patterns across restriction steps must all match. The
  converter combines them with lookaheads.
- Block escapes such as `\p{IsBasicLatin}` aren't translated. The pattern is dropped and reported as
  `untranslatable-pattern`.

## Nil

An element declared with `nillable="true"` may carry `xsi:nil="true"` (or `"1"`) instead of content when the
declaration has no `fixed` value.

- Without attributes it is `null`, for simple and complex types alike: `<Birth xsi:nil="true"/>` becomes
  `"Birth": null`.
- With attributes it is an object with the attributes and the text property `null`, without child elements:
  `<Address kind="home" xsi:nil="true"/>` becomes `{"kind": "home", "value": null}`.
- `xsi:nil="false"` is ordinary content. In an array, items may be `null`: `[1, null, 3]`.

The property of a nillable element is marked with `"xml": {"nillable": true}`. Its `anyOf` starts with the content
and continues with the allowed nil forms. For `maxOccurs` greater than 1, `items` holds that `anyOf`. A declaration with
`fixed` keeps only the content branch, and `xsi:nil="false"` still reads as ordinary content. A `default` value leaves
the nil forms available.

When the type has required attributes, a nil element must keep them in an object. The attributes keep the keys of
the content object, so the attribute `value` is `@value` in both.

## Substitution groups and xsi:type

A particle that refers to the head of a substitution group is a choice between the head, unless it is abstract, and
the members that may stand in for it: also members of members, without abstract elements and without those whose
type derives from the head's type by a method that the head or the head's type blocks with `block` or
`blockDefault`, also for a member with an anonymous type. A member without a type of its own has the type of its head.

- Each element is a property under its own name; the particle's occurrences apply. With `maxOccurs` greater than 1,
  each member that occurs is an array: `{"Invoice": [{…}], "Credit": [{…}, {…}]}`. Each array has at most `maxOccurs`
  items, but how many there are together isn't checked. The order of the members is lost, like element order in
  general.
- An abstract head without members can't occur; that is reported as `unsupported-element`.

`xsi:type` may select a type derived from the declared type of an element by extension or restriction, unless the
element or the type blocks that method. For a complex type, also one with simple content, the element is then an
object with `"#type": "{namespace}local"` and the properties of the selected type:
`<Vehicle xsi:type="Car">` becomes `{"#type": "{urn:example}Car", "Plate": "K", "Seats": 4}`. A type without
namespace is written `{}local`.

- Every named complex type has an optional property `#type` with its own name as `const`, marked with
  `"xml": {"xsiType": true}`: `xsi:type` may name the declared type too, and `#type` is then written.
- An element of a complex type with derived types is an `anyOf` of its type, unless that is abstract, and each derived
  type, which then requires `#type`. An abstract type without derived types is reported as `unsupported-element`.
  An element's `fixed` or `default` value also applies when `xsi:type` selects a derived type with simple content.
  Whitespace normalization can hide a distinction XML makes. For example, declare `reading` with `fixed="a  b"`
  on a type with `xs:string` content, and define `Derived` as a restriction with `xs:whiteSpace value="collapse"`.
  Both `<reading xsi:type="Derived"/>` and `<reading xsi:type="Derived">a b</reading>` then have the JSON text
  value `"a b"`. XML accepts the empty element but rejects the explicit text, which differs from the declared
  fixed value after normalization.
- A nil element with `xsi:type` keeps `#type` next to the attributes of the type it names, inherited ones included:
  `{"#type": "{urn:example}Dog", "chip": "123", "value": null}`. The nil form for a derived type requires `#type`.
  When the declared type is abstract, a nil element must select a concrete type and keep it in `#type`.
- An object that has a repeated group named `type` already uses the property `#type`; that is reported as
  `duplicate-name`.

An element of a simple type has no object form. `xsi:type` there may only name the declared type, which changes
nothing: `<Number xsi:type="xs:decimal">5</Number>` is `5`. The declared type is recorded as
`"xml": {"type": "{namespace}local"}`, in the definition of a named simple type or next to an element of a built-in
type. Any other `xsi:type` on such an element, such as `xs:integer` for an `xs:decimal`, has no JSON form.

## Elements of xs:anyType

An element declared without a type, without a type it takes from the head of its substitution group, or with
`type="xs:anyType"` takes any content. It is written like content a wildcard takes, see [Wildcards](#wildcards); an
empty element is `""`, or its fixed or default value. Its schema accepts anything and is marked with
`"xml": {"anyType": true}`, which sets it apart from an unknown type (`{}`) and from an open object
(`xml.anyElement`). `unsupported-any` reports each such element.

`xsi:type` may select a complex type: the element is then an object with `#type`. Its properties follow the
definition of that type exactly when the type is reachable from the root through declarations, and so has a
definition in `$defs`; otherwise the content is written without a schema, like wildcard content. `xsi:type` naming
a simple type, such as `xs:int`, has no JSON form.

## Wildcards

Elements that `xs:any` takes and attributes that `xs:anyAttribute` takes are written without a schema, whatever
`processContents` says and even when a global declaration matches:

- An element without attributes and children is its text, as written and without normalization; an empty element is
  `""`.
- An element with attributes is an object: the attributes are strings under their local names, the text is in the
  text property. An element with attributes only has no text property: `<f:x a="1"/>` is `{"a": "1"}`.
- Child elements are written under their local names by the same rules. Whitespace-only text between children is
  formatting and is dropped. Children with text that isn't only whitespace are mixed content: the whole inner
  content is one self-contained markup string in the text property.
- Several siblings with the same name become an array; a single one is a value. Unlike declared elements, the form
  depends on how many there are.
- Attributes that `xs:anyAttribute` takes are strings under their local names. `xmlns` and `xsi:` attributes never
  become properties.

For `<Ext f:a="1"><f:x>one</f:x><f:x> two </f:x><f:y f:b="2">y</f:y></Ext>`, `Ext` becomes
`{"a": "1", "x": ["one", " two "], "y": {"b": "2", "value": "y"}}`.

The name of the text property is reserved here too: a child of that name is `{namespace}local`, an attribute
`@local`, as in `{"@value": "w", "{urn:example}value": "v"}`. There is no JSON form when two siblings have the same
local name in different namespaces, when an attribute and a child have the same local name, or when a name is a
declared property of the same object.
Elements outside a wildcard that the schema doesn't declare stay unknown, even in an object that is open for other
reasons. The schema doesn't check wildcard content, its namespaces or its count, and reports `unsupported-any`.

## The `xml` annotation

`xml` is a custom annotation based on the OpenAPI XML object. It records XML metadata without adding validation
constraints.

The [Ajv example](validation.md) registers the annotation so the validator accepts it. Alternatively, set
`options.xml` to `false` to omit it.

| Member         | Where                         | Meaning                                                                                                                                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Root, properties              | Local name of the root element, or of a property whose key isn't its local name; see [Property names](#property-names).                                                    |
| `namespace`    | Root, properties              | Namespace URI of a qualified element or attribute.                                                                                                                         |
| `attribute`    | Properties                    | `true` for an attribute.                                                                                                                                                   |
| `text`         | Text property                 | `true` for simple content.                                                                                                                                                 |
| `mixed`        | Text property                 | `true` for text containing child elements as XML markup.                                                                                                                   |
| `group`        | Group property                | `true` for an array of repeated group occurrences.                                                                                                                         |
| `whiteSpace`   | String values, union branches | `replace` or `collapse`: how XML normalizes the value; see [Whitespace](#whitespace).                                                                                      |
| `list`         | Arrays                        | `true` for the items of an `xs:list`, as opposed to repeated elements; see [Lists](#lists).                                                                                |
| `nillable`     | Element values                | `true` when the element is declared nillable. The first `anyOf` branch holds content and the remaining branches hold any allowed nil forms. See [Nil](#nil).               |
| `anyElement`   | Objects                       | `true` for an object with `xs:any`; see [Wildcards](#wildcards).                                                                                                           |
| `anyAttribute` | Objects                       | `true` for an object with `xs:anyAttribute`.                                                                                                                               |
| `xsiType`      | `#type`                       | `true` for the property that holds the type `xsi:type` selects; see [Substitution groups and xsi:type](#substitution-groups-and-xsitype).                                  |
| `type`         | Simple types                  | `{namespace}local` of a named simple type, or of the built-in type of an element: the only type `xsi:type` may name for its value.                                         |
| `decimal`      | Number values                 | `true` for `xs:decimal` and its restrictions: the XML text has no exponent, and an integer value may be written `1.0`. Integer types and `xs:float`/`xs:double` have none. |
| `anyType`      | Element values                | `true` for an element of `xs:anyType`, written without a schema; see [Elements of xs:anyType](#elements-of-xsanytype).                                                     |

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
| `rounded-number`                  | A bound, enumeration, fixed or default value is rounded because a JSON number cannot hold it exactly: more than 15 significant digits, or a magnitude beyond 2^53 - 1, where decimals next to it round onto the same number. Also `fractionDigits` on a type whose values may have more than 15 significant digits: such a value is rounded before the check. |
| `approximated-total-digits`       | Decimal `totalDigits` without a representable `fractionDigits` limit is checked only as a numeric bound.                                                                                                                                                                                                                                                      |
| `lexical-pattern`                 | A pattern on a number or boolean constrains XML text, not the JSON value.                                                                                                                                                                                                                                                                                     |
| `unreachable-enumeration`         | An enumeration value excluded by another facet is removed.                                                                                                                                                                                                                                                                                                    |
| `unsupported-any`                 | `xs:any` or `xs:anyAttribute` leaves the object open, or an element is of `xs:anyType`; such content is written without a schema and isn't checked.                                                                                                                                                                                                           |
| `unsupported-mixed`               | Mixed content that can hold elements is an XML markup string; child elements aren't checked.                                                                                                                                                                                                                                                                  |
| `unsupported-bound`               | A minimum or maximum on a date or time type isn't applied, or the range of `xs:long` or `xs:unsignedLong` beyond 2^53, which JSON numbers can't hold exactly.                                                                                                                                                                                                 |
| `unsupported-identity-constraint` | `xs:key`, `xs:keyref` or `xs:unique` isn't checked.                                                                                                                                                                                                                                                                                                           |
| `unsupported-length`              | An octet length on `xs:base64Binary` is omitted.                                                                                                                                                                                                                                                                                                              |
| `unsupported-list-pattern`        | A pattern on a list restricts the whole text, which the array doesn't keep; it is left out.                                                                                                                                                                                                                                                                   |
| `unsupported-union`               | A union of members with different JSON types is a string; what a member's lexical form can't check is left out.                                                                                                                                                                                                                                               |
| `unchecked-id`                    | The schema uses `xs:ID` or `xs:IDREF`: their values are checked as names, but not that IDs are unique or that a reference points to one. Reported once per schema.                                                                                                                                                                                            |
| `unchecked-qname-prefix`          | An `xs:QName` value is checked as `prefix:local`; whether the prefix is bound to a namespace isn't checked.                                                                                                                                                                                                                                                   |
| `neutralized-doctype`             | A DOCTYPE declaration that changes nothing is ignored; see [Schema input](#schema-input).                                                                                                                                                                                                                                                                     |

### Errors: unsupported constructs and mappings

| Code                         | Meaning                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-name`             | Two particles can't share a property: one element name with different types. Also a repeated group named `type` next to `#type`, or one whose key is the name of the text property. The first one is kept. |
| `unsupported-element`        | An abstract element without members, an element of an abstract type without derived types, an abstract root element, or `xs:alternative`.                                                                  |
| `unsupported-facet`          | `xs:assertion`, `xs:explicitTimezone`, an unknown facet or a numerically unrepresentable digit constraint is omitted.                                                                                      |
| `unsupported-include`        | An included document declares a target namespace other than that of the including document.                                                                                                                |
| `unsupported-particle`       | A sequence, choice or `all` contains something other than an element, a group or `xs:any`. Also covers `xs:assert` or `xs:openContent` in a complex type. The construct is ignored.                        |
| `unsupported-redefine`       | `xs:redefine` of a type, or `xs:override`; no schema is written.                                                                                                                                           |
| `unsupported-simple-content` | The base of a `simpleContent` derivation lacks simple content; the text is a string.                                                                                                                       |
| `unsupported-value`          | `fixed` or `default` on an element with complex content is ignored.                                                                                                                                        |
| `untranslatable-pattern`     | A pattern containing a block escape such as `\p{IsBasicLatin}` is dropped.                                                                                                                                 |

### Errors: mistakes in the XML Schema

| Code                  | Meaning                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `circular-group`      | A group or attribute group contains itself.                                                                                                                       |
| `circular-type`       | A type derives from itself.                                                                                                                                       |
| `duplicate-component` | Two global components of the same kind have the same name.                                                                                                        |
| `invalid-facet`       | An invalid facet value, such as `maxLength="abc"`, or a `whiteSpace` that relaxes its base; the facet or enumeration value is dropped.                            |
| `invalid-value`       | A `fixed` or `default` value doesn't fit its type, such as an `xs:double` literal beyond the range of a double; on `xs:float`, such a literal is `INF` or `-INF`. |
| `unknown-attribute`   | An attribute reference can't be resolved.                                                                                                                         |
| `unknown-element`     | An element reference can't be resolved.                                                                                                                           |
| `unknown-group`       | A group or attribute-group reference can't be resolved.                                                                                                           |
| `unknown-prefix`      | A prefix has no namespace declaration.                                                                                                                            |
| `unknown-type`        | A type or base type isn't defined.                                                                                                                                |

### Errors: files and the root element

| Code                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-xml`          | A schema file isn't well-formed XML.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `missing-file`         | A schema file is missing or can't be read, such as a URL that `convertFile` doesn't read.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `namespace-mismatch`   | An `xs:import` names another namespace than the target namespace of the imported document.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `not-a-schema`         | A file isn't an XML Schema document.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `resource-limit`       | The schema set exceeds a size limit, the schema would hold more output entries than `maxOutputEntries` allows, the structure report of `describeSchema()` would exceed `maxStructureSize`, or it nests deeper than the converter can follow (local element types more than 1000 levels deep, or nested model groups, chains of group references or chains of derived types so deep that the stack runs out); the message names the limit. No schema is written. See [Schema input](#schema-input). |
| `root-required`        | No root is selected and the entry has no global element or more than one.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `unknown-root`         | The selected root isn't a global element in the loaded schema set.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unsafe-input`         | A file has a DOCTYPE declaration other than the harmless form or a markup declaration after the root element, the entry is outside the base directory, or a schema location leaves it; no schema is written. See [Schema input](#schema-input).                                                                                                                                                                                                                                                    |
| `unsupported-encoding` | A schema file declares an encoding other than UTF-8, UTF-16 (with a byte order mark), ISO-8859-1 and US-ASCII; no schema is written. See [Schema input](#schema-input).                                                                                                                                                                                                                                                                                                                            |

## Schema input

The converter reads schema documents as data and stops before they grow too large:

- **Size limits:** by default 4 MiB (4194304 bytes) per document, 16 MiB (16777216 bytes) for all documents together,
  and 128 documents. The option `limits: { maxFileBytes, maxTotalBytes, maxDocuments }` of `convert` and
  `convertFile`, or `--max-file-bytes`, `--max-total-bytes` and `--max-documents` on the command line, set them;
  each must be a positive safe integer, and none means unlimited. Bytes count as UTF-8 before parsing, and
  `convertFile` checks the size of a file before it reads it. A document included into a further namespace
  (chameleon include) is loaded once more for that namespace and counts again, as a document and with its bytes.
  Above a limit, `resource-limit` names the limit in effect, and no schema is written, as with `unsafe-input`: a
  schema without the documents left out would look usable but be incomplete.
- **Output limit:** a small schema can describe a large JSON Schema: a long chain of extensions whose types are all
  used repeats every inherited property in each type and lists every derived type at each use. `maxOutputEntries`
  (`--max-output-entries`, by default 200000, a positive safe integer) limits the output entries of the schema: one for
  each key of a `properties` map and one for each branch of an `anyOf` or `oneOf`, wherever it is written; `allOf`,
  other keywords, `enum` values and `required` names don't count, and a definition counts once, however often a `$ref`
  points to it. Above it, `resource-limit` names the limit, and no schema is written. The converter stops while it
  writes the schema, as soon as it is certain to exceed the limit, and counts the entries of a choice before it makes
  them. A property it builds only to drop it, such as one a further particle declares again, doesn't count. Where a
  later particle of the same object declares a name of a choice again, the choice can no longer rule that name out
  (`approximated-occurrences`), so its `false` entries for the name are not made at all. The limit bounds these
  entries, not the memory or the size of the output. The structure report of `describeSchema()` has a limit of its
  own, `maxStructureSize` (see [Structure report](structure.md#limits)).
- **DOCTYPE:** a DTD can define entities that change what a document says or read other files, so the converter
  processes none. It accepts one form that provably changes nothing, a DOCTYPE that only restates namespace declarations
  of the root element and declares unused entities: one DOCTYPE before the root element, whose `PUBLIC` or `SYSTEM`
  identifier is never read, and whose internal subset holds only comments, unused general entities with literal text,
  unused empty parameter entities, and `CDATA` defaults of namespace declarations (`xmlns`, `xmlns:prefix`) that the
  root element states itself with the same text, without character references. An entity name in a comment, CDATA
  section or processing instruction is no use of it. Such a declaration is replaced by spaces, keeping line numbers, and
  reported as `neutralized-doctype`. Any other DOCTYPE is `unsafe-input`: an entity used in the document, a declaration
  of a predefined entity such as `amp`, an external entity, a parameter entity reference, an `ELEMENT` declaration, a
  namespace default the root element doesn't state with the same text, white space missing where XML requires it, also
  between two attribute definitions, or a markup declaration after the root element. Text in a comment that only looks
  like a DOCTYPE is a comment.
- **Encoding:** `convertFile` reads the bytes of each file and decodes them as the byte order mark and the XML
  declaration say: UTF-8 (also without both), UTF-16 with a byte order mark, ISO-8859-1 (each byte its own code point,
  not Windows-1252) and US-ASCII; the XML declaration is read to its `?>`, however long. Another encoding is
  `unsupported-encoding`. Bytes the encoding doesn't allow, a byte order mark the declaration contradicts, a second
  byte order mark, white space before the XML declaration, a declaration without `?>`, and a byte order mark or an XML
  declaration later in the prolog are `invalid-xml`. No replacement character stands in for a bad byte, and no schema
  is written. The size limits
  count the bytes of the file. `convert` takes text that is already decoded and ignores its encoding declaration.
- **Locations:** `convertFile` reads relative paths inside its base directory only. A schema location that leaves it,
  a symbolic link to outside, an absolute path or a `file:` URL is `unsafe-input`, and no schema is written. Another
  URL is not read and is reported as `missing-file`.

## Limits

- Anonymous complex types of local elements nested more than 64 levels deep are written as definitions in `$defs`;
  beyond 1000 levels there is no schema but `resource-limit`. The same holds where nested model groups, chains of
  group references or chains of derived types (`extension`, `restriction`) run so deep that the converter's stack runs
  out. How many levels that allows depends on the shape of the schema and on the state of the Node.js process; a
  fresh process, as the command line starts, reaches it earlier than one that has converted before. This version
  reaches it at fewer levels than the previous one.
- Nested simple-type lists and unions are traversed with a depth limit of 1000. Beyond that depth the converter
  reports `resource-limit`.
- XML child-element order isn't checked, and no problem is reported for it: it is a limit of every JSON object.
  Listing properties in schema order doesn't enforce that order in JSON. For `<xs:sequence>` of `a` and `b`, the
  documents `<R><a/><b/></R>` and `<R><b/><a/></R>` both become `{"a": "", "b": ""}`; the second is invalid XML, and
  the schema accepts its JSON all the same. A JSON document the schema accepts is therefore no proof that the XML it
  came from is valid; validate the XML against the XML Schema for that.
- IDs aren't checked for uniqueness, and references aren't checked to point to an ID; see `unchecked-id`.
- Equal values with another time zone offset, such as `13:00:00+01:00` for `12:00:00Z`, aren't recognized as equal;
  see [Equal values](#equal-values). Durations compare as written.
- JSON values lose lexical details such as a number's leading zeros or `+` sign, and whitespace that XML normalizes
  away; `xml.whiteSpace` says which string values are normalized, and `xml.decimal` marks decimal numbers, which XML
  writes without an exponent.
- `xs:redefine` of a simple or complex type isn't supported, nor `xs:override`. Wildcard content and mixed-content
  markup aren't validated, and identity constraints aren't checked.
- A pattern on a list isn't checked; see [Lists](#lists).
- How many members of a substitution group occur together isn't checked; see
  [Substitution groups and xsi:type](#substitution-groups-and-xsitype).
- `xsi:type` on an element of a simple type may only name the declared type.
- `xs:anyURI` becomes a string without URI-syntax validation.
- `xs:QName` values keep their prefix: `"t:Order"`. JSON has no namespace declarations, so the schema checks only the
  syntax, not that the prefix is bound, and enumeration and `fixed` values compare the prefixed text. Check QName
  values against the XML document before converting it when the binding matters.
- Numeric values and bounds use JavaScript numbers. Precision lost during parsing cannot be recovered; a value that
  a JSON number cannot hold exactly is reported as `rounded-number`. An `xs:float` literal is rounded to a double
  first, then to a float; a decimal very close to the middle between two floats, or to 3.4028235677973366e38, can
  thus end on the neighbouring float.
- `xs:long` is emitted without bounds; `xs:unsignedLong` keeps only its minimum of 0. Their limits exceed the exact
  integer range of JavaScript numbers.

### Validator setup

See [Validating with Ajv](validation.md) for a Draft 2020-12 setup that handles choice branches, `xml` annotations
and decimal `multipleOf` constraints.
