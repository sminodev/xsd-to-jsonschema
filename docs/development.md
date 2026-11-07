# Development

You need Node.js 22.12 or later. The library is written in TypeScript and compiled with `tsc`; its only runtime
dependency is `@xmldom/xmldom`.

```sh
npm ci
npm run build                # compiles src/ to dist/
npm test                     # runs all tests with Vitest
npm run coverage             # the same, with coverage
npm run lint                 # ESLint
npm run typecheck            # tsc without output, tests included
npm run format               # Prettier
npm run example              # builds and prints the schema for examples/order
UPDATE_EXAMPLES=1 npm test   # updates examples/order/order.schema.json and order.json
```

## How the converter works

`convert()` loads the schema documents, finds the root element and hands it to the emitter, which writes the
schema:

```text
convert ──► SchemaSet.load(entry) ──► find the root element ──► Emitter.root(element) ──► { schema, problems }
              imports, includes          root option or the       declarations, objects,
              global components          only global element      content models, $defs
```

Each module has one job:

| Module                     | What it does                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`             | the main entry point: `convert()` and the types; no Node.js built-ins, so it runs in browsers too                                                                                               |
| `src/node.ts`              | the entry point `xsd-to-jsonschema/node`: everything from `index.ts`, plus `convertFile()`                                                                                                      |
| `src/convert.ts`           | options and picking the root element                                                                                                                                                            |
| `src/schema-set.ts`        | parses the documents, follows `xs:import` and `xs:include` relative to the importing file, and looks up global components by `{namespace}name`, resolving prefixes with the namespaces in scope |
| `src/simple-types.ts`      | walks a simple type down to its built-in type and merges the facets of every restriction step on the way                                                                                        |
| `src/xsd-regex.ts`         | translates XML Schema patterns into anchored JavaScript patterns for the `u` flag                                                                                                               |
| `src/emitter.ts`           | writes the JSON Schema: element and attribute declarations, `fixed` and `default`, and the objects of complex types                                                                             |
| `src/content-model.ts`     | turns sequences, choices, `all` and group references into the properties and constraints of one object                                                                                          |
| `src/definitions.ts`       | names the entries in `$defs` and builds them in the order of first use                                                                                                                          |
| `src/json-schema.ts`       | the types of the JSON Schema it writes                                                                                                                                                          |
| `src/problems.ts`          | the list of problem codes, and collecting the problems with code, severity, file and line                                                                                                       |
| `src/cli.ts`, `src/bin.ts` | the command line; `bin.ts` only calls `run()` from `cli.ts`, which the tests call directly                                                                                                      |

A few things about the emitter are worth knowing before you change it:

- A named type gets its `$defs` name the first time it is referenced, and its definition is written after the one
  the emitter is working on. That keeps the definitions in the order of first use and makes recursive types work.
- A content model is turned into a fragment: its properties in document order, the properties it requires, and one
  `oneOf` per choice. A sequence merges the fragments of its parts. A choice turns the fragments of its branches into
  one `oneOf` and keeps all their properties in the enclosing object.
- If something has no JSON Schema equivalent, the emitter writes the closest schema it can and reports a problem
  ([list of codes](output.md#problems)).

## Tests

The tests sit next to the code (`src/*.test.ts`); the helpers they share are in `src/test-support/`. Neither ends up
in `dist/`.

| Test                       | What it covers                                                                 |
| -------------------------- | ------------------------------------------------------------------------------ |
| `src/xsd-regex.test.ts`    | translating XML Schema patterns                                                |
| `src/schema-set.test.ts`   | loading documents, paths, QNames and documentation                             |
| `src/simple-types.test.ts` | built-in types, merged facets, enumerations and number bounds                  |
| `src/problems.test.ts`     | that docs/output.md explains every problem code, and that each one is used     |
| `src/convert.test.ts`      | the API, choosing the root, `$defs` names, options, values and problems        |
| `src/cli.test.ts`          | `convertFile` and the command line, on files in a temporary directory          |
| `src/index.test.ts`        | that the main entry point needs no Node.js built-ins                           |
| `src/differential.test.ts` | whether the XML Schema and the generated JSON Schema accept the same documents |
| `src/example.test.ts`      | whether `examples/order` and the excerpt in the README match the converter     |

The differential tests matter most. Each case pairs a small XML Schema with XML documents that should pass or fail,
and says which is which. Every document is then validated twice:

1. as XML, against the XML Schema, with libxml2 ([xmllint-wasm](https://www.npmjs.com/package/xmllint-wasm));
2. as JSON, against the generated schema, with [Ajv](https://ajv.js.org). `src/test-support/xml-to-json.ts` turns
   the XML into JSON using nothing but the generated schema.

Both validators have to agree. They can't agree on the order of elements or on details of the XML text such as
leading zeros, so the cases stay away from those.

## Adding support for another XML Schema feature

1. Add a case to `src/differential.test.ts` with documents the XML Schema accepts and documents it rejects.
2. Implement the feature, usually in `src/emitter.ts` or `src/simple-types.ts`.
3. If JSON Schema can only express part of it, report a problem with a new code. Add the code to `PROBLEM_CODES` in
   `src/problems.ts` and explain it in [output.md](output.md#problems); `src/problems.test.ts` checks both.
4. Describe the output in [output.md](output.md) and add a line to the changelog.
