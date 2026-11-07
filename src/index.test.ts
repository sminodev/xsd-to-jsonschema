import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('is what the node entry point builds on', () => {
    expect(importGraph('node.ts').get('node.ts')).toContain('node:fs');
  });
});
