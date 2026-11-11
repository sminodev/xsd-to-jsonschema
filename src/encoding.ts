// The character encoding of a schema file (XML 1.0, 4.3.3 and Appendix F): from the byte order mark and the encoding
// in the XML declaration. The bytes are decoded strictly; a replacement character never stands in for a bad byte.
//
// - UTF-8: `UTF-8`, `UTF8`; also without a byte order mark and without a declaration;
// - UTF-16: `UTF-16`, `UTF16`, only with a byte order mark;
// - ISO-8859-1: `ISO-8859-1`, `ISO_8859-1`, `LATIN1`, where each byte is the code point of the same number (not
//   Windows-1252, which the WHATWG decoders return for that label);
// - US-ASCII: `US-ASCII`, `ASCII`, without bytes above 0x7F.
//
// Any other encoding is unsupported. Bytes the encoding doesn't allow, and a byte order mark the declaration
// contradicts, make the document invalid.

/** Why a file can't be decoded: an encoding the converter doesn't read, or bytes that aren't valid in it. */
export class EncodingError extends Error {
  override name = 'EncodingError';
  readonly code: 'unsupported-encoding' | 'invalid-xml';

  constructor(code: 'unsupported-encoding' | 'invalid-xml', message: string) {
    super(message);
    this.code = code;
  }
}

const NAMES: Record<string, 'utf-8' | 'utf-16' | 'latin1' | 'ascii'> = {
  'UTF-8': 'utf-8',
  UTF8: 'utf-8',
  'UTF-16': 'utf-16',
  UTF16: 'utf-16',
  'ISO-8859-1': 'latin1',
  'ISO_8859-1': 'latin1',
  LATIN1: 'latin1',
  'US-ASCII': 'ascii',
  ASCII: 'ascii',
};

/** The encoding the XML declaration names, read from text whose first characters are ASCII. */
function declared(head: string): string | undefined {
  const declaration = /^<\?xml[ \t\r\n][^>]*?\bencoding[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/.exec(head);
  return declaration ? (declaration[1] ?? declaration[2]) : undefined;
}

function strict(label: 'utf-8' | 'utf-16le' | 'utf-16be', bytes: Uint8Array, what: string): string {
  try {
    // The byte order mark stays in the text, so that the loader can tell one from two.
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EncodingError('invalid-xml', `the bytes are no valid ${what}`);
  }
}

/** Decodes the bytes of a schema file as its byte order mark and XML declaration say. */
export function decodeSchema(bytes: Uint8Array): string {
  const starts = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xfe) || starts(0xfe, 0xff)) {
    const text = strict(starts(0xff, 0xfe) ? 'utf-16le' : 'utf-16be', bytes, 'UTF-16');
    const name = declared(text.replace(/^\uFEFF/, ''));
    if (name !== undefined && NAMES[name.toUpperCase()] !== 'utf-16') {
      throw new EncodingError('invalid-xml', `the byte order mark of UTF-16 contradicts the declared encoding ${name}`);
    }
    return text;
  }
  const bom = starts(0xef, 0xbb, 0xbf);
  // The declaration is ASCII in every encoding read here without a byte order mark of UTF-16.
  const head = codes(bytes.subarray(bom ? 3 : 0, Math.min(bytes.length, 512)));
  const name = declared(head);
  const encoding = name === undefined ? 'utf-8' : NAMES[name.toUpperCase()];
  if (encoding === undefined) {
    throw new EncodingError('unsupported-encoding', `the encoding ${name ?? ''} is not supported`);
  }
  if (bom && encoding !== 'utf-8') {
    throw new EncodingError(
      'invalid-xml',
      `the byte order mark of UTF-8 contradicts the declared encoding ${name ?? ''}`,
    );
  }
  switch (encoding) {
    case 'utf-8':
      return strict('utf-8', bytes, 'UTF-8');
    case 'utf-16':
      throw new EncodingError('invalid-xml', 'UTF-16 needs a byte order mark');
    case 'ascii':
      if (bytes.some((b) => b > 0x7f)) {
        throw new EncodingError('invalid-xml', 'the bytes are no valid US-ASCII');
      }
      return codes(bytes);
    case 'latin1':
      return codes(bytes);
  }
}

/** Each byte as the character of the same code point, in chunks small enough for the argument list. */
function codes(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}
