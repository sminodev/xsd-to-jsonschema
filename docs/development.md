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

## XML Schema terms used in the code

You don't need to know the whole XML Schema specification to work on the converter, but the code uses its terms:

- **Schema document, schema set**: one `.xsd` file, and the entry document together with everything it imports
  (`xs:import`, another namespace) or includes (`xs:include`, the same namespace).
- **Global component**: a top-level `xs:element`, `xs:attribute`, `xs:complexType`, `xs:simpleType`, `xs:group` or
  `xs:attributeGroup`. Components are looked up by their expanded name, written `{namespace}name`.
- **QName**: a name with a prefix in an attribute value, such as `type="c:Text40"`. The prefix means whatever
  namespace the `xmlns:c` declarations in scope of that element say.
- **Qualified**: a local element or attribute that belongs to the target namespace (`elementFormDefault`,
  `attributeFormDefault` or `form`). It ends up in `xml.namespace`.
- **Simple type**: a value without child elements or attributes. Either built in (`xs:string`, `xs:decimal`, …) or
  derived from another simple type by a restriction.
- **Facet**: one rule of a restriction, such as `maxLength`, `pattern`, `enumeration` or `minInclusive`.
- **Restriction chain**: a simple type restricts another one, which restricts another one, down to a built-in type.
  A value has to meet the facets of every step.
- **Complex type**: the type of an element with attributes or child elements. With simple content it has text and
  attributes; with complex content it has child elements.
- **Particle**: one entry of a content model, with its `minOccurs` and `maxOccurs`: an element, a model group, a
  group reference or `xs:any`.
- **Model group**: `xs:sequence` (the particles in this order), `xs:choice` (exactly one of them) or `xs:all` (each
  once, in any order).

One term is the converter's own:

- **Fragment**: what a model group contributes to the object it ends up in: its properties in document order, the
  ones it requires, and one `oneOf` per choice. See `src/content-model.ts`.

## How the converter works

`convert()` loads the schema documents, finds the root element and hands it to the emitter, which writes the
schema:

```text
convert ──► SchemaSet.load(entry) ──► find the root element ──► Emitter.root(element) ──► { schema, problems }
              imports, includes          root option or the       declarations, objects,
              global components          only global element      content models, $defs
```

Each module has one job:

- `src/index.ts`: the main entry point, `convert()` and the types. It uses no Node.js built-ins, so it runs in
  browsers too.
- `src/node.ts`: the entry point `xsd-to-jsonschema/node`, everything from `index.ts` plus `convertFile()`.
- `src/convert.ts`: the options, and picking the root element.
- `src/schema-set.ts`: parses the documents, follows imports and includes relative to the importing file, looks up
  global components and resolves QNames.
- `src/emitter.ts`: writes the JSON Schema: element and attribute declarations, `fixed` and `default`, and the
  objects of complex types.
- `src/content-model.ts`: turns sequences, choices, `all` and group references into the properties and constraints
  of one object.
- `src/definitions.ts`: names the entries in `$defs` and builds them in the order of first use.
- `src/simple-types.ts`: walks a simple type down its restriction chain and merges the facets into one schema.
- `src/xsd-regex.ts`: translates XML Schema patterns into anchored JavaScript patterns for the `u` flag.
- `src/json-schema.ts`: the types of the JSON Schema the converter writes.
- `src/problems.ts`: the list of problem codes, and collecting the problems with code, file and line.
- `src/cli.ts`, `src/bin.ts`: the command line. `bin.ts` only calls `run()` from `cli.ts`, which the tests call
  directly.

