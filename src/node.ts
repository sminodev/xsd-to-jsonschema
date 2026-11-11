import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { convert, type ConvertOptions, type ConvertResult } from './convert.js';
import { isAbsoluteUri, MAX_FILE_BYTES } from './schema-set.js';

export * from './index.js';

export interface ConvertFileOptions {
  /** The root element: `name`, `prefix:name` or `{namespace}name`. */
  root?: string | undefined;
  options?: ConvertOptions | undefined;
  /** The directory schemas may be read from. Default: the directory of the entry file. */
  baseDirectory?: string | undefined;
}

/**
 * Like `convert()`, but reads the entry document and everything it imports or includes from disk, relative to the
 * entry file. Neither a schema location nor a symbolic link can leave `baseDirectory`; URLs are not read and show up
 * as `missing-file`.
 */
export function convertFile(
  entryFile: string,
  { root, options, baseDirectory }: ConvertFileOptions = {},
): ConvertResult {
  const entry = resolve(entryFile);
  const given = resolve(baseDirectory ?? dirname(entry));
  const base = existsSync(given) ? realpathSync(given) : given;
  const inside = (file: string): boolean => {
    const part = relative(base, file);
    return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  const actualEntry = existsSync(entry) ? realpathSync(entry) : join(base, relative(given, entry));
  if (!inside(actualEntry)) {
    const message = `${entryFile} is outside the base directory`;
    return { schema: undefined, problems: [{ code: 'unsafe-input', severity: 'error', message, file: entryFile }] };
  }
  const read = (path: string): string | undefined => {
    if (isAbsoluteUri(path) || isAbsolute(path)) {
      throw new Error(
        'convertFile reads relative local paths only; pass a reader function to convert() to supply other documents',
      );
    }
    const candidate = resolve(base, ...path.split('/'));
    if (!inside(candidate)) {
      throw new Error('the schema path leaves the base directory');
    }
    if (!existsSync(candidate)) {
      return undefined;
    }
    const actual = realpathSync(candidate);
    if (!inside(actual)) {
      throw new Error('the symbolic link leaves the base directory');
    }
    if (statSync(actual).size > MAX_FILE_BYTES) {
      throw new Error('the schema exceeds the 2 MiB file limit');
    }
    return readFileSync(actual, 'utf8');
  };
  return convert({ files: read, entry: relative(base, actualEntry).split(sep).join('/'), root, options });
}
