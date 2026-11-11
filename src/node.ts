import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ConvertOptions, type ConvertResult, convertSchemas } from './convert.js';
import { decodeSchema } from './encoding.js';
import { effectiveLimits, FileTooLarge, isAbsoluteUri, type Limits, UnsafeLocation } from './schema-set.js';

export * from './index.js';

export interface ConvertFileOptions {
  /** The root element: `name`, `prefix:name` or `{namespace}name`. */
  root?: string | undefined;
  options?: ConvertOptions | undefined;
  /** The directory schemas may be read from. Default: the directory of the entry file. */
  baseDirectory?: string | undefined;
  /** Size limits of the schema set; see `ConvertInput.limits`. */
  limits?: Limits | undefined;
}

/**
 * Like `convert()`, but reads the entry document and everything it imports or includes from disk, relative to the
 * entry file. Neither a schema location nor a symbolic link can leave `baseDirectory`; URLs are not read and show up
 * as `missing-file`.
 */
export function convertFile(
  entryFile: string,
  { root, options, baseDirectory, limits }: ConvertFileOptions = {},
): ConvertResult {
  const { maxFileBytes } = effectiveLimits(limits);
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
    // A local path outside the base directory, or a file: URL, is refused; another URL is just not read.
    if (/^file:/i.test(path) || (!isAbsoluteUri(path) && isAbsolute(path))) {
      throw new UnsafeLocation('convertFile reads relative paths inside the base directory only');
    }
    if (isAbsoluteUri(path)) {
      throw new Error(
        'convertFile reads relative local paths only; pass a reader function to convert() to supply other documents',
      );
    }
    const candidate = resolve(base, ...path.split('/'));
    if (!inside(candidate)) {
      throw new UnsafeLocation('the schema path leaves the base directory');
    }
    if (!existsSync(candidate)) {
      return undefined;
    }
    const actual = realpathSync(candidate);
    if (!inside(actual)) {
      throw new UnsafeLocation('the symbolic link leaves the base directory');
    }
    // The limits count the bytes of the file, so its size decides before reading.
    const size = statSync(actual).size;
    if (size > maxFileBytes) {
      throw new FileTooLarge(`${path} exceeds ${maxFileBytes} bytes`);
    }
    sizes.set(path, size);
    return decodeSchema(readFileSync(actual));
  };
  const sizes = new Map<string, number>();
  const entryPath = relative(base, actualEntry).split(sep).join('/');
  return convertSchemas({ files: read, entry: entryPath, root, options, limits }, (path) => sizes.get(path));
}
