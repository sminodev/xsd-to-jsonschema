# xsd-to-jsonschema

`xsd-to-jsonschema` converts XSD files to JSON Schema Draft 2020-12. It resolves imports and includes to generate
a schema for a selected root element, with a CLI and library APIs for Node.js and browsers.

It converts schema definitions, not XML documents. The [output documentation](docs/output.md) describes the expected
JSON representation and supported XSD constructs.

## Install

The package requires Node.js 22.12.0 or later and supports both ES module imports and CommonJS `require()`.

The package is not on npm yet. Use a [supported development version of Node.js](docs/development.md) to build a tarball
from a clone, then install it in your project.

```sh
npm ci
npm pack
cd /path/to/your/project
npm install /path/to/xsd-to-jsonschema/xsd-to-jsonschema-1.0.0.tgz
```

Once the package is published, `npm install xsd-to-jsonschema` replaces these steps.

## Quick start

For local files, `convertFile` loads the entry XSD together with its imports and includes:

```js
import { convertFile } from 'xsd-to-jsonschema/node';

const { schema, problems } = convertFile('order.xsd');

for (const problem of problems) {
  console.error(problem);
}

if (schema === undefined || problems.some((problem) => problem.severity === 'error')) {
  throw new Error('Could not convert order.xsd. See the problems above.');
}

console.log(JSON.stringify(schema, null, 2));
```

