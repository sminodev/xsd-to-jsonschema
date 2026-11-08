function decimal(value: number): [bigint, number] {
  const [mantissa = '0', exponent = '0'] = value.toExponential().split('e');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = fraction.length - Number(exponent);
  return scale >= 0 ? [digits, scale] : [digits * 10n ** BigInt(-scale), 0];
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
