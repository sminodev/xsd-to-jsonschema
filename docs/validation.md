# Validating with Ajv

Use Ajv's Draft 2020-12 validator to validate JSON against the generated schema. The data must follow the
[JSON representation](output.md#json-representation).

## Ajv example

Install Ajv and its format plugin:

```sh
npm install ajv ajv-formats
```

Both packages are already development dependencies in the repository. After `npm ci` and `npm run build`, save
the example as `validate.mjs` in the repository root and run `node validate.mjs`. If using an installed package
instead, replace the example paths with your own XSD and JSON files.

```js
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isMultipleOf } from 'xsd-to-jsonschema';
import { convertFile } from 'xsd-to-jsonschema/node';

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, ownProperties: true });
addFormats(ajv);
ajv.addKeyword('xml');
ajv.removeKeyword('multipleOf');
ajv.addKeyword({
  keyword: 'multipleOf',
  type: 'number',
  schemaType: 'number',
  validate: (step, value) => isMultipleOf(value, step),
});

const { schema, problems } = convertFile('examples/order/order.xsd');
for (const problem of problems) {
  console.error(problem);
}
if (!schema || problems.some((problem) => problem.severity === 'error')) {
  throw new Error('Conversion failed; see the diagnostics above.');
}

const validate = ajv.compile(schema);
const document = JSON.parse(readFileSync('examples/order/order.json', 'utf8'));
if (!validate(document)) {
  console.error(validate.errors);
  process.exitCode = 1;
}
```

Conversion warnings are printed but do not stop validation. To reject warnings too, replace `problems.some(...)` with
`problems.length > 0`.

## Configuration

`Ajv2020` selects Draft 2020-12. The setting `strictRequired: false` allows choice branches to require properties
declared in the enclosing object while leaving other strict checks enabled.

`ownProperties: true` makes Ajv look at the own properties of a JSON object only. XML names such as `constructor` or
`toString` are ordinary property names; without the setting, Ajv takes the inherited `constructor` of every object for
a property that is present, and `required` passes although the document has no such element. Build JSON objects with
`JSON.parse`, `Object.fromEntries` or `Object.defineProperty`, so that a name such as `__proto__` is an own property
too. Ajv leaves a property named `__proto__` out of `properties`: it doesn't check its value. So that Ajv doesn't take
it for an additional property, an object with such a property is closed with `propertyNames` instead of
`additionalProperties: false`.

Because `xml` is metadata rather than a validation keyword, register it as an annotation, as above, or set
`options.xml: false` during conversion.

The converter writes the branches of unions flat, so Ajv with its default settings compiles long chains of unions
quickly. A chain of more than about 250 unions that each restrict the next with their own facets still refers from
definition to definition, deeper than Ajv's stack allows; Ajv then throws a `RangeError` while compiling. The same
happens with repeated choices (`maxOccurs` greater than 1) nested about 200 deep, each an array of objects inside the
next.

`ajv-formats` validates formats emitted with `dateTime: 'format'`. For the difference from the default `pattern`
mode, see [Dates and times](output.md#dates-and-times).

## Decimal validation

The custom `multipleOf` keyword uses `isMultipleOf` from the package, which compares decimal coefficients with `BigInt`
instead of dividing binary floating-point numbers. Without it, stock Ajv can reject valid values such as `1.12` for
`multipleOf: 0.01`. `multipleOfPrecision` can help particular values but isn't an exact replacement. The same issue
affects the `anyOf` branches generated for combined `totalDigits` and `fractionDigits`.

Because the check starts from the decimal representation of an already parsed JavaScript number, it remains subject
to the converter's [numeric precision limits](output.md#limits).
