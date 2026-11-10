# Development

Development requires Node.js 22.13 or later. The build compiles TypeScript sources to `dist/` with `tsc`;
at runtime, the package depends only on `@xmldom/xmldom`.

```sh
npm ci
npm run build        # compile src/ to dist/
npm test             # run the tests with Vitest
npm run coverage     # run the tests with coverage
npm run lint         # run ESLint
npm run lint:fix     # apply ESLint fixes
npm run typecheck    # check types, including tests, without writing files
npm run format:check # check formatting
npm run format       # format with Prettier
npm run example      # build and print the schema for examples/order
```

If a change intentionally affects the generated output, update the reference examples:

```sh
UPDATE_EXAMPLES=1 npm test
git diff -- examples
```

The test rewrites `examples/order/order.schema.json` and `order.json`, so review the diff before committing.

## Terminology

- **Schema document**: one `.xsd` file.
- **Schema set**: the entry document together with its imports and includes.
  `xs:import` brings in another namespace; `xs:include` adds definitions to the same namespace.
- **Global component**: a top-level `xs:element`, `xs:attribute`, `xs:complexType`, `xs:simpleType`, `xs:group` or
  `xs:attributeGroup`. Components are looked up by expanded name: `{namespace}name`.
- **QName**: a name such as `c:Text40` in `type="c:Text40"`. Its prefix is resolved using the namespace declarations
  in scope on that element.
- **Qualified**: a local element or attribute that belongs to the target namespace, according to
  `elementFormDefault`, `attributeFormDefault` or `form`. That namespace is recorded in `xml.namespace`.
- **Simple type**: a value without child elements or attributes, such as `xs:string` or a type derived from it.
- **Facet**: a restriction such as `maxLength`, `pattern`, `enumeration` or `minInclusive`.
- **Restriction chain**: a simple type restricts another type, down to a built-in type. A value must satisfy the
  facets at every step.
- **Complex type**: a type with attributes or child elements. Simple content combines text and attributes; complex
  content contains child elements.
- **Particle**: an entry in a content model, with `minOccurs` and `maxOccurs`: an element, model group, group
  reference or `xs:any`.
- **Model group**: `xs:sequence` for ordered particles, `xs:choice` for alternatives, or `xs:all` for elements in any
  order.

`Fragment`, defined in `src/content-model.ts`, represents a model group's properties in document order, required
properties and choice constraints.

## Conversion pipeline

`convert()` loads the schema documents, then selects the root element and passes it to the emitter:

```text
convert()
  └─ SchemaSet.load(entry)   load imports and includes; index global components
      └─ find root          use the root option or the entry's only global element
          └─ Emitter.root() emit the root schema and referenced definitions
              └─ { schema, problems }
```

- `src/index.ts`: the main entry point, `convert()` and public types. It uses no Node.js built-ins, so it also runs
  in browsers.
- `src/node.ts`: the `xsd-to-jsonschema/node` entry point. It exports the main API plus `convertFile()`.
- `src/convert.ts`: conversion options and root selection.
- `src/schema-set.ts`: document parsing, relative import and include resolution, global component lookup and QName
  resolution.
- `src/emitter.ts`: element and attribute declarations, `fixed` and `default` values, and complex-type objects.
- `src/content-model.ts`: sequences, choices, `all` and group references as object properties and constraints.
- `src/definitions.ts`: `$defs` names and definitions, built in order of first use.
- `src/simple-types.ts`: simple-type restriction chains and merged facets.
- `src/numeric-facets.ts`: numeric bounds and exact alternatives for combined decimal digit constraints.
- `src/simple-values.ts`: lexical values and enumeration filtering.
- `src/decimal.ts`: decimal `multipleOf` arithmetic shared by enumeration checks and the test validator.
- `src/xsd-regex.ts`: XML Schema patterns translated to anchored JavaScript regular expressions using the `u` flag.
- `src/json-schema.ts`: types for the generated JSON Schema.
- `src/problems.ts`: problem codes and diagnostics, including source locations where available.
- `src/cli.ts` and `src/bin.ts`: CLI entry points. `bin.ts` calls `run()` from `cli.ts`; tests call `run()` directly.