If something has no JSON Schema equivalent, the converter writes the closest schema it can and reports a problem
([list of codes](output.md#problems)). It never stops at the first problem.

## A walk through the order example

[`examples/order`](../examples/order) is a good way to see the modules work together. `npm run example` prints the
result.

1. `SchemaSet.load('order.xsd')` reads `order.xsd`, follows its import of `common/common.xsd` and its include of
   `line.xsd`, and indexes the global components of all three: the elements `Order` and `c:Note`, the complex types
   `Line`, `c:Contact` and `c:Price`, the group `Delivery`, the attribute group `Tracking`, the simple types and so on.
2. `order.xsd` declares one global element, so `Order` is the root without a `root` option. (`c:Note` belongs to
   `common.xsd`.)
3. `Emitter.root()` sees that `Order` has an anonymous complex type and writes its object in place. `content()` hands
   the `xs:sequence` to `ContentModel`, which goes through the particles one by one:
   - `Title` has the named type `c:Text40`. `typeRef()` asks `Definitions` for a reference and gets
     `{"$ref": "#/$defs/Text40"}`; the definition itself is built later.
   - `CustomerRef` has `minOccurs="0"`, so it becomes a property that isn't required.
   - The `xs:choice` between `Pickup` and the group `Delivery` (`DeliveryDate`, `DeliveryTime`) turns into a fragment
     with all three properties and one `oneOf`. Each branch requires its own properties and sets the others to
     `false`:

     ```json
     "oneOf": [
       { "required": ["Pickup"], "properties": { "DeliveryDate": false, "DeliveryTime": false } },
       { "required": ["DeliveryDate"], "properties": { "Pickup": false } }
     ]
     ```

   - The optional sequence of `DiscountCode` and `DiscountPercent` adds two optional properties and a
     `dependentRequired` that ties them together.
   - `Line` has `maxOccurs="5"`, so it becomes an array with `minItems` 1 and `maxItems` 5.
   - `xs:any` inside `Extensions` marks that fragment as open, so its object gets no `additionalProperties: false`.

4. `complexType()` writes the object: the attributes first (`version`, whose `fixed` value becomes `const`, then
   `created` and `channel` from the attribute group), then the properties of the fragment in document order,
   `required`, `additionalProperties: false`, `dependentRequired` and the `oneOf`. With two choices in one object it
   would write an `allOf` of two `oneOf`s.
5. `Definitions.buildAll()` builds the referenced types in the order they were first used: the element types from
   `Text40` to `Line`, then `Channel`, which only an attribute uses, and then the types that the definitions refer to,
   such as `Email` from `Contact` and `Price` from `Line`. `c:Price` restricts `c:Amount` and only makes `currency`
   required, so it is written as one object; `Amount` itself is never referenced and stays out.

## Finding out why a schema looks wrong

1. Run the command line on the schema and read stderr first. Every problem has its code, file and line:

   ```sh
   npm run build
   node dist/bin.js path/to/entry.xsd --root Order > out.json
   ```

   [output.md](output.md#problems) explains the codes, and `grep -rn "'unknown-type'" src` shows where one is
   reported.

2. Make the case small. Copy the type in question into a short schema, the way the tests in `src/convert.test.ts`
   do, and cut it down until a few lines still show the problem.
3. Let libxml2 decide what the XML Schema allows. Put the small schema and a few documents into a case in
   `src/differential.test.ts` and run only that test, for example `npx vitest run src/differential.test.ts -t choices`.
   When the validators disagree, the failure shows both verdicts, the JSON form of each document and the Ajv errors,
   which usually point at the property that's off.
4. Fix it in the module that does the job (see the list above) and run `npm test`. If `src/example.test.ts` fails
   too, your change affects `examples/order`: check that the difference is what you meant, then run
   `UPDATE_EXAMPLES=1 npm test` and review `git diff examples`.

libxml2 isn't always right. It accepts an element with `maxOccurs="0"`, for example, which XML Schema forbids. When
the specification is clear and libxml2 disagrees, test the case in `src/convert.test.ts` and say why in a comment.

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
   the XML into JSON using nothing but the generated schema. Ajv checks `multipleOf` on the decimal form of a number
   there, since its own check divides binary floating point numbers and gets 1.12 / 0.01 wrong.

Both validators have to agree. They can't agree on the order of elements or on details of the XML text such as
leading zeros, so the cases stay away from those.

## Adding support for another XML Schema feature

1. Add a case to `src/differential.test.ts` with documents the XML Schema accepts and documents it rejects.
2. Implement the feature, usually in `src/emitter.ts`, `src/content-model.ts` or `src/simple-types.ts`.
3. If JSON Schema can only express part of it, report a problem with a new code. Add the code to `PROBLEM_CODES` in
   `src/problems.ts` and explain it in [output.md](output.md#problems); `src/problems.test.ts` checks both.
4. Describe the output in [output.md](output.md). The changelog is written from the commit messages, so give a
   change that users notice a `feat:` or `fix:` message.

## Pull requests

Keep a pull request to one change, with a test that fails without it: a differential case if libxml2 can judge it,
otherwise a case in the unit tests. CI runs `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build` and `npm test` on Node.js 22.12 and 24; run them before you push. If the output changes, update
[output.md](output.md) in the same pull request.

## Keeping dependencies up to date

On GitHub, Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml)) opens pull requests once a week: one
for the minor and patch updates of the development dependencies, and one for each major update, each update of
`@xmldom/xmldom` and each GitHub Action. CI runs the full check on every one of them, so merge when it's green. A
major update of TypeScript, ESLint or Vitest can need a change to the configuration; the release notes of the
package say what changed.
