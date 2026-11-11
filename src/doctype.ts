// Document type declarations in schema documents (XML 1.0, 2.8). A DTD can define entities that change what the
// document says, or read other files; neither may happen here. A linear scan of the prolog, aware of quotes and
// comments, accepts one form only, a declaration that provably changes nothing:
//
// - at most one DOCTYPE, before the root element; a PUBLIC or SYSTEM identifier is text and is never read;
// - in the internal subset only comments, unused general entities with literal text, unused empty parameter
//   entities, and ATTLIST defaults of CDATA namespace declarations that the root element states itself with the
//   same value.
//
// Such a declaration is replaced by spaces, keeping line breaks, so that positions stay. Anything else is refused.

/** A namespace declaration an ATTLIST gives as default; the root element must state it itself. */
export interface NamespaceDefault {
  element: string;
  name: string;
  value: string;
}

export type DoctypeCheck =
  | { kind: 'none' }
  | { kind: 'neutralized'; text: string; defaults: NamespaceDefault[] }
  | { kind: 'refused'; reason: string };

/** Where the document type declaration of a document starts; undefined if it has none. */
export function doctypeStart(text: string, from = text.startsWith('﻿') ? 1 : 0): number | undefined {
  let i = from;
  for (;;) {
    while (i < text.length && isSpace(text.charAt(i))) {
      i += 1;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) {
        return undefined;
      }
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) {
        return undefined;
      }
      i = end + 3;
    } else {
      // Any other markup declaration before the root element counts as one; the parser rejects what isn't.
      return text.startsWith('<!', i) ? i : undefined;
    }
  }
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n';

class Refused extends Error {}

/** Checks the document type declaration of a document and neutralizes it if it is the one harmless form. */
export function checkDoctype(text: string): DoctypeCheck {
  const start = doctypeStart(text);
  if (start === undefined) {
    return { kind: 'none' };
  }
  try {
    const { end, entities, defaults } = new Scanner(text, start).doctype();
    if (doctypeStart(text, end) !== undefined) {
      throw new Refused('a second markup declaration before the root element');
    }
    const rest = text.slice(end);
    for (const name of entities) {
      if (rest.includes(`&${name};`)) {
        throw new Refused(`the entity ${name} is used`);
      }
    }
    const blank = text.slice(start, end).replace(/[^\r\n]/g, ' ');
    return { kind: 'neutralized', text: text.slice(0, start) + blank + rest, defaults };
  } catch (e) {
    if (e instanceof Refused) {
      return { kind: 'refused', reason: e.message };
    }
    throw e;
  }
}

class Scanner {
  private readonly entities: string[] = [];
  private readonly defaults: NamespaceDefault[] = [];

  constructor(
    private readonly text: string,
    private i: number,
  ) {}

  doctype(): { end: number; entities: string[]; defaults: NamespaceDefault[] } {
    this.expect('<!DOCTYPE');
    this.space();
    this.name();
    this.skip();
    if (this.word('SYSTEM')) {
      this.space();
      this.literal();
    } else if (this.word('PUBLIC')) {
      this.space();
      this.literal();
      this.space();
      this.literal();
    }
    this.skip();
    if (this.at('[')) {
      this.i += 1;
      this.subset();
      this.skip();
    }
    this.expect('>');
    return { end: this.i, entities: this.entities, defaults: this.defaults };
  }

  private subset(): void {
    for (;;) {
      this.skip();
      if (this.at(']')) {
        this.i += 1;
        return;
      }
      if (this.at('<!--')) {
        const end = this.text.indexOf('-->', this.i + 4);
        if (end < 0) {
          throw new Refused('an unterminated comment');
        }
        this.i = end + 3;
      } else if (this.word('<!ENTITY')) {
        this.entity();
      } else if (this.word('<!ATTLIST')) {
        this.attlist();
      } else if (this.at('%')) {
        throw new Refused('a parameter entity reference');
      } else if (this.at('<!ELEMENT') || this.at('<!NOTATION')) {
        throw new Refused('an ELEMENT or NOTATION declaration');
      } else {
        throw new Refused(`unexpected content in the internal subset at offset ${this.i}`);
      }
    }
  }

  private entity(): void {
    this.space();
    const parameter = this.at('%');
    if (parameter) {
      this.i += 1;
      this.space();
    }
    const name = this.name();
    this.space();
    if (!this.at('"') && !this.at("'")) {
      throw new Refused(`the entity ${name} is external`);
    }
    const value = this.literal();
    this.skip();
    this.expect('>');
    if (parameter && value !== '') {
      throw new Refused(`the parameter entity ${name} is not empty`);
    }
    if (/[&%]/.test(value)) {
      throw new Refused(`the entity ${name} is not purely literal`);
    }
    if (!parameter) {
      this.entities.push(name);
    }
  }

  private attlist(): void {
    this.space();
    const element = this.name();
    for (;;) {
      this.skip();
      if (this.at('>')) {
        this.i += 1;
        return;
      }
      const name = this.name();
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) {
        throw new Refused(`the ATTLIST declares ${name}, which is no namespace declaration`);
      }
      this.space();
      if (!this.word('CDATA')) {
        throw new Refused(`the ATTLIST type of ${name} is not CDATA`);
      }
      this.space();
      if (this.word('#FIXED')) {
        this.space();
      } else if (!this.at('"') && !this.at("'")) {
        throw new Refused(`the ATTLIST gives ${name} no default value`);
      }
      const value = this.literal();
      if (/[&<]/.test(value)) {
        throw new Refused(`the ATTLIST default of ${name} is not purely literal`);
      }
      this.defaults.push({ element, name, value });
    }
  }

  private at(token: string): boolean {
    return this.text.startsWith(token, this.i);
  }

  /** A keyword followed by a space or the end of a declaration; consumed if present. */
  private word(token: string): boolean {
    const next = this.text.charAt(this.i + token.length);
    if (this.at(token) && (isSpace(next) || next === '>' || next === '[' || next === '"' || next === "'")) {
      this.i += token.length;
      return true;
    }
    return false;
  }

  private expect(token: string): void {
    if (!this.at(token)) {
      throw new Refused(`${token} expected at offset ${this.i}`);
    }
    this.i += token.length;
  }

  private space(): void {
    if (!isSpace(this.text.charAt(this.i))) {
      throw new Refused(`white space expected at offset ${this.i}`);
    }
    this.skip();
  }

  private skip(): void {
    while (isSpace(this.text.charAt(this.i))) {
      this.i += 1;
    }
  }

  private name(): string {
    const start = this.i;
    while (this.i < this.text.length && !/[\s[\]>"'%]/.test(this.text.charAt(this.i))) {
      this.i += 1;
    }
    if (this.i === start) {
      throw new Refused(`a name expected at offset ${start}`);
    }
    return this.text.slice(start, this.i);
  }

  private literal(): string {
    const quote = this.text.charAt(this.i);
    if (quote !== '"' && quote !== "'") {
      throw new Refused(`a quoted literal expected at offset ${this.i}`);
    }
    const end = this.text.indexOf(quote, this.i + 1);
    if (end < 0) {
      throw new Refused('an unterminated literal');
    }
    const value = this.text.slice(this.i + 1, end);
    this.i = end + 1;
    return value;
  }
}
