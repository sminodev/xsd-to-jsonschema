// Keeps examples/order in step with the converter: the schema and the JSON form in that folder are what convert()
// writes today. After an intended change, run UPDATE_EXAMPLES=1 npm test and review the diff.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compare, disagreements } from './test-support/oracle.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'order');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');

function golden(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env['UPDATE_EXAMPLES']) {
    writeFileSync(join(DIR, name), text);
  }
  expect(text, `${name} (UPDATE_EXAMPLES=1 npm test rewrites it)`).toBe(read(name));
}

describe('the order example', () => {
  it('converts without problems to order.schema.json, and order.xml maps to order.json', async () => {
    const order = read('order.xml');
    const variant = (from: string, to: string) => {
      expect(order).toContain(from);
      return order.replace(from, to);
    };
    const extraLines = '<Line><Item>x</Item><Quantity>1</Quantity></Line>'.repeat(4);
    const result = await compare({
      files: Object.fromEntries(['order.xsd', 'line.xsd', 'common.xsd'].map((name) => [name, read(name)])),
      entry: 'order.xsd',
      instances: {
        order,
        pickupAndDelivery: variant('<DeliveryDate>', '<Pickup>true</Pickup><DeliveryDate>'),
        pickup: variant('<DeliveryDate>2026-11-20</DeliveryDate>', '<Pickup>true</Pickup>'),
        noDelivery: variant('<DeliveryDate>2026-11-20</DeliveryDate>', ''),
        sixLines: variant('</Order>', `${extraLines}</Order>`),
        noEmail: variant('<c:Email>orders@example.com</c:Email>', '<c:Phone>1</c:Phone>'),
        emailInOrderNamespace: variant('<c:Email>orders@example.com</c:Email>', '<Email>orders@example.com</Email>'),
        zeroWeight: variant('<Weight>2.5</Weight>', '<Weight>0</Weight>'),
        bigBox: variant('<Box>M</Box>', '<Box>XL</Box>'),
        otherVersion: variant('common" version="1.0"', 'common" version="2.0"'),
      },
    });
    expect(result.problems).toEqual([]);
    expect(Object.fromEntries(result.verdicts.map((v) => [v.name, v.xsd]))).toEqual({
      order: true,
      pickupAndDelivery: false,
      pickup: true,
      noDelivery: false,
      sixLines: false,
      noEmail: false,
      emailInOrderNamespace: false,
      zeroWeight: false,
      bigBox: false,
      otherVersion: false,
    });
    expect(disagreements(result.verdicts)).toEqual([]);
    golden('order.schema.json', result.schema);
    golden('order.json', result.verdicts[0]?.value);
  });

  it('is quoted correctly in the README', () => {
    const readme = readFileSync(join(DIR, '..', '..', 'README.md'), 'utf8');
    const [excerpt, jsonForm] = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(
      (m) => JSON.parse(m[1] ?? '') as Record<string, unknown>,
    );
    const schema = JSON.parse(read('order.schema.json')) as Record<string, unknown>;
    // The keys of `part` appear in `whole` in the same order, with the same values.
    const quoted = (part: Record<string, unknown>, whole: Record<string, unknown>, path: string) => {
      const keys = Object.keys(whole);
      const positions = Object.keys(part).map((key) => keys.indexOf(key));
      expect(
        positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] ?? -1))),
        `order of ${path}`,
      ).toBe(true);
    };
    expect(excerpt).toBeDefined();
    quoted(excerpt ?? {}, schema, 'the schema');
    for (const [key, value] of Object.entries(excerpt ?? {})) {
      if (key === 'properties' || key === '$defs') {
        const part = value as Record<string, unknown>;
        const whole = schema[key] as Record<string, unknown>;
        quoted(part, whole, key);
        for (const [name, sub] of Object.entries(part)) {
          expect(sub, `${key}/${name}`).toEqual(whole[name]);
        }
      } else {
        expect(value, key).toEqual(schema[key]);
      }
    }
    expect(jsonForm).toEqual(JSON.parse(read('order.json')));
  });
});
