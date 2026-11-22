# xsd-to-jsonschema

Convert an XML Schema (XSD 1.0) to JSON Schema Draft 2020-12 for a chosen root element. The CLI and Node.js API read
local files, including imports and includes. The browser API accepts schema text. You supply JSON documents in the shape
the generated schema describes.

## Quick start

Use Node.js 24 in the repository checkout to convert the bundled order.

```sh
npm ci
npm run build
node dist/bin.js examples/order/order.xsd --out order.schema.json
```

Open `order.schema.json` to see which fields an order accepts. The converter warns about the markup inside `Note` and
wildcard content in `Extensions`, both of which the generated schema leaves unchecked.

The root element becomes the top-level JSON value. Repeated elements become arrays, so the first order line is
`Line[0]`. Its `Price` element has a `currency` attribute and decimal text.

```xml
<Price currency="EUR">4.99</Price>
```

In JSON, `currency` keeps its name and the text becomes a number in `value`.

```json
{ "currency": "EUR", "value": 4.99 }
```

Compare the complete [XML order](examples/order/order.xml), [JSON order](examples/order/order.json) and
[generated schema](examples/order/order.schema.json). To check a JSON document against the schema, follow the
[Ajv example](docs/validation.md).

## Install in another project

The npm package requires Node.js 22.12+ and supports ES modules and CommonJS.

```sh
npm install xsd-to-jsonschema@1.0.0
npx xsd-to-jsonschema order.xsd --root Order --out order.schema.json
```

Omit `--root` when the entry file declares just one global element. The CLI writes diagnostics to stderr and the schema
to stdout unless you pass `--out`. Exit `0` means success, `1` means the schema was written with errors (or warnings
under `--strict`), and `2` means no schema was written. Run `npx xsd-to-jsonschema --help` for all options. `xsd2json`
is a CLI alias.

## Use the library

From the checkout, the same example works with `convertFile`. Check `problems` even when the converter returns a schema.
An error can leave part of the schema incomplete.

```js
import { convertFile } from 'xsd-to-jsonschema/node';

const { schema, problems } = convertFile('examples/order/order.xsd');
for (const problem of problems) console.error(problem);
if (!schema || problems.some((p) => p.severity === 'error')) {
  throw new Error('Could not convert the order schema.');
}
console.log(JSON.stringify(schema, null, 2));
```

For schemas already in memory, `convert` accepts a map of paths to XSD strings or a loader function. This example also
runs in a browser application.

```js
import { convert } from 'xsd-to-jsonschema';

const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="Quantity" type="xs:int"/>
</xs:schema>`;
const { schema, problems } = convert({ files: { 'item.xsd': xsd }, entry: 'item.xsd' });
```

## Guides

- [Output format](docs/output.md) covers elements, attributes, choices and root selection. The
  [value reference](docs/values.md) covers simple types, lists and facets.
- [Options and diagnostics](docs/diagnostics.md) lists file-loading rules, CLI flags, limits and the meaning of each
  problem code.
- [Validating with Ajv](docs/validation.md) shows how to validate JSON, including exact decimal steps. Use an XSD
  validator when you also need to check the original XML.
- [Structure report](docs/structure.md) shows how `describeSchema()` and `describeSchemaFile()` expose XML details such
  as element order and link them to the generated schema.
- [Development](docs/development.md) covers the source, tests and release checks. See [Contributing](CONTRIBUTING.md)
  for pull requests.

[MIT license](LICENSE)
