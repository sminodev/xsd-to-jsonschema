# Development

Use Node.js 24 for a checkout. CI also runs the development checks on 22.13.0 and 26. Run the order example from the
repository root.

```sh
npm ci
npm run example
```

`npm run example` builds the project and prints the schema for
[`examples/order/order.xsd`](../examples/order/order.xsd). The [quick start](../README.md#quick-start) shows the
corresponding XML and JSON.

## Where to change a mapping

`convert()` loads the entry XSD and its dependencies, selects a global element and emits its schema. The source files
below follow those stages.

| If the issue involves…                         | Start in `src/`                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File access, imports, prefixes or encodings    | `node.ts` reads files. `schema-set.ts` resolves documents and names. `encoding.ts` and `doctype.ts` check input before parsing.                                                                   |
| Root selection and public APIs                 | `convert.ts` selects the root. `index.ts` exports the browser API, and `node.ts` adds the file APIs.                                                                                              |
| Missing properties, wrong names or cardinality | `emitter.ts` builds objects. `keys.ts` assigns names. `content-model.ts` handles groups and occurrence counts, with `relax.ts` for overlapping branches.                                          |
| A wrong `$ref`, wildcard or type alternative   | `definitions.ts` builds referenced types. `attribute-wildcard.ts` combines wildcards. `polymorphism.ts` resolves substitution groups and type alternatives.                                       |
| A value accepted or rejected incorrectly       | `simple-types.ts` maps types and facets. `simple-values.ts` and `value-forms.ts` handle equivalent values, `numeric-facets.ts` and `decimal.ts` numeric constraints, and `xsd-regex.ts` patterns. |
| The structure report                           | `describe.ts` and `structure.ts` build the report. `value-facets.ts` records effective facets.                                                                                                    |

### Follow a choice through the order example

The entry file imports `common/common.xsd` and includes `line.xsd`. Its only global element is `Order`. In its delivery
choice, either `Pickup` or `DeliveryDate` must be present. `DeliveryTime` belongs to the delivery branch. You can see
both rules in `allOf[0]` of the generated schema.

```json
{
  "oneOf": [{ "required": ["Pickup"] }, { "required": ["DeliveryDate"] }],
  "dependentRequired": { "DeliveryTime": ["DeliveryDate"] }
}
```

Compare the [entry XSD](../examples/order/order.xsd) with the [generated schema](../examples/order/order.schema.json).
`src/example.test.ts` checks this excerpt and the complete example against the converter.

## Tests

For a mapping change, reduce the XSD to a small case with one valid and one invalid document. Choose a test that
exercises the behavior through its public interface.

- In `src/differential.test.ts`, libxml2 validates the XML and Ajv validates the corresponding JSON. The helper in
  `src/test-support/xml-to-json.ts` builds JSON for these tests. Add a hand-written JSON case when its exact shape
  matters. If libxml2 disagrees with XSD 1.0, use a focused test for the rule.
- In `src/test-support/contract/`, pair `valid*.xml` with its exact `valid*.json`. Use `invalid-*.xml` for invalid
  documents or `mapping-error-*.xml` for valid XML the mapping must reject. Register the case in `src/contract.test.ts`.
- For API behavior, CLI diagnostics or report pointers, add a case beside the relevant module. Document new problem
  codes in the [diagnostics reference](diagnostics.md#problems) and add them to `PROBLEM_CODES` in `src/problems.ts`.

Run a single suite with `npx vitest run src/differential.test.ts`. If a mapping change affects the order example,
regenerate it with `UPDATE_EXAMPLES=1 npm test` and inspect `git diff -- examples`.

## Pull requests

```sh
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

Use `npm run coverage` for coverage. To check elapsed-time budgets, run
`CHECK_PERFORMANCE=1 npm test -- --no-file-parallelism` on an idle machine without coverage. CI also installs the
tarball in a fresh project and checks the public APIs and both CLI names on Node.js 22.12.0.

## Releases

1. Date the release entry in the [changelog](../CHANGELOG.md) and check that its version matches `package.json` and
   `package-lock.json`.
2. Run the pull request checks, inspect `npm pack --dry-run` and confirm the package-consumer CI job passes on the
   release commit.
3. Confirm npm authentication and name/version availability. Publish with `npm publish --access public`, then tag the
   release.
