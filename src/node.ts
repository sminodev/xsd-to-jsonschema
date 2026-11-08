import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, type ConvertOptions, type ConvertResult } from './convert.js';
import { isAbsoluteUri } from './schema-set.js';

export * from './index.js';

export interface ConvertFileOptions {
  /** The root element: `name`, `prefix:name` or `{namespace}name`. */
  root?: string | undefined;
  options?: ConvertOptions | undefined;
}

/**
 * Like `convert()`, but reads the entry document and everything it imports or includes from disk, relative to the
 * entry file. `file:` URLs are read too; other URLs are not downloaded and show up as `missing-file`.
 */
export function convertFile(entryFile: string, { root, options }: ConvertFileOptions = {}): ConvertResult {
  const directory = dirname(resolve(entryFile));
  const read = (path: string): string | undefined => {
    if (isAbsoluteUri(path) && !path.startsWith('file:')) {
      throw new Error(
        'convertFile reads local files only; pass a reader function to convert() to supply remote documents',
      );
    }
    const file = path.startsWith('file:') ? fileURLToPath(path) : resolve(directory, ...path.split('/'));
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
  return convert({ files: read, entry: basename(entryFile), root, options });
}
