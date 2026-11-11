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

/** Whether a JSON number holds exactly the value of a decimal text. */
export function isExact(text: string, value: number): boolean {
  return canonicalDecimal(text) === canonicalDecimal(String(value));
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
