import { type ConvertInput, run } from './convert.js';
import type { JsonSchema } from './json-schema.js';
import type { Problem } from './problems.js';
import { ObjectRecorder, type Structure, StructureBuilder, StructureLimitExceeded } from './structure.js';

export interface DescribeSchemaResult {
  /**
   * the same schema `convert()` writes for the same input, as long as the structure report fits `maxStructureSize`;
   * undefined when it doesn't
   */
  schema: JsonSchema | undefined;
  /**
   * the same problems `convert()` reports; when the structure report exceeds `maxStructureSize`, also a
   * `resource-limit` that names the limit and its value
   */
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
    try {
      structure = builder.build(root);
    } catch (e) {
      // Above the limit, or where the report nests deeper than the stack reaches, there is neither a schema nor a
      // report, as for the other limits and as in convert(): no cut-off report.
      if (!(e instanceof StructureLimitExceeded) && !(e instanceof RangeError)) {
        throw e;
      }
      const message =
        e instanceof StructureLimitExceeded ? e.message : 'the schema nests deeper than the converter can follow';
      problems.error('resource-limit', message, { file: root.doc.path });
      return { schema: undefined, problems: problems.list, structure: undefined };
    }
  }
  return { schema, problems: problems.list, structure };
}
