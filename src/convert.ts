import type { Recorder } from './content-model.js';
import { Emitter, type EmitterOptions, OutputLimitExceeded } from './emitter.js';
import { NAME_CHAR, NAME_START } from './name-chars.js';
import type { JsonSchema } from './json-schema.js';
import { type Problem, Problems } from './problems.js';
import { clark, type Component, type Limits, type SchemaDocument, SchemaSet, type SchemaSource } from './schema-set.js';

export interface ConvertOptions {
  /**
   * `pattern` writes xs:date, xs:dateTime, xs:time and xs:duration as a pattern of the XML Schema format, where the
   * time zone is optional; `format` writes JSON Schema `format` (RFC 3339, which needs a time zone in date-times).
   * Default: `pattern`.
   */
  dateTime?: 'format' | 'pattern' | undefined;
  /** Add the `xml` annotations (namespace, attribute, text). Default: true. */
  xml?: boolean | undefined;
  /** The property that holds the text of an element with simple content. Default: `value`. */
  textProperty?: string | undefined;
}

export interface ConvertInput {
  /** The schema texts by path, or a function that reads them. Imports and includes are resolved relative to the
   * path of the importing document. */
  files: SchemaSource;
  /** Path of the document that declares the root element. */
  entry: string;
  /**
   * The root element: `name`, `prefix:name` (with a prefix of the entry document) or `{namespace}name`. May be left
   * out if the entry declares only one global element.
   */
  root?: string | undefined;
  options?: ConvertOptions | undefined;
  /**
   * Size limits of the schema set, each a positive safe integer: `maxFileBytes` per document (default 4194304),
   * `maxTotalBytes` for all documents (default 16777216) and `maxDocuments` (default 128). Bytes count as UTF-8
   * before parsing; a document loaded again for another namespace (chameleon include) counts again.
   * `maxOutputEntries` (default 200000) limits the output entries of the schema written: each key of a `properties`
   * map and each branch of an `anyOf` or `oneOf`, wherever it is written. `maxStructureSize` (default 20000000)
   * limits the structure report of `describeSchema()` and is not used here.
   */
  limits?: Limits | undefined;
}

export interface ConvertResult {
  /** undefined if the entry could not be read or no root element was found */
  schema: JsonSchema | undefined;
  problems: Problem[];
}

// An NCName: a Name of XML 1.0, Second Edition, without a colon.
const NCNAME = new RegExp(`^(?!.*:)[${NAME_START}][${NAME_CHAR}]*$`, 'u');

/** Whether a name may be the text property: an NCName other than `__proto__`, or exactly `#text`. */
export function isTextProperty(name: string): boolean {
  return name === '#text' || (name !== '__proto__' && NCNAME.test(name));
}

/** Converts the XML Schema of one root element into a JSON Schema 2020-12 document. */
export function convert(input: ConvertInput): ConvertResult {
  return convertSchemas(input);
}

/**
 * `convert`, for readers that know the size of each document in its file (`convertFile`).
 *
 * @param sizeOf - the bytes of a document in its file, which the size limits count
 */
export function convertSchemas(input: ConvertInput, sizeOf?: (path: string) => number | undefined): ConvertResult {
  const { schema, problems } = run(input, sizeOf);
  return { schema, problems: problems.list };
}

/** A conversion with what `describeSchema` reads next to the schema. */
export interface Conversion {
  schema: JsonSchema | undefined;
  problems: Problems;
  set?: SchemaSet;
  root?: Component;
  emitter?: Emitter;
  settings: EmitterOptions;
}

/**
 * Converts the schema of one root element.
 *
 * @param recorder - learns the final property names of each object written; leaves the result as it is
 */
export function run(
  { files, entry, root, options = {}, limits }: ConvertInput,
  sizeOf?: (path: string) => number | undefined,
  recorder?: Recorder,
): Conversion {
  const settings: EmitterOptions = {
    dateTime: options.dateTime ?? 'pattern',
    xml: options.xml ?? true,
    textProperty: options.textProperty ?? 'value',
  };
  if (settings.dateTime !== 'format' && settings.dateTime !== 'pattern') {
    throw new TypeError(`options.dateTime must be "format" or "pattern", not ${String(settings.dateTime)}`);
  }
  // An NCName, never one of the other kinds of keys ({ns}local, @local, #type, group keys), or exactly #text.
  if (typeof settings.textProperty !== 'string' || !isTextProperty(settings.textProperty)) {
    throw new TypeError('options.textProperty must be an NCName other than __proto__, or #text');
  }
  const problems = new Problems();
  const set = new SchemaSet(files, problems, limits, sizeOf);
  const doc = set.load(entry);
  const element = doc && findRoot(set, doc, root, problems);
  if (!element || set.blocked) {
    return { schema: undefined, problems, settings };
  }
  const emitter = new Emitter(set, problems, settings, recorder);
  let schema: JsonSchema;
  try {
    schema = emitter.root(element);
  } catch (e) {
    // A schema above maxOutputEntries, or one that nests deeper than the converter's stack reaches, gives no schema
    // rather than an exception.
    if (e instanceof OutputLimitExceeded) {
      problems.error('resource-limit', e.message, { file: doc.path });
      return { schema: undefined, problems, settings };
    }
    if (!(e instanceof RangeError)) {
      throw e;
    }
    problems.error('resource-limit', 'the schema nests deeper than the converter can follow', { file: doc.path });
    return { schema: undefined, problems, settings };
  }
  return { schema, problems, set, root: element, emitter, settings };
}

/** The global elements a document declares, as `{namespace}name`. */
function globalElements(set: SchemaSet, doc: SchemaDocument): string[] {
  return [...set.components.element].filter(([, found]) => found.doc === doc).map(([id]) => id);
}

function findRoot(
  set: SchemaSet,
  doc: SchemaDocument,
  root: string | undefined,
  problems: Problems,
): Component | undefined {
  const candidates = globalElements(set, doc);
  let id: string;
  if (root === undefined) {
    if (candidates.length !== 1 || candidates[0] === undefined) {
      const message =
        candidates.length === 0
          ? `${doc.path} declares no global element; choose the document that declares the root element as entry`
          : `${doc.path} declares ${candidates.length} global elements; choose one with root: ${candidates.join(', ')}`;
      problems.error('root-required', message, { file: doc.path });
      return undefined;
    }
    id = candidates[0];
  } else if (root.startsWith('{')) {
    id = root;
  } else if (root.includes(':')) {
    const name = set.resolveQName(doc.root, root);
    id = clark(name.ns, name.local);
  } else {
    id = clark(doc.targetNamespace, root);
  }
  const found = set.components.element.get(id);
  if (!found) {
    problems.error('unknown-root', `no global element ${root}; candidates: ${candidates.join(', ')}`, {
      file: doc.path,
    });
    return undefined;
  }
  return found;
}
