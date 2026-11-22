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
  it('converts to order.schema.json with the documented warnings and maps order.xml to order.json', async () => {
    const order = read('order.xml');
    const variant = (from: string, to: string) => {
      expect(order).toContain(from);
      return order.replace(from, to);
    };
    const extraLines = '<Line><Item>x</Item><Quantity>1</Quantity></Line>'.repeat(4);
    const result = await compare({
      files: Object.fromEntries(['order.xsd', 'line.xsd', 'common/common.xsd'].map((name) => [name, read(name)])),
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
        notCreated: variant(' created="2026-11-04T09:30:00"', ''),
        byPhone: variant('version="1.0" created', 'version="1.0" channel="phone" created'),
        byFax: variant('version="1.0" created', 'version="1.0" channel="fax" created'),
        wantedDay: variant('<Wanted>2026-11</Wanted>', '<Wanted>2026-11-30</Wanted>'),
        wantedBadMonth: variant('<Wanted>2026-11</Wanted>', '<Wanted>2026-13</Wanted>'),
        discountWithoutPercent: variant('<DiscountPercent>10</DiscountPercent>', ''),
        tooMuchDiscount: variant('<DiscountPercent>10</DiscountPercent>', '<DiscountPercent>100.5</DiscountPercent>'),
        noDiscount: variant('<DiscountCode>AUTUMN</DiscountCode>\n  <DiscountPercent>10</DiscountPercent>', ''),
        priceWithoutCurrency: variant('<Price currency="EUR">', '<Price>'),
        priceInCents: variant('<Price currency="EUR">4.99</Price>', '<Price currency="eur">499</Price>'),
        noContactName: variant('<c:Name>Paper Shop</c:Name>', ''),
        plainNote: variant('Please ring <c:b>twice</c:b>.', 'Please ring twice.'),
        extension: variant('</Order>', '<Extensions><x:Mark xmlns:x="urn:example:x">1</x:Mark></Extensions></Order>'),
      },
    });
    expect(result.problems.map((p) => `${p.severity}:${p.code}`)).toEqual([
      'warning:unsupported-any',
      'warning:unsupported-mixed',
    ]);
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
      notCreated: false,
      byPhone: true,
      byFax: false,
      wantedDay: true,
      wantedBadMonth: false,
      discountWithoutPercent: false,
      tooMuchDiscount: false,
      noDiscount: true,
      priceWithoutCurrency: false,
      priceInCents: false,
      noContactName: false,
      plainNote: true,
      extension: true,
    });
    expect(disagreements(result.verdicts)).toEqual([]);
    golden('order.schema.json', result.schema);
    golden('order.json', result.verdicts[0]?.value);
  });

  it('uses the generated pickup and delivery choice in the development guide', () => {
    const guide = readFileSync(join(DIR, '..', '..', 'docs', 'development.md'), 'utf8');
    const example = /```json\n([\s\S]*?)```/.exec(guide);
    const schema = JSON.parse(read('order.schema.json')) as { allOf: unknown[] };
    expect(JSON.parse(example?.[1] ?? 'null')).toEqual(schema.allOf[0]);
  });

  it('shows the XML and JSON forms of the first line price in the README', () => {
    const readme = readFileSync(join(DIR, '..', '..', 'README.md'), 'utf8');
    const xml = /```xml\n([\s\S]*?)```/.exec(readme)?.[1]?.trim();
    const json = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
    const order = JSON.parse(read('order.json')) as { Line: { Price?: unknown }[] };
    expect(xml).toBeDefined();
    expect(xml).toBe(/<Price\b[^>]*>[^<]*<\/Price>/.exec(read('order.xml'))?.[0]);
    expect(JSON.parse(json ?? '')).toEqual(order.Line[0]?.Price);
  });
});
