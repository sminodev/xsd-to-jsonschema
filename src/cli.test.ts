import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run, USAGE, type Io } from './cli.js';
import type { JsonSchema } from './json-schema.js';
import { convertFile } from './node.js';

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function capture() {
  const out = { stdout: '', stderr: '', files: {} as Record<string, string> };
  const io: Io = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    writeFile: (path, text) => (out.files[path] = text),
  };
  return { out, io };
}

describe('convertFile and the command line', () => {
  let dir: string;
  let main: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'xsd-to-jsonschema-'));
    mkdirSync(join(dir, 'types'));
    main = join(dir, 'main.xsd');
    writeFileSync(
      main,
      `<xs:schema ${XS} xmlns:o="urn:o" targetNamespace="urn:t">
        <xs:import namespace="urn:o" schemaLocation="types/o.xsd"/>
        <xs:element name="A" type="o:Code"/>
        <xs:element name="B"><xs:simpleType><xs:list itemType="xs:string"/></xs:simpleType></xs:element>
      </xs:schema>`,
    );
    writeFileSync(
      join(dir, 'types', 'o.xsd'),
      `<xs:schema ${XS} targetNamespace="urn:o"><xs:simpleType name="Code"><xs:restriction base="xs:token"><xs:maxLength value="3"/></xs:restriction></xs:simpleType></xs:schema>`,
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads imports relative to the entry file', () => {
    const { schema, problems } = convertFile(main, { root: 'A' });
    expect(problems).toEqual([]);
    expect(schema?.$defs?.['Code']).toEqual({ type: 'string', maxLength: 3 });
  });

  it('writes the schema to stdout and the problems to stderr', () => {
    const { out, io } = capture();
    expect(run([main, '--root', 'A'], io)).toBe(0);
    expect((JSON.parse(out.stdout) as JsonSchema).xml).toEqual({ name: 'A', namespace: 'urn:t' });
    expect(out.stderr).toBe('');
  });

  it('exits with 1 on errors with --strict, and with 2 when nothing is written', () => {
    const strict = capture();
    expect(run([main, '--root', 'B', '--strict'], strict.io)).toBe(1);
    expect(strict.out.stderr).toContain('error unsupported-list');

    const noRoot = capture();
    expect(run([main], noRoot.io)).toBe(2);
    expect(noRoot.out.stderr).toContain('root-required');

    const badMode = capture();
    expect(run([main, '--date-time', 'x'], badMode.io)).toBe(2);

    const emptyText = capture();
    expect(run([main, '--root', 'A', '--text-property', ''], emptyText.io)).toBe(2);
    expect(emptyText.out.stderr).toBe('--text-property must not be empty\n');
  });

  it('reads no remote documents and says so', () => {
    const file = join(dir, 'remote.xsd');
    writeFileSync(
      file,
      `<xs:schema ${XS} targetNamespace="urn:r"><xs:import namespace="urn:o" schemaLocation="https://example.org/o.xsd"/><xs:element name="R" type="xs:string"/></xs:schema>`,
    );
    const { problems } = convertFile(file);
    expect(problems).toEqual([
      expect.objectContaining({
        code: 'missing-file',
        message:
          'schema document https://example.org/o.xsd could not be read: convertFile reads local files only; ' +
          'pass a reader function to convert() to supply remote documents',
      }),
    ]);
  });

  it('exits with 2 and a message when the entry is a directory or the output cannot be written', () => {
    const directory = capture();
    expect(run([join(dir, 'types'), '--root', 'A'], directory.io)).toBe(2);
    expect(directory.out.stderr).toMatch(/^error missing-file: schema document types could not be read: EISDIR/);

    const { out, io } = capture();
    io.writeFile = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(run([main, '--root', 'A', '--out', 'locked.json'], io)).toBe(2);
    expect(out.stderr).toBe('cannot write locked.json: EACCES: permission denied\n');
  });

  it('writes to a file with --out and leaves out the xml annotations with --no-xml', () => {
    const { out, io } = capture();
    expect(run([main, '--root', 'A', '--no-xml', '--out', 'out.json'], io)).toBe(0);
    expect((JSON.parse(out.files['out.json'] ?? '{}') as JsonSchema).xml).toBeUndefined();
  });

  it('prints the help', () => {
    const { out, io } = capture();
    expect(run(['--help'], io)).toBe(0);
    expect(out.stdout).toBe(`${USAGE}\n`);
  });
});
