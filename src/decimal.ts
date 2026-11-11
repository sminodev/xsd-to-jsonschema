function decimal(value: number): [bigint, number] {
  const [mantissa = '0', exponent = '0'] = value.toExponential().split('e');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = fraction.length - Number(exponent);
  return scale >= 0 ? [digits, scale] : [digits * 10n ** BigInt(-scale), 0];
}

/** The digits and exponent of a decimal text, the same for every spelling of one value. */
function canonicalDecimal(text: string): string {
  const [, sign, whole = '', fraction = '', exponent = '0'] =
    /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const raw = `${whole}${fraction}`.replace(/^0+/, '');
  if (raw === '') {
    return '0';
  }
  const digits = raw.replace(/0+$/, '');
  return `${sign === '-' ? '-' : ''}${digits}e${Number(exponent) - fraction.length + raw.length - digits.length}`;
}

/**
 * Whether a JSON number holds the value of a decimal text so that it compares like the decimal: written back it is
 * the same value, and no other decimal of the same precision becomes the same number. That holds for an integer up
 * to 2^53 - 1 and for a fraction with at most 15 significant digits below that (IEEE 754 doubles keep 15 decimal
 * digits apart); beyond, decimals next to the value round onto it.
 */
export function isExact(text: string, value: number): boolean {
  const canonical = canonicalDecimal(text);
  if (canonical !== canonicalDecimal(String(value)) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    return false;
  }
  const [digits = '', exponent = '0'] = canonical.replace(/^-/, '').split('e');
  return Number(exponent) >= 0 || digits.length <= 15;
}

export function isMultipleOf(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return false;
  }
  const [v, vScale] = decimal(value);
  const [s, sScale] = decimal(step);
  const scale = Math.max(vScale, sScale);
  return (v * 10n ** BigInt(scale - vScale)) % (s * 10n ** BigInt(scale - sScale)) === 0n;
}
