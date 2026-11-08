import { isMultipleOf } from './decimal.js';
import type { JsonSchema } from './json-schema.js';
import type { At, Problems } from './problems.js';

interface Bound {
  value: number;
  exclusive: boolean;
}

export interface NumericFacets {
  fractionDigits?: number;
  totalDigits?: number;
  lower: Bound[];
  upper: Bound[];
}

function tightest(bounds: Bound[], isLower: boolean): Bound | undefined {
  return bounds.reduce<Bound | undefined>(
    (best, bound) =>
      best === undefined ||
      (isLower ? bound.value > best.value : bound.value < best.value) ||
      (bound.value === best.value && bound.exclusive)
        ? bound
        : best,
    undefined,
  );
}

function digitAlternatives(total: number, fraction: number): JsonSchema[] | undefined {
  const branches: JsonSchema[] = [];
  // Each decimal scale has its own digit bound; integers retain the full range.
  for (let scale = 0; scale <= fraction; scale += 1) {
    const step = Number(`1e-${scale}`);
    const limit = Number(`1e${total - scale}`);
    if (step === 0 || !Number.isFinite(limit) || limit === 0) {
      return undefined;
    }
    branches.push({ multipleOf: step, exclusiveMinimum: -limit, exclusiveMaximum: limit });
  }
  return branches;
}

function applyDigits(schema: JsonSchema, facets: NumericFacets, problems: Problems, at?: At): void {
  const { fractionDigits: fraction, totalDigits: total } = facets;
  if (fraction === 0) {
    schema.type = 'integer';
  } else if (fraction !== undefined && schema.type === 'number') {
    const step = Number(`1e-${fraction}`);
    if (step > 0) {
      schema.multipleOf = step;
    } else {
      problems.error('unsupported-facet', `fractionDigits ${fraction} cannot be represented as a JSON number`, at);
    }
  }
  if (total === undefined) {
    return;
  }
  const limit = Number(`1e${total}`);
  if (!Number.isFinite(limit)) {
    problems.error('unsupported-facet', `totalDigits ${total} cannot be represented as a JSON number`, at);
    return;
  }
  facets.lower.push({ value: -limit, exclusive: true });
  facets.upper.push({ value: limit, exclusive: true });
  if (schema.type === 'integer') {
    return;
  }
  const alternatives = fraction === undefined ? undefined : digitAlternatives(total, fraction);
  if (alternatives) {
    schema.anyOf = alternatives;
  } else {
    problems.warning(
      'approximated-total-digits',
      `totalDigits ${total} is approximated by |value| < ${limit}; no representable fractionDigits limit is available`,
      at,
    );
  }
}

export function applyNumericFacets(schema: JsonSchema, facets: NumericFacets, problems: Problems, at?: At): void {
  if (schema.type !== 'number' && schema.type !== 'integer') {
    return;
  }
  if (schema.minimum !== undefined) {
    facets.lower.push({ value: schema.minimum, exclusive: false });
  }
  if (schema.maximum !== undefined) {
    facets.upper.push({ value: schema.maximum, exclusive: false });
  }
  applyDigits(schema, facets, problems, at);
  delete schema.minimum;
  delete schema.maximum;
  const low = tightest(facets.lower, true);
  const high = tightest(facets.upper, false);
  if (low) {
    schema[low.exclusive ? 'exclusiveMinimum' : 'minimum'] = low.value;
  }
  if (high) {
    schema[high.exclusive ? 'exclusiveMaximum' : 'maximum'] = high.value;
  }
}

export function numericViolation(schema: JsonSchema, value: number): string | undefined {
  if (schema.minimum !== undefined && value < schema.minimum) {
    return `below ${schema.minimum}`;
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    return `not above ${schema.exclusiveMinimum}`;
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    return `above ${schema.maximum}`;
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    return `not below ${schema.exclusiveMaximum}`;
  }
  if (schema.multipleOf !== undefined && !isMultipleOf(value, schema.multipleOf)) {
    return 'more than the allowed fraction digits';
  }
  return undefined;
}
