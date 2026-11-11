// Document type declarations in schema documents (XML 1.0, 2.8). A DTD can define entities that change what the
// document says, or read other files; neither may happen here. A linear scan of the prolog, aware of quotes and
// comments, accepts one form only, a declaration that provably changes nothing:
//
// - at most one DOCTYPE, before the root element; a PUBLIC or SYSTEM identifier is text and is never read;
// - in the internal subset only comments, unused general entities with literal text (never one of the predefined
//   `amp`, `lt`, `gt`, `quot`, `apos`), unused empty parameter entities, and ATTLIST defaults of CDATA namespace
//   declarations that the root element states itself with the same text, without character references.
//
// The scan follows the XML grammar: a comment ends at the first `-->` after its `<!--`, white space stands where XML
// requires it, names consist of XML name characters, and an entity value with `<` is no literal text. An entity name
// in a comment, CDATA section or processing instruction is no reference. A markup declaration after the prolog is
// refused too. A second byte order mark or white space before the XML declaration makes the document invalid. Every
// part reads the text once, so the time grows linearly with its length.
//
// Such a declaration is replaced by spaces, keeping line breaks, so that positions stay. Anything else is refused.

import { NAME_CHAR, NAME_START } from './name-chars.js';

/** A namespace declaration an ATTLIST gives as default; the root element must state it itself. */
export interface NamespaceDefault {
  element: string;
  name: string;
  value: string;
}

export type DoctypeCheck =
  | { kind: 'none' }
  | { kind: 'neutralized'; text: string; defaults: NamespaceDefault[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'invalid'; reason: string };

const BOM = '\uFEFF';
const PREDEFINED = ['amp', 'lt', 'gt', 'quot', 'apos'];
// A Name of XML 1.0, Second Edition, the edition XML Schema 1.0 refers to; no length limit.
const NAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u');

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n';

class Refused extends Error {}

/** Checks the document type declaration of a document and neutralizes it if it is the one harmless form. */
export function checkDoctype(text: string): DoctypeCheck {
  const first = text.startsWith(BOM) ? 1 : 0;
  if (text.startsWith(BOM, first)) {
    return { kind: 'invalid', reason: 'a second byte order mark' };
  }
  if (/^[ \t\r\n]+<\?xml[ \t\r\n?]/.test(text.slice(first, first + 4096))) {
    return { kind: 'invalid', reason: 'white space before the XML declaration' };
  }
  try {
    const start = prologEnd(text, first);
    if (!isDeclaration(text, start)) {
      scanBody(text, start, new Set());
      return { kind: 'none' };
    }
    const { end, entities, defaults } = new Scanner(text, start).doctype();
    const root = prologEnd(text, end);
    if (isDeclaration(text, root)) {
      throw new Refused('a second markup declaration before the root element');
    }
    checkDefaults(text, root, defaults);
    scanBody(text, root, new Set(entities));
    const blank = text.slice(start, end).replace(/[^\r\n]/g, ' ');
    return { kind: 'neutralized', text: text.slice(0, start) + blank + text.slice(end), defaults };
  } catch (e) {
    if (e instanceof Refused) {
      return { kind: 'refused', reason: e.message };
    }
    throw e;
  }
}

/** A markup declaration other than a comment starts at `i`. */
const isDeclaration = (text: string, i: number): boolean => text.startsWith('<!', i) && !text.startsWith('<!--', i);

/**
 * Where the prolog ends: the first markup after white space, processing instructions and comments. A comment ends at
 * the first `-->` after its `<!--`, so `<!--->` doesn't end one.
 */
function prologEnd(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && isSpace(text.charAt(i))) {
      i += 1;
    }
    const [open, close] = text.startsWith('<?', i) ? ['<?', '?>'] : text.startsWith('<!--', i) ? ['<!--', '-->'] : [];
    const end = open === undefined || close === undefined ? -1 : text.indexOf(close, i + open.length);
    if (end < 0 || close === undefined) {
      return i;
    }
    i = end + close.length;
  }
}

/**
 * Reads the document after the prolog in one pass: a markup declaration there is refused, and so is a reference to
 * one of `entities`. Comments, CDATA sections and processing instructions are skipped, as their text holds no
 * references.
 */
function scanBody(text: string, from: number, entities: Set<string>): void {
  const special = /[<&]/g;
  const reference = /&([^;<& \t\r\n]*);/y;
  special.lastIndex = from;
  for (let match = special.exec(text); match; match = special.exec(text)) {
    const at = match.index;
    if (text.charAt(at) === '&') {
      reference.lastIndex = at;
      const name = entities.size > 0 ? reference.exec(text)?.[1] : undefined;
      if (name !== undefined && entities.has(name)) {
        throw new Refused(`the entity ${name} is used`);
      }
      continue;
    }
    const skip = (open: string, close: string): void => {
      const end = text.indexOf(close, at + open.length);
      special.lastIndex = end < 0 ? text.length : end + close.length;
    };
    if (text.startsWith('<!--', at)) {
      skip('<!--', '-->');
    } else if (text.startsWith('<![CDATA[', at)) {
      skip('<![CDATA[', ']]>');
    } else if (text.startsWith('<?', at)) {
      skip('<?', '?>');
    } else if (text.startsWith('<!', at)) {
      throw new Refused('a markup declaration outside the prolog');
    }
  }
}

/**
 * Checks that the root element states each namespace default of an ATTLIST itself, with the same text and without
 * character references, so that the default changes nothing.
 */
function checkDefaults(text: string, at: number, defaults: NamespaceDefault[]): void {
  if (defaults.length === 0) {
    return;
  }
  const tag = /^<([^ \t\n\r/>]+)/.exec(text.slice(at, at + 1024));
  const attributes = new Map<string, string>();
  const pattern = /[ \t\n\r]+([^ \t\n\r=/>]+)[ \t\n\r]*=[ \t\n\r]*(?:"([^"]*)"|'([^']*)')/y;
  pattern.lastIndex = at + (tag?.[0].length ?? 0);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    attributes.set(match[1] ?? '', match[2] ?? match[3] ?? '');
  }
  for (const d of defaults) {
    const written = attributes.get(d.name);
    if (tag?.[1] !== d.element || written === undefined || written !== d.value || written.includes('&')) {
      throw new Refused(
        `its default ${d.name}="${d.value}" for ${d.element} is not stated with the same text by the root element`,
      );
    }
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
    if (/[&%<]/.test(value)) {
      throw new Refused(`the entity ${name} is not purely literal`);
    }
    if (!parameter && PREDEFINED.includes(name)) {
      throw new Refused(`the predefined entity ${name} is declared again`);
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

  /** A name: up to the next delimiter, then checked against the XML name characters. */
  private name(): string {
    const start = this.i;
    while (this.i < this.text.length && !/[ \t\n\r[\]>"'%]/.test(this.text.charAt(this.i))) {
      this.i += 1;
    }
    const name = this.text.slice(start, this.i);
    if (!NAME.test(name)) {
      throw new Refused(name === '' ? `a name expected at offset ${start}` : `${name} is no XML name`);
    }
    return name;
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
