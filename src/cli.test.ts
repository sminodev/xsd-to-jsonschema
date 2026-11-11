import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('exits with 1 on errors even without --strict, and with 2 when nothing is written', () => {
    const errors = capture();
    expect(run([main, '--root', 'B'], errors.io)).toBe(1);
    expect(errors.out.stdout).not.toBe('');

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

  it('only treats warnings as failure with --strict and keeps diagnostics on stderr', () => {
    const file = join(dir, 'warning.xsd');
    writeFileSync(
      file,
      `<xs:schema ${XS}><xs:element name="A"><xs:complexType>
        <xs:sequence><xs:any/></xs:sequence>
      </xs:complexType></xs:element></xs:schema>`,
    );
    const normal = capture();
    expect(run([file], normal.io)).toBe(0);
    expect(normal.out.stderr).toContain('warning unsupported-any');
    expect(normal.out.stdout).toMatch(/^\{/);
    const strict = capture();
    expect(run([file, '--strict'], strict.io)).toBe(1);
    expect(strict.out.stderr).toContain('warning unsupported-any');
    expect(strict.out.stdout).toBe(normal.out.stdout);
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
          'schema document https://example.org/o.xsd could not be read: convertFile reads relative local paths ' +
          'only; pass a reader function to convert() to supply other documents',
      }),
    ]);
  });

  describe('stays inside the base directory', () => {
    let root: string;
    const type = `<xs:schema ${XS}><xs:simpleType name="T"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>`;
    const entryFor = (location: string) => {
      const entry = join(root, 'inside', 'a.xsd');
      writeFileSync(
        entry,
        `<xs:schema ${XS}><xs:include schemaLocation="${location}"/><xs:element name="R" type="T"/></xs:schema>`,
      );
      return entry;
    };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'xsd-to-jsonschema-base-'));
      mkdirSync(join(root, 'inside'));
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(root, 'outside', 't.xsd'), type);
      symlinkSync(join(root, 'outside', 't.xsd'), join(root, 'inside', 'link.xsd'));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('refuses a relative path that leaves it', () => {
      const { problems } = convertFile(entryFor('../outside/t.xsd'));
      expect(problems[0]).toMatchObject({ code: 'missing-file' });
      expect(problems[0]?.message).toContain('leaves the base directory');
    });

    it('refuses a file: URL and a symbolic link that leaves it', () => {
      const url = pathToFileURL(join(root, 'outside', 't.xsd')).href;
      expect(convertFile(entryFor(url)).problems[0]?.message).toContain('relative local paths only');
      expect(convertFile(entryFor('link.xsd')).problems[0]?.message).toContain('symbolic link leaves');
    });

    it('reads sibling folders with a wider base directory', () => {
      const entry = entryFor('../outside/t.xsd');
      expect(convertFile(entry, { baseDirectory: root }).problems).toEqual([]);
      const { out, io } = capture();
      expect(run([entry, '--base-dir', root], io)).toBe(0);
      expect(out.stderr).toBe('');
    });

    it('refuses an entry outside the base directory', () => {
      const { schema, problems } = convertFile(entryFor('x.xsd'), { baseDirectory: join(root, 'outside') });
      expect(schema).toBeUndefined();
      expect(problems).toEqual([expect.objectContaining({ code: 'unsafe-input' })]);
    });

    it('refuses a file larger than 2 MiB before reading it', () => {
      const big = join(root, 'inside', 'big.xsd');
      writeFileSync(big, ' '.repeat(2 * 1024 * 1024 + 1));
      expect(convertFile(big).problems[0]?.message).toContain('2 MiB');
    });
  });

  it('exits with 2 and a message when the entry is a directory or the output cannot be written', () => {
    const directory = capture();
    expect(run([join(dir, 'types'), '--root', 'A'], directory.io)).toBe(2);
    expect(directory.out.stderr).toMatch(/^error missing-file: types: schema document types could not be read: EISDIR/);

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
