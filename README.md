# xsd-to-jsonschema

Turn an XML Schema into a JSON Schema.

If your data is described by XSD files but travels as JSON, you still want to validate that JSON. xsd-to-jsonschema
reads your XML Schema 1.0 files, follows their imports and includes, and writes a JSON Schema 2020-12 for the root
element you pick. It converts schemas, not documents: [docs/output.md](docs/output.md) describes the JSON form the
schema expects, and where it can't match the XML Schema exactly, the converter tells you.

## Install

```sh
npm install xsd-to-jsonschema
```

Requires Node.js 22.12 or later. The package is an ES module; `require()` works too, since Node.js 22.12 can load
ES modules that way.

## Example: a multi-file order schema

[`examples/order`](examples/order) splits an order schema over three files:

```text
examples/order/
├── order.xsd          root element Order, namespace urn:example:order
├── line.xsd           type Line, included into order.xsd (same namespace)
├── common.xsd         types of urn:example:common, imported by order.xsd and line.xsd
├── order.xml          a sample order
├── order.schema.json  the generated JSON Schema
└── order.json         the same order as JSON
```

The schema is small, but it nests four levels deep (`Order` → `Line` → `Packaging` → `Weight`) and uses what real
schemas use: a choice between `Pickup` and a delivery date, a contact type from another namespace, repeated
elements, enumerations, a pattern, a fixed attribute and decimal places. In a clone of this repository, this builds
the package and prints the schema:

```sh
npm run example
```

It runs `xsd-to-jsonschema examples/order/order.xsd`. You don't need `--root Order` here, because `order.xsd` declares
only one global element. Here is part of the result (the full file is
[`order.schema.json`](examples/order/order.schema.json)):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "An order with its lines.",
  "type": "object",
  "properties": {
    "version": { "type": "string", "const": "1.0", "xml": { "attribute": true } },
    "Title": { "$ref": "#/$defs/Text40", "xml": { "namespace": "urn:example:order" } },
    "Express": { "type": "boolean", "xml": { "namespace": "urn:example:order" } },
    "Pickup": {
      "description": "The customer collects the order.",
      "type": "boolean",
      "const": true,
      "xml": { "namespace": "urn:example:order" }
    },
    "Contact": { "$ref": "#/$defs/Contact", "xml": { "namespace": "urn:example:order" } },
    "Line": {
      "type": "array",
      "items": { "$ref": "#/$defs/Line" },
      "minItems": 1,
      "maxItems": 5,
      "xml": { "namespace": "urn:example:order" }
    }
  },
  "required": ["Title", "Express", "Line"],
  "additionalProperties": false,
  "oneOf": [
    { "required": ["Pickup"], "properties": { "DeliveryDate": false, "DeliveryTime": false } },
    { "required": ["DeliveryDate"], "properties": { "Pickup": false } }
  ],
  "xml": { "name": "Order", "namespace": "urn:example:order" },
  "$defs": {
    "Text40": { "type": "string", "minLength": 1, "maxLength": 40 },
    "Contact": {
      "type": "object",
      "properties": {
        "Email": { "$ref": "#/$defs/Email", "xml": { "namespace": "urn:example:common" } },
        "Phone": { "type": "string", "xml": { "namespace": "urn:example:common" } }
      },
      "required": ["Email"],
      "additionalProperties": false
    },
    "Email": { "type": "string", "pattern": "^(?:[^@ ]+@[^@ ]+)$" },
    "Kilogram": { "type": "number", "multipleOf": 0.01, "exclusiveMinimum": 0 }
  }
}
```

The excerpt skips `CustomerRef`, `Level`, `Packages`, `Notes`, `Attachment`, the definitions `Line`,
`ServiceLevel` and `BoxSize`, and `DeliveryDate` and `DeliveryTime`, whose patterns for the XML Schema date and time
formats are long. Two things to note: the properties keep the order of the XML Schema, and the `oneOf`
keeps `Pickup` and the delivery date apart, so an order can have one or the other, but not both.

Here is `order.xml` next to its JSON form:

<table>
<tr><th><code>order.xml</code></th><th><code>order.json</code></th></tr>
<tr><td>

```xml
<Order xmlns="urn:example:order"
       xmlns:c="urn:example:common"
       version="1.0">
  <Title>Order 1</Title>
  <CustomerRef>C-7</CustomerRef>
  <Express>false</Express>
  <Level>0</Level>
  <DeliveryDate>2026-11-20</DeliveryDate>
  <Contact>
    <c:Email>orders@example.com</c:Email>
  </Contact>
  <Line>
    <Item>Paper</Item>
    <Quantity>2</Quantity>
    <Tag>A4</Tag>
    <Packaging>
      <Box>M</Box>
      <Weight>2.5</Weight>
    </Packaging>
  </Line>
  <Line>
    <Item>Pens</Item>
    <Quantity>10</Quantity>
  </Line>