`convert()` returns `{ schema, problems }`. Diagnostic codes and severity levels are documented under
[Problems](output.md#problems).

## Order example

Run `npm run example` to print the schema for [`examples/order`](../examples/order).

1. `SchemaSet.load('order.xsd')` follows the import of `common/common.xsd` and the include of `line.xsd`. It indexes
   the global components: `Order`, `c:Note`, `Line`, `c:Contact`, `c:Price`, the `Delivery` group, the `Tracking`
   attribute group and the simple types.
2. `order.xsd` declares only one global element, so `Order` is selected without a `root` option. The imported
   `c:Note` does not make that choice ambiguous because it belongs to `common.xsd`, not the entry document.
3. `Emitter.root()` writes `Order`'s anonymous complex type in place. `content()` passes its sequence to
   `ContentModel`, which walks the particles:
   - `Title` uses `c:Text40`. `typeRef()` asks `Definitions` for `{"$ref": "#/$defs/Text40"}`; the definition is built
     later.
   - `CustomerRef` has `minOccurs="0"`, so it isn't required.
   - The choice between `Pickup` and `Delivery` adds the properties of both branches and a `oneOf`. Each branch
     requires its own properties and rejects the other branch's properties.
   - The optional sequence of `DiscountCode` and `DiscountPercent` uses `dependentRequired` to keep them together.
   - `Line` becomes an array with `minItems: 1` and `maxItems: 5`.
   - `xs:any` in `Extensions` leaves that object open, without `additionalProperties: false`.
4. `complexType()` writes attributes first, then element properties and the content-model constraints. `version`
   gets its fixed value as `const`; `created` and `channel` come from the attribute group. Two choices in one object
   would produce an `allOf` containing two `oneOf` constraints.
5. `Definitions.buildAll()` emits referenced types in order of first use: the element types from `Text40` to `Line`,
   then `Channel`, then types reached through those definitions, such as `Email` and `Price`. `c:Price` restricts
   `c:Amount` by making `currency` required. It is emitted as one object; `Amount` isn't referenced and stays out.

The pickup/delivery choice produces this `oneOf` constraint:

```json
{
  "oneOf": [
    { "required": ["Pickup"], "properties": { "DeliveryDate": false, "DeliveryTime": false } },
    { "required": ["DeliveryDate"], "properties": { "Pickup": false } }
  ]
}
```

## Troubleshooting

1. Run the CLI and read the diagnostics on stderr:

   ```sh
   npm run build
   node dist/bin.js path/to/entry.xsd --root Order > out.json
   ```

   Look up the [problem code](output.md#problems), then find the reporting code with a search such as
   `grep -rn "'unknown-type'" src`.

2. Reduce the XSD to a standalone test case, following the examples in `src/convert.test.ts`.
3. Compare XML and JSON validation. Add the schema and a few documents to `src/differential.test.ts`, then run the
   relevant case, for example `npx vitest run src/differential.test.ts -t choices`. A disagreement shows both
   verdicts, the JSON representation and the Ajv errors.
4. Fix the responsible module and run `npm test`. If the order example changes, inspect the difference before
   running `UPDATE_EXAMPLES=1 npm test`, then review `git diff -- examples`.

libxml2 may accept elements declared with `maxOccurs="0"`. For such differences from the specification, add a unit
test in `src/convert.test.ts` and explain the expected result.

## Tests

Tests live beside the source (`src/*.test.ts`); shared helpers are in `src/test-support/`. Neither is included in
`dist/`.

| Test                             | What it covers                                                             |
| -------------------------------- | -------------------------------------------------------------------------- |
| `src/xsd-regex.test.ts`          | XML Schema pattern translation.                                            |
| `src/schema-set.test.ts`         | Document loading, paths, QNames and documentation.                         |
| `src/simple-types.test.ts`       | Built-in types, merged facets, enumerations and numeric bounds.            |
| `src/decimal.test.ts`            | Exact decimal multiples, exponent notation and invalid numeric inputs.     |
| `src/decimal-regression.test.ts` | Self-contained quantity, point-value and monetary digit-limit regressions. |
| `src/problems.test.ts`           | Every problem code is used and documented in `docs/output.md`.             |
| `src/convert.test.ts`            | The API, root selection, `$defs` names, options, values and diagnostics.   |
| `src/cli.test.ts`                | `convertFile` and the CLI, using files in a temporary directory.           |
| `src/index.test.ts`              | The main entry point has no Node.js built-in dependencies.                 |
| `src/differential.test.ts`       | Whether XML and JSON validation agree on the same documents.               |
| `src/example.test.ts`            | The order example and README excerpt match the converter.                  |

Each differential test pairs a small XSD with XML documents expected to pass or fail. Each document is checked in
both representations:

1. As XML, against the XSD, with libxml2 through [xmllint-wasm](https://www.npmjs.com/package/xmllint-wasm).
2. As JSON, against the generated schema, with [Ajv](https://ajv.js.org).

`src/test-support/xml-to-json.ts` maps the XML fixtures to JSON using the generated schema. This helper is test-only
and is not exported. The test validator uses the decimal `multipleOf` check in `src/decimal.ts`; see
`src/test-support/oracle.ts`.

The decimal regressions use inline XSDs and require no external schema files.

Both validators must agree with the expected result. Test cases must also account for the JSON
[representation limits](output.md#limits).

## Adding support for XSD features

1. Add a case to `src/differential.test.ts` with valid and invalid documents. Use a focused unit test when the case
   can't be checked reliably by the differential setup.
2. Implement the feature in the responsible module, usually `src/emitter.ts`, `src/content-model.ts` or
   `src/simple-types.ts`.
3. If the mapping is incomplete, report a problem. Add any new code to `PROBLEM_CODES` in `src/problems.ts` and
   explain it in [output.md](output.md#problems). `src/problems.test.ts` checks that codes are used and documented.
4. Document the mapping and its limits in [output.md](output.md).

## Pull requests

Run these checks before submitting a pull request. CI runs the same checks on Node.js 22.13 and 24:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

## Dependency updates

Dependabot opens weekly pull requests, configured in `.github/dependabot.yml`. Minor and patch development
updates are grouped, while major updates, `@xmldom/xmldom` updates and GitHub Actions have separate pull requests.

Review the release notes before merging. Major TypeScript, ESLint or Vitest updates may require configuration changes.

## Releases

The first release is pending. Publishing to npm is manual; CI does not publish releases.

1. Set the version in `package.json` and `package-lock.json`. Move the unreleased entries in
   [CHANGELOG.md](../CHANGELOG.md) under the release version and date.
2. Run the checks listed above and `npm pack --dry-run` to inspect the package contents. Documentation, contribution
   instructions and the order examples are included.
3. Configure npm authentication and confirm that the package name and version are available. Run
   `npm publish --access public`, then create the release tag.