Because a conversion can return `schema` alongside errors, check `problems` before using the result. If the entry
file can't be read or no root element is found, `schema` is `undefined`. The problem codes are listed under
[Diagnostics](docs/output.md#problems).

Alternatively, use the CLI:

```sh
npx xsd-to-jsonschema order.xsd --out order.schema.json
```

`xsd2json` is an alias for the same command. Diagnostics go to stderr; the schema goes to stdout or `--out`.

| Exit code | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| `0`       | Schema written without errors.                                 |
| `1`       | Schema written with errors, or with warnings under `--strict`. |
| `2`       | No schema written.                                             |

Run `npx xsd-to-jsonschema --help` for all options. To validate JSON against the result, see the
[Ajv example](docs/validation.md).

## Usage

### Schema texts and custom loaders

For already loaded schemas, including in browser applications, `convert` accepts the XSD texts as strings keyed
by path:

```js
import { convert } from 'xsd-to-jsonschema';

const { schema, problems } = convert({
  files: { 'order.xsd': orderXsd, 'line.xsd': lineXsd, 'common/common.xsd': commonXsd },
  entry: 'order.xsd',
});
```

In this example, `orderXsd`, `lineXsd` and `commonXsd` contain the corresponding XSD documents.

Alternatively, `files` can be a loader function that receives a path and returns the schema text. Absolute import URLs
reach the function unchanged, allowing it to supply cached or local copies. In contrast, `convertFile` reads only
relative paths inside the entry's directory: a location outside it or a `file:` URL is reported as `unsafe-input`, a
remote URL as `missing-file`. For schemas in sibling folders, set `baseDirectory` (CLI: `--base-dir`) to their common
parent.

### Root and options

An explicit `root` selects a global element from any loaded schema, including imports and includes. Without it,
the entry schema must declare exactly one global element.

Root names can be local (`Order`), prefixed (`prefix:Order`) or expanded (`{urn:example:order}Order`). Prefixes are
resolved in the entry schema.

```js
const { schema, problems } = convertFile('order.xsd', {
  root: 'Order',
  options: { dateTime: 'format' },
});
```

| Setting                   | CLI flag                   | Default                                | Description                                                                                                                    |
| ------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `root`                    | `--root <name>`            | The entry schema's only global element | Root element to convert; required if the choice is ambiguous.                                                                  |
| `options.dateTime`        | `--date-time <mode>`       | `pattern`                              | Use XML Schema date/time patterns or JSON Schema `format` values.                                                              |
| `options.xml`             | `--no-xml`                 | `true`                                 | Include the `xml` annotations.                                                                                                 |
| `options.textProperty`    | `--text-property <name>`   | `value`                                | Property for the text of an element with simple content: an NCName other than `__proto__`, or `#text`.                         |
| `baseDirectory`           | `--base-dir <directory>`   | The entry's directory                  | Directory schemas may be read from, for `convertFile` and the CLI.                                                             |
| `limits.maxFileBytes`     | `--max-file-bytes <n>`     | `4194304` (4 MiB)                      | Bytes per schema document; see [Schema input](docs/output.md#schema-input).                                                    |
| `limits.maxTotalBytes`    | `--max-total-bytes <n>`    | `16777216` (16 MiB)                    | Bytes of all schema documents together.                                                                                        |
| `limits.maxDocuments`     | `--max-documents <n>`      | `128`                                  | Number of schema documents.                                                                                                    |
| `limits.maxOutputEntries` | `--max-output-entries <n>` | `200000`                               | Output entries of the schema: each key of a `properties` map and each branch of an `anyOf` or `oneOf`, wherever it is written. |
| `limits.maxStructureSize` | –                          | `20000000`                             | Structure units of the report of `describeSchema()`; see [Structure report](docs/structure.md#limits).                         |

With `dateTime: 'format'`, make sure your validator is configured to validate formats. The accepted date and time
forms differ from XML Schema: RFC 3339 requires a time zone, so `xs:dateTime` and `xs:time` values without one, such as
`2026-11-04T08:30:00`, are valid XML but rejected in `format` mode. Keep the default `pattern` for XML data that doesn't
always carry a time zone; see [Dates and times](docs/output.md#dates-and-times).

### Structure report

`describeSchema()` and `describeSchemaFile()` return the same schema and problems as `convert()` and `convertFile()`
for a report within `limits.maxStructureSize`, plus a report of the XML Schema's structure: particles in order with
their compositors, wildcards, identity constraints and the raw facets, each linked to its property in the schema. The
[structure documentation](docs/structure.md) describes it.

## Example: a multi-file order schema

The order example combines three XSD files with XML and JSON sample documents:

```text
examples/order/
├── order.xsd            root element Order, namespace urn:example:order
├── line.xsd             type Line, included into order.xsd (same namespace)
├── common/common.xsd    types of urn:example:common, imported by order.xsd and line.xsd
├── order.xml            a sample order
├── order.schema.json    the generated JSON Schema
└── order.json           the same order as JSON
```

The schemas demonstrate imports, includes, inheritance, choices, repeated elements and value constraints.

After installing the dependencies with `npm ci`, build and run the example:

```sh
npm run example
```

`Order` is the entry file's only global element, so no `--root` option is needed.

The [generated schema](examples/order/order.schema.json) includes:

- `oneOf` for the choice between pickup and delivery.
- `dependentRequired` for the optional pair `DiscountCode` and `DiscountPercent`.
- Inherited properties in `Contact` and a required `currency` in `Price`.
- Mixed content in `Note` and a wildcard in `Extensions`, both reported as warnings. Content the wildcard takes is
  written without a schema; the object is marked with `"anyElement": true`.

<details>
<summary>Show the schema excerpt</summary>

This excerpt omits properties and definitions. Use the [complete schema](examples/order/order.schema.json) for
validation.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "An order with its lines.",
  "type": "object",
  "properties": {
    "version": { "type": "string", "const": "1.0", "xml": { "attribute": true } },
    "channel": { "$ref": "#/$defs/Channel", "default": "web", "xml": { "attribute": true } },
    "Title": { "$ref": "#/$defs/Text40", "xml": { "namespace": "urn:example:order" } },
    "Express": {
      "type": "boolean",
      "xml": { "namespace": "urn:example:order", "type": "{http://www.w3.org/2001/XMLSchema}boolean" }
    },
    "Pickup": {
      "description": "The customer collects the order.",
      "type": "boolean",
      "xml": { "namespace": "urn:example:order", "type": "{http://www.w3.org/2001/XMLSchema}boolean" },
      "const": true
    },
    "Wanted": { "$ref": "#/$defs/PartialDate", "xml": { "namespace": "urn:example:order" } },
    "Note": {
      "description": "Free text that may mark words as bold or italic.",
      "$ref": "#/$defs/Note",
      "xml": { "namespace": "urn:example:common" }
    },
    "DiscountCode": {
      "type": "string",
      "xml": {
        "namespace": "urn:example:order",
        "whiteSpace": "collapse",
        "type": "{http://www.w3.org/2001/XMLSchema}token"
      }
    },
    "DiscountPercent": { "$ref": "#/$defs/Percent", "xml": { "namespace": "urn:example:order" } },
    "Contact": { "$ref": "#/$defs/Contact", "xml": { "namespace": "urn:example:order" } },
    "Line": {
      "type": "array",
      "items": { "$ref": "#/$defs/Line" },
      "minItems": 1,
      "maxItems": 5,
      "xml": { "namespace": "urn:example:order" }
    },
    "Extensions": {
      "description": "Data of other systems, in their own namespaces.",
      "type": "object",
      "xml": { "namespace": "urn:example:order", "anyElement": true }
    }
  },
  "required": ["created", "Title", "Express", "Line"],
  "additionalProperties": false,
  "dependentRequired": { "DiscountCode": ["DiscountPercent"], "DiscountPercent": ["DiscountCode"] },
  "allOf": [
    {
      "oneOf": [{ "required": ["Pickup"] }, { "required": ["DeliveryDate"] }],
      "dependentRequired": { "DeliveryTime": ["DeliveryDate"] }
    }
  ],
  "xml": { "name": "Order", "namespace": "urn:example:order" },
  "$defs": {
    "Note": {
      "type": "object",
      "properties": { "value": { "type": "string", "xml": { "text": true, "mixed": true } } },
      "required": ["value"],
      "additionalProperties": false
    },
    "Percent": {
      "type": "number",
      "multipleOf": 0.1,
      "minimum": 0,
      "maximum": 100,
      "xml": { "decimal": true, "type": "{urn:example:common}Percent" }
    },
    "Contact": {
      "type": "object",
      "properties": {
        "#type": { "const": "{urn:example:common}Contact", "xml": { "xsiType": true } },
        "Name": { "$ref": "#/$defs/Text40", "xml": { "namespace": "urn:example:common" } },
        "Email": { "$ref": "#/$defs/Email", "xml": { "namespace": "urn:example:common" } },
        "Phone": {
          "type": "string",
          "xml": { "namespace": "urn:example:common", "type": "{http://www.w3.org/2001/XMLSchema}string" }
        }
      },
      "required": ["Name", "Email"],
      "additionalProperties": false
    },
    "Price": {
      "description": "An amount that always says its currency.",
      "type": "object",
      "properties": {
        "#type": { "const": "{urn:example:common}Price", "xml": { "xsiType": true } },
        "currency": { "$ref": "#/$defs/Currency", "xml": { "attribute": true } },
        "value": { "type": "number", "xml": { "text": true, "decimal": true } }
      },
      "required": ["currency", "value"],
      "additionalProperties": false
    },
    "Kilogram": {
      "type": "number",
      "multipleOf": 0.01,
      "exclusiveMinimum": 0,
      "maximum": 100000,
      "xml": { "decimal": true, "type": "{urn:example:common}Kilogram" }
    }
  }
}
```

</details>

<details>
<summary>Compare the XML document with its JSON form</summary>

[`order.xml`](examples/order/order.xml):

```xml
<Order xmlns="urn:example:order" xmlns:c="urn:example:common" version="1.0" created="2026-11-04T09:30:00">
  <Title>Order 1</Title>
  <CustomerRef>C-7</CustomerRef>
  <Express>false</Express>
  <Level>0</Level>
  <DeliveryDate>2026-11-20</DeliveryDate>
  <Wanted>2026-11</Wanted>
  <c:Note>Please ring <c:b>twice</c:b>.</c:Note>
  <DiscountCode>AUTUMN</DiscountCode>
  <DiscountPercent>10</DiscountPercent>
  <Contact>
    <c:Name>Paper Shop</c:Name>
    <c:Email>orders@example.com</c:Email>
  </Contact>
  <Line>
    <Item>Paper</Item>
    <Quantity>2</Quantity>
    <Price currency="EUR">4.99</Price>
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

[`order.json`](examples/order/order.json):

```json
{
  "version": "1.0",
  "created": "2026-11-04T09:30:00",
  "Title": "Order 1",
  "CustomerRef": "C-7",
  "Express": false,
  "Level": 0,
  "DeliveryDate": "2026-11-20",
  "Wanted": "2026-11",
  "Note": { "value": "Please ring <c:b xmlns:c=\"urn:example:common\">twice</c:b>." },
  "DiscountCode": "AUTUMN",
  "DiscountPercent": 10,
  "Contact": { "Name": "Paper Shop", "Email": "orders@example.com" },
  "Line": [
    {
      "Item": "Paper",
      "Quantity": 2,
      "Price": { "currency": "EUR", "value": 4.99 },
      "Tag": ["A4"],
      "Packaging": { "Box": "M", "Weight": 2.5 }
    },
    { "Item": "Pens", "Quantity": 10 }
  ]
}
```

Tests validate `order.xml` against the XSD and `order.json` against the generated schema.

</details>

## Output

The root element's content is the top-level JSON value, without a root-name wrapper. Elements and attributes use
local names, repeated elements become arrays, repeated groups become arrays of objects, and named types are stored
in `$defs`.

JSON objects keep no order, so the schema can't check the order of child elements, and some XML Schema rules, such
as unique IDs, are left out with a warning. A JSON document the schema accepts is therefore no proof that the XML it
came from is valid; validate XML against the XML Schema itself.

See [Output format](docs/output.md) for the mappings, [limits](docs/output.md#limits) for unsupported behavior, and
[Validating with Ajv](docs/validation.md) for validator setup.

## Development

To build and check a repository checkout:

```sh
npm ci
npm run build
npm test
npm run lint
npm run lint:fix
npm run typecheck
```

The [development guide](docs/development.md) explains the code structure and tests, while
[CONTRIBUTING.md](CONTRIBUTING.md) covers pull requests. The project is not yet published; see
[Releases](docs/development.md#releases) for the publishing procedure.

## License

[MIT](LICENSE)
