import { type ConvertInput, run } from './convert.js';
import type { JsonSchema } from './json-schema.js';
import type { Problem } from './problems.js';
import { ObjectRecorder, type Structure, StructureBuilder } from './structure.js';

export interface DescribeSchemaResult {
  /** the same schema `convert()` writes for the same input */
  schema: JsonSchema | undefined;
  /** the same problems `convert()` reports */
  problems: Problem[];
  /** undefined when there is no schema */
  structure: Structure | undefined;
}

/**
 * Converts like `convert()` and also reports the structure of the XML Schema: particles in order with their
 * compositors, wildcards, identity constraints and raw facets, each node with the place of its property in the
 * schema. See docs/structure.md.
 */
export function describeSchema(input: ConvertInput): DescribeSchemaResult {
  return describeWithSizes(input);
}

/**
 * `describeSchema`, for readers that know the size of each document in its file (`describeSchemaFile`).
 *
 * @param sizeOf - the bytes of a document in its file, which the size limits count
 */
export function describeWithSizes(
  input: ConvertInput,
  sizeOf?: (path: string) => number | undefined,
): DescribeSchemaResult {
  const recorder = new ObjectRecorder();
  const conversion = run(input, sizeOf, recorder);
  const { schema, problems, set, root, emitter, settings } = conversion;
  let structure: Structure | undefined;
  if (schema && set && root && emitter) {
    const builder = new StructureBuilder(
      set,
      problems,
      recorder,
      (kind, id) => emitter.definitionName(kind, id),
      settings.textProperty,
    );
    structure = builder.build(root);
  }
  return { schema, problems: problems.list, structure };
}
