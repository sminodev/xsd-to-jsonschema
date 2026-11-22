import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convert, describeSchema, isMultipleOf } from './index.js';
import { convertFile, describeSchemaFile } from './node.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/** All modules the given module imports, directly or indirectly, with their import specifiers. */
function importGraph(file: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(file)) {
    return seen;
  }
  const specifiers = [
    ...readFileSync(join(SRC, file), 'utf8').matchAll(/^(?:import|export)[^;]*?from '([^']+)'/gm),
  ].map((m) => m[1] as string);
  seen.set(file, specifiers);
  for (const specifier of specifiers.filter((s) => s.startsWith('./'))) {
    importGraph(specifier.slice(2).replace(/\.js$/, '.ts'), seen);
  }
  return seen;
}

describe('the main entry point', () => {
  it('needs no Node.js built-ins, so it runs in browsers too', () => {
    const graph = importGraph('index.ts');
    const builtins = [...graph].flatMap(([file, specifiers]) =>
      specifiers.filter((s) => s.startsWith('node:')).map((s) => `${file}: ${s}`),
    );
    expect(graph.size).toBeGreaterThan(5);
    expect(builtins).toEqual([]);
  });

  it('exposes conversion, structure reports and decimal validation to consumers', () => {
    const exampleDir = join(SRC, '..', 'examples', 'order');
    const entry = 'order.xsd';
    const file = join(exampleDir, entry);
    const input = { entry, files: (name: string) => readFileSync(join(exampleDir, name), 'utf8') };
    const converted = convert(input);
    const report = describeSchema(input);
    expect(converted.schema?.type).toBe('object');
    expect(convertFile(file)).toEqual(converted);
    expect(report.schema).toEqual(converted.schema);
    expect(report.structure?.root.name).toBe('{urn:example:order}Order');
    expect(describeSchemaFile(file)).toEqual(report);
    expect(isMultipleOf(1.12, 0.01)).toBe(true);
    expect(isMultipleOf(1.125, 0.01)).toBe(false);
  });

  it('is what the node entry point builds on', () => {
    expect(importGraph('node.ts').get('node.ts')).toContain('node:fs');
  });
});
