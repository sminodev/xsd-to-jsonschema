# Encoding cases

Schema documents in several character encodings. Each schema
enumerates the name `Müller` (or `M\u0080ller` in `latin1-c1-range.xsd`); `sample-utf8.xml` and
`sample-latin1.xml` are documents for them.

- `latin1*.xsd`, `utf16*-bom.xsd`, `utf8-without-declaration.xsd`: load, with the characters the encoding gives.
- `unsupported-*.xsd`: `unsupported-encoding`, without a schema.
- `malformed-*.xsd`: `invalid-xml`, without a schema: bytes the encoding doesn't allow, or a byte order mark the
  declaration contradicts.

`src/encoding.test.ts` runs every case.
