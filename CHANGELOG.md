# Changelog

## Unreleased

The first version.

- `convert()` writes a JSON Schema 2020-12 for one root element of an XML Schema; `convertFile()` from
  `xsd-to-jsonschema/node` does the same with files on disk, and so does the `xsd-to-jsonschema` command.
  [docs/output.md](docs/output.md) describes what they write.
- Choices become exclusive `oneOf` branches, objects are closed, derived types are merged with their base, and
  patterns are translated to JavaScript.
- Every problem has a code from a fixed list, exported as the type `ProblemCode` and explained in
  [docs/output.md](docs/output.md#problems).
- An ES module for Node.js 22.12 or later; the main entry point runs in browsers too. The only runtime dependency is
  `@xmldom/xmldom`.
- `examples/order`, an order schema split over three files.
- Tests that validate the same documents as XML against the XML Schema (libxml2) and as JSON against the generated
  schema (Ajv), and expect both to agree.
