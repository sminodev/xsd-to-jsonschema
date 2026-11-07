import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CODES, Problems } from './problems.js';

const SRC = dirname(fileURLToPath(import.meta.url));

describe('the problem codes', () => {
  it('are each explained in docs/output.md', () => {
    const docs = readFileSync(join(SRC, '..', 'docs', 'output.md'), 'utf8');
    const section = docs.slice(docs.indexOf('## Problems'), docs.indexOf('## Limits'));
    const documented = [...section.matchAll(/^\| `([a-z-]+)` +\|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...PROBLEM_CODES].sort());
  });

  it('are each reported somewhere in the converter', () => {
    const source = readdirSync(SRC)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'problems.ts')
      .map((file) => readFileSync(join(SRC, file), 'utf8'))
      .join('\n');
    expect(PROBLEM_CODES.filter((code) => !source.includes(`'${code}'`))).toEqual([]);
  });
});

describe('Problems', () => {
  it('keeps the same problem at the same place once', () => {
    const problems = new Problems();
    problems.error('unknown-type', 'type T is not defined', { file: 'a.xsd' });
    problems.error('unknown-type', 'type T is not defined', { file: 'a.xsd' });
    problems.error('unknown-type', 'type T is not defined', { file: 'b.xsd' });
    expect(problems.list.map((p) => p.file)).toEqual(['a.xsd', 'b.xsd']);
  });
});