</Order>
```

</td><td>

```json
{
  "version": "1.0",
  "Title": "Order 1",
  "CustomerRef": "C-7",
  "Express": false,
  "Level": 0,
  "DeliveryDate": "2026-11-20",
  "Contact": {
    "Email": "orders@example.com"
  },
  "Line": [
    {
      "Item": "Paper",
      "Quantity": 2,
      "Tag": ["A4"],
      "Packaging": {
        "Box": "M",
        "Weight": 2.5
      }
    },
    { "Item": "Pens", "Quantity": 10 }
  ]
}
```

</td></tr>
</table>

The tests keep both honest: `order.xml` has to be valid against the XML Schema, and `order.json` against the
generated schema.

## Usage

In Node.js, `convertFile` reads the entry schema and everything it imports or includes from disk:

```js
import { convertFile } from 'xsd-to-jsonschema/node';

const { schema, problems } = convertFile('examples/order/order.xsd');
```

`convert` takes the schema texts instead, keyed by path. It doesn't touch the file system, so it runs in the browser,
too:

```js
import { convert } from 'xsd-to-jsonschema';

const { schema, problems } = convert({
  files: { 'order.xsd': orderXsd, 'line.xsd': lineXsd, 'common.xsd': commonXsd },
  entry: 'order.xsd',
});
```

`files` can also be a function that gets a path and returns the text. It gets an import by absolute URL, such as
`https://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd`, exactly as written, so it can hand over a local copy.
`convertFile` downloads nothing and reports such an import as `missing-file`.

Once the package is installed, the command line does the same: `npx xsd-to-jsonschema order.xsd --out
order.schema.json`, and `--help` lists its options.

If the entry schema declares more than one global element, pick one with `root`: `Order`, `prefix:Order` and
`{urn:example:order}Order` all work. The other options go into `options`:

```js
const { schema, problems } = convertFile('order.xsd', { root: 'Order', options: { dateTime: 'format' } });
```

`problems` tells you where the JSON Schema can't express the XML Schema exactly, with a code, the file and the line
([all codes](docs/output.md#problems)).

| Option         | CLI flag                 | Default   | Description                                                                                                       |
| -------------- | ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `root`         | `--root <name>`          |           | the root element to convert                                                                                       |
| `dateTime`     | `--date-time <mode>`     | `pattern` | dates and times as `pattern` (XML Schema format, time zone optional) or `format` (JSON Schema `format`, RFC 3339) |
| `xml`          | `--no-xml`               | `true`    | add the `xml` annotations                                                                                         |
| `textProperty` | `--text-property <name>` | `value`   | the property that holds the text of an element with simple content                                                |

## Output

The generated schema describes the content of the root element. In short (the details are in
[docs/output.md](docs/output.md)):

- Elements and attributes become properties named after their local names: attributes first, then elements in the
  order of the XML Schema. Objects are closed (`additionalProperties: false`), unless `xs:any` or `xs:anyAttribute`
  allow other content there.
- Named types end up in `$defs`. A derived type is merged with its base, so you get one schema instead of a chain.
- A repeated element becomes an array with `minItems` and `maxItems`.
- A choice becomes a `oneOf`. Each branch requires its own properties and rules out those of the other branches.
- `fixed` values become `const` and `default` values stay `default`, both with the JSON type of the declared type:
  `fixed="1"` on an integer becomes `1`, not `"1"`.
- Patterns are anchored and translated to the regex flavor JSON Schema uses.
- The `xml` annotation records the XML side (namespace, attribute, text, mixed content), so you can map a document
  between XML and JSON. Validators ignore it or need it registered (Ajv: `ajv.addKeyword('xml')`).

Two things can't be checked in JSON: the order of elements, since JSON objects have none, and details of the XML
text such as leading zeros in a number. `xs:list`, substitution groups and identity constraints aren't supported,
and the content of `xs:any` and of mixed content isn't checked; where a schema uses them, they show up in `problems`.
[docs/output.md](docs/output.md#limits) lists all limits.

## Development

```sh
npm ci
npm run build                # compiles src/ to dist/
npm test                     # runs all tests, including the example
npm run lint                 # ESLint
npm run typecheck            # TypeScript, without writing files
npm run example              # builds and prints the schema for examples/order
UPDATE_EXAMPLES=1 npm test   # updates order.schema.json and order.json after an intended change
```

[docs/development.md](docs/development.md) explains how the converter and its tests work.

## License

[MIT](LICENSE)
