# DOCTYPE cases

Schema documents for the element `{urn:test:ds}Sig`; `sample.xml` is a valid document for them. The prefix of each file name says what a loader does with it:

- `allowed-*`: loads. A DOCTYPE that changes nothing is neutralized and reported as `neutralized-doctype`; DOCTYPE
  text inside a comment is a comment and is not reported.
- `rejected-*`: `unsafe-input`, without a schema. The rest of the name says why, for example an entity that the
  document uses, an external entity, a parameter entity reference, an `ELEMENT` declaration, a namespace default the
  root element doesn't state with the same text, a predefined entity declared again, markup in an entity value, a
  missing space, a character that is no XML name character, or a declaration after the root element.

`src/doctype.test.ts` runs every case.
