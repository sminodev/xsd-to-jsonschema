import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertFile } from './node.js';
import { checkDoctype } from './doctype.js';
import { ajvFor } from './test-support/oracle.js';
import { xmlToJson } from './test-support/xml-to-json.js';

// The DOCTYPE cases: each file is a schema for {urn:test:ds}Sig, and sample.xml is valid.
const CASES = join(dirname(fileURLToPath(import.meta.url)), 'test-support', 'doctype');
const files = readdirSync(CASES).filter((file) => file.endsWith('.xsd'));

describe('DOCTYPE declarations in schema documents', () => {
  it.each(files.filter((file) => file.startsWith('rejected-')))('refuse %s as unsafe-input', (file) => {
    const { schema, problems } = convertFile(join(CASES, file));
    expect(schema).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['unsafe-input']);
  });

  it('neutralize the harmless form, report it and keep the line numbers', () => {
    const { schema, problems } = convertFile(join(CASES, 'allowed-inert-doctype.xsd'));
    expect(problems.map((p) => p.code)).toEqual(['neutralized-doctype']);
    const sample = readFileSync(join(CASES, 'sample.xml'), 'utf8');
    expect(ajvFor(schema ?? {})(xmlToJson(schema ?? {}, sample))).toBe(true);
    const text = readFileSync(join(CASES, 'allowed-inert-doctype.xsd'), 'utf8');
    const check = checkDoctype(text);
    expect(check.kind).toBe('neutralized');
    if (check.kind === 'neutralized') {
      expect(check.text.split('\n')).toHaveLength(text.split('\n').length);
      expect(check.text).not.toContain('DOCTYPE');
      expect(check.defaults).toEqual([{ element: 'schema', name: 'xmlns:ds', value: 'urn:test:ds' }]);
    }
  });

  it.each(files.filter((file) => file.startsWith('allowed-entity-')))(
    'neutralize %s: an entity name in a comment or CDATA is no reference',
    (file) => {
      const { schema, problems } = convertFile(join(CASES, file));
      expect(problems.map((p) => p.code)).toEqual(['neutralized-doctype']);
      expect(schema).toBeDefined();
    },
  );

  it.each(['allowed-doctype-only-in-comment.xsd', 'allowed-comment-starts-with-hyphen.xsd'])(
    'load %s without any report: the DOCTYPE text stands only in a comment',
    (file) => {
      const { schema, problems } = convertFile(join(CASES, file));
      expect(problems).toEqual([]);
      expect(schema).toBeDefined();
    },
  );

  it.each(files.filter((file) => file.startsWith('malformed-')))('report %s as invalid-xml', (file) => {
    const { schema, problems } = convertFile(join(CASES, file));
    expect(schema).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['invalid-xml']);
  });

  it('cover every case', () => {
    const known = [
      'rejected-',
      'malformed-',
      'allowed-entity-',
      'allowed-inert-doctype',
      'allowed-doctype-only-in-comment',
      'allowed-comment-starts-with-hyphen',
    ];
    expect(files.filter((file) => !known.some((prefix) => file.startsWith(prefix)))).toEqual([]);
    expect(files).toHaveLength(25);
  });

  it('read a large body in linear time: 4 MiB of entity references take well under a second', () => {
    const doctype = '<?xml version="1.0"?><!DOCTYPE schema [ <!ENTITY unused "x"> ]>';
    const body = '&amp;'.repeat(Math.floor((4 * 1024 * 1024 - 200) / 5));
    const text = `${doctype}<schema xmlns="http://www.w3.org/2001/XMLSchema"><annotation><documentation>${body}</documentation></annotation></schema>`;
    const started = performance.now();
    expect(checkDoctype(text).kind).toBe('neutralized');
    expect(checkDoctype(text.replace('&amp;', '&unused;')).kind).toBe('refused');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['two declarations', '<!DOCTYPE a><!DOCTYPE b><a/>'],
    ['a processing instruction in the subset', '<!DOCTYPE a [<?pi x?>]><a/>'],
    ['an enumerated ATTLIST type', '<!DOCTYPE a [<!ATTLIST a xmlns:p (x|y) "x">]><a/>'],
    ['an ATTLIST for another attribute', '<!DOCTYPE a [<!ATTLIST a id CDATA #IMPLIED>]><a/>'],
    ['a non-empty parameter entity', `<!DOCTYPE a [<!ENTITY % p 'x'>]><a/>`],
    ['an unterminated literal', `<!DOCTYPE a [<!ENTITY e 'x>]><a/>`],
    ['a lowercase keyword', '<!doctype a><a/>'],
  ])('refuse %s', (_, text) => {
    expect(checkDoctype(text).kind).toBe('refused');
  });

  it('find no declaration in a prolog of comments and processing instructions', () => {
    expect(checkDoctype('﻿<?xml version="1.0"?><!-- <!DOCTYPE x> --><?pi <!DOCTYPE y>?><a/>')).toEqual({
      kind: 'none',
    });
  });
});
