import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { convert, type ConvertOptions, type ConvertResult } from './convert.js';

export * from './index.js';

export interface ConvertFileOptions {
  /** The root element: `name`, `prefix:name` or `{namespace}name`. */
  root?: string | undefined;
  options?: ConvertOptions | undefined;
}

/**
 * Like `convert()`, but reads the entry document and everything it imports or includes from disk, relative to the
 * entry file.
 */
export function convertFile(entryFile: string, { root, options }: ConvertFileOptions = {}): ConvertResult {
  const directory = dirname(resolve(entryFile));
  const read = (path: string): string | undefined => {
    const file = resolve(directory, ...path.split('/'));
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
  return convert({ files: read, entry: basename(entryFile), root, options });
}
