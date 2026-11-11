import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertFile } from './node.js';
import { checkDoctype } from './doctype.js';
import { ajvFor } from './test-support/oracle.js';
import { xmlToJson } from './test-support/xml-to-json.js';

// The DOCTYPE cases shared with xsd-faker: each file is a schema for {urn:test:ds}Sig, and sample.xml is valid.
const CASES = join(dirname(fileURLToPath(import.meta.url)), 'test-support', 'doctype');
const files = readdirSync(CASES).filter((file) => file.endsWith('.xsd'));

describe('DOCTYPE declarations in schema documents', () => {
  it.each(files.filter((file) => file.startsWith('rejected-')))('refuse %s as unsafe-input', (file) => {
    const { schema, problems } = convertFile(join(CASES, file));
    expect(schema).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['unsafe-input']);
  });

  it('neutralize the harmless W3C form, report it and keep the line numbers', () => {
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

  it('load a document whose DOCTYPE text stands only in a comment without any report', () => {
    const { schema, problems } = convertFile(join(CASES, 'allowed-doctype-only-in-comment.xsd'));
    expect(problems).toEqual([]);
    expect(schema).toBeDefined();
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
