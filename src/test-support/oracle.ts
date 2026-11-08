// Validates every XML document twice: against the XML Schema with libxml2 (WebAssembly), and mapped to JSON against
// the JSON Schema that convert() writes, with Ajv. The two validators have to agree.

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateXML } from 'xmllint-wasm';
import { convert, type ConvertOptions } from '../convert.js';
import { isMultipleOf } from '../decimal.js';
import type { JsonSchema } from '../json-schema.js';
import type { Problem } from '../problems.js';
import { xmlToJson } from './xml-to-json.js';

export { isMultipleOf } from '../decimal.js';

export function ajvFor(schema: JsonSchema): ValidateFunction {
  // strictRequired would want each choice branch to define the properties it requires once more.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // ajv-formats is CommonJS: the default import is module.exports, which carries the plugin as `default` too.
  addFormats.default(ajv);
  ajv.addKeyword('xml');
  // Ajv divides binary floating point numbers, so 1.12 is no multiple of 0.01 for it. JSON numbers are decimal;
  // check them the way the specification means it.
  ajv.removeKeyword('multipleOf');
  ajv.addKeyword({
    keyword: 'multipleOf',
    type: 'number',
    schemaType: 'number',
    validate: (step: number, value: number) => isMultipleOf(value, step),
  });
  return ajv.compile(schema);
}

export interface Verdict {
  name: string;
  /** valid against the XML Schema */
  xsd: boolean;
  /** the JSON form is valid against the generated schema */
  json: boolean;
  agree: boolean;
  xsdErrors: string[];
  jsonErrors: ErrorObject[];
  value: unknown;
}

export interface Comparison {
  schema: JsonSchema;
  problems: Problem[];
  verdicts: Verdict[];
}

export async function compare(input: {
  files: Record<string, string>;
  entry: string;
  root?: string;
  options?: ConvertOptions;
  instances: Record<string, string>;
}): Promise<Comparison> {
  const { files, entry, instances } = input;
  const { schema, problems } = convert({ files, entry, root: input.root, options: input.options });
  if (!schema) {
    throw new Error(`no schema: ${JSON.stringify(problems)}`);
  }
  const validate = ajvFor(schema);
  const names = Object.keys(instances);
  const result = await validateXML({
    xml: names.map((name) => ({ fileName: `${name}.xml`, contents: instances[name] ?? '' })),
    schema: [{ fileName: entry, contents: files[entry] ?? '' }],
    preload: Object.entries(files)
      .filter(([path]) => path !== entry)
      .map(([fileName, contents]) => ({ fileName, contents })),
  });
  if (/failed to compile|Schemas parser error/.test(result.rawOutput)) {
    throw new Error(`the XML Schema does not compile: ${result.rawOutput}`);
  }
  const verdicts = names.map((name): Verdict => {
    const fileName = `${name}.xml`;
    const xsdErrors = result.errors
      .filter((e) => e.rawMessage.startsWith(fileName) && !/fails to validate$/.test(e.rawMessage.trim()))
      .map((e) => e.message);
    const value = xmlToJson(schema, instances[name] ?? '');
    const json = validate(value);
    return {
      name,
      xsd: xsdErrors.length === 0,
      json,
      agree: json === (xsdErrors.length === 0),
      xsdErrors,
      jsonErrors: validate.errors ?? [],
      value,
    };
  });
  return { schema, problems, verdicts };
}

/** The documents where the two validators disagree, readable in a test failure. */
export function disagreements(verdicts: Verdict[]): string[] {
  return verdicts
    .filter((v) => !v.agree)
    .map(
      (v) =>
        `${v.name}: XSD ${v.xsd ? 'valid' : 'invalid'} ${JSON.stringify(v.xsdErrors)}, ` +
        `JSON ${v.json ? 'valid' : 'invalid'} ${JSON.stringify(v.value)} ` +
        JSON.stringify(v.jsonErrors.map((e) => `${e.instancePath} ${e.message}`)),
    );
}
