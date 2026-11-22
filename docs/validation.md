# Validating with Ajv

Use Ajv's Draft 2020-12 validator to validate JSON against the generated schema. The data must follow the
[JSON representation](output.md#json-representation).

## Ajv example

After the [quick start](../README.md#quick-start), save this example as `validate.mjs` in the checkout and run
`node validate.mjs`. It checks the bundled JSON order. A valid order exits successfully after the conversion warnings.
When using your own project, install `ajv` and `ajv-formats` with `npm install ajv ajv-formats` and change the two file
paths.

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
  throw new Error('Conversion failed. See the diagnostics above.');
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

- `Ajv2020` selects Draft 2020-12. `strictRequired: false` lets choice branches require fields declared on the enclosing
  object. Other strict checks stay enabled.
- `ownProperties: true` ensures an inherited name such as `constructor` cannot satisfy `required`. Build documents with
  `JSON.parse` or `Object.fromEntries` so `__proto__` can also be an ordinary own property. Ajv skips its value in
  `properties`. The generated schema uses `propertyNames` to check allowed keys and exclude that name from choice
  branches.
- Register `xml` as an annotation or omit it during conversion with `options: { xml: false }`. `ajv-formats` checks the
  formats emitted in [date/time format mode](values.md#dates-and-times).

Very deep schemas may exceed Ajv's stack during compilation. Examples include roughly 200 nested repeated choices or 250
unions that each restrict the next with their own facets. The threshold depends on the runtime.

## Decimal validation

Ajv's built-in `multipleOf` can reject `1.12` for a step of `0.01` because it divides binary floating-point numbers. The
example uses the package's `isMultipleOf(value, step)` to compare decimal coefficients exactly, including when
`totalDigits` and `fractionDigits` generate several scale alternatives. The check starts with a parsed JavaScript
number, so it cannot recover precision lost while reading JSON. See
[Decimal digit limits](values.md#decimal-digit-limits).
