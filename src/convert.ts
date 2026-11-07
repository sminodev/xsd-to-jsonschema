import { Emitter, type EmitterOptions } from './emitter.js';
import type { JsonSchema } from './json-schema.js';
import { type Problem, Problems } from './problems.js';
import { clark, type Component, type SchemaDocument, SchemaSet, type SchemaSource } from './schema-set.js';

export interface ConvertOptions {
  /**
   * `format` writes xs:date, xs:dateTime, xs:time and xs:duration as JSON Schema `format` (RFC 3339, which needs a
   * time zone in date-times); `pattern` writes the XML Schema format, where the time zone is optional.
   * Default: `format`.
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
}

export interface ConvertResult {
  /** undefined if the entry could not be read or no root element was found */
  schema: JsonSchema | undefined;
  problems: Problem[];
}

/** Converts the XML Schema of one root element into a JSON Schema 2020-12 document. */
export function convert({ files, entry, root, options = {} }: ConvertInput): ConvertResult {
  const settings: EmitterOptions = {
    dateTime: options.dateTime ?? 'format',
    xml: options.xml ?? true,
    textProperty: options.textProperty ?? 'value',
  };
  if (settings.dateTime !== 'format' && settings.dateTime !== 'pattern') {
    throw new TypeError(`options.dateTime must be "format" or "pattern", not ${String(settings.dateTime)}`);
  }
  if (typeof settings.textProperty !== 'string' || settings.textProperty === '') {
    throw new TypeError('options.textProperty must be a non-empty string');
  }
  const problems = new Problems();
  const set = new SchemaSet(files, problems);
  const doc = set.load(entry);
  const element = doc && findRoot(set, doc, root, problems);
  if (!element) {
    return { schema: undefined, problems: problems.list };
  }
  const schema = new Emitter(set, problems, settings).root(element);
  return { schema, problems: problems.list };
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
      problems.error(
        'root-required',
        `${doc.path} declares ${candidates.length} global elements; choose one with root: ${candidates.join(', ')}`,
        { file: doc.path },
      );
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
