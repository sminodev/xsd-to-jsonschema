import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { type At, messageOf, type Problems } from './problems.js';
import { checkDoctype } from './doctype.js';
import { EncodingError } from './encoding.js';

export const XS = 'http://www.w3.org/2001/XMLSchema';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * Line ends as XML 1.0 normalizes them (2.11): CR LF and a lone CR become LF. The parser's default also turns U+0085,
 * U+2028 and U+2029 into LF, as XML 1.1 does; in XML 1.0 they are ordinary characters.
 */
export const lineEnds = (text: string): string => text.replace(/\r\n?/g, '\n');

export type ComponentKind = 'element' | 'attribute' | 'complexType' | 'simpleType' | 'group' | 'attributeGroup';
const KINDS: readonly ComponentKind[] = [
  'element',
  'attribute',
  'complexType',
  'simpleType',
  'group',
  'attributeGroup',
];

/** An expanded name: namespace URI (empty for none) and local name. */
export interface QName {
  ns: string;
  local: string;
}

/** Size limits of a schema set and of the schema written from it; each a positive safe integer. */
export interface Limits {
  /** bytes of one document, counted as UTF-8; default 4 MiB */
  maxFileBytes?: number | undefined;
  /** bytes of all documents together, a document loaded again for another namespace counted again; default 16 MiB */
  maxTotalBytes?: number | undefined;
  /** documents, a document loaded again for another namespace counted again; default 128 */
  maxDocuments?: number | undefined;
  /**
   * output entries the schema may hold: one for each key of a `properties` map and one for each branch of an `anyOf` or
   * `oneOf`, wherever it is written, a `$ref` not followed; default 200000. Bounds a schema that grows with the square of
   * its input, such as a long chain of extensions whose types are all used.
   */
  maxOutputEntries?: number | undefined;
  /**
   * structure units the whole report of `describeSchema()` may hold (see `structureSize`); default 20000000. Bounds a
   * report that doubles with every level of groups that each refer twice to the next one. Not used by `convert()`.
   */
  maxStructureSize?: number | undefined;
}

/** Limits with every value set. */
export type EffectiveLimits = { [K in keyof Limits]-?: number };

export const DEFAULT_LIMITS: EffectiveLimits = {
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxDocuments: 128,
  maxOutputEntries: 200_000,
  maxStructureSize: 20_000_000,
};

/** The limits with their defaults; throws a TypeError for a value that is no positive safe integer. */
export function effectiveLimits(limits: Limits = {}): EffectiveLimits {
  const plain =
    typeof limits === 'object' &&
    limits !== null &&
    !Array.isArray(limits) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(limits) as object | null);
  if (!plain) {
    throw new TypeError(`limits must be a plain object, not ${Array.isArray(limits) ? 'an array' : typeof limits}`);
  }
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = limits[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`limits.${key} must be a positive safe integer, not ${String(value)}`);
    }
    out[key] = value;
  }
  return out;
}

/** Thrown by a reader for a document above `maxFileBytes`, before it reads all of it. */
export class FileTooLarge extends Error {
  override name = 'FileTooLarge';
}

/** Thrown by a reader for a location it must not read: outside its base directory, or a `file:` URL. */
export class UnsafeLocation extends Error {
  override name = 'UnsafeLocation';
}

/** A global component and the document that declares it. */
export interface Component {
  node: Element;
  doc: SchemaDocument;
}

/** The schema texts by path, or a function that reads them. */
export type SchemaSource = Readonly<Record<string, string>> | ((path: string) => string | undefined);

const isElement = (node: Node): node is Element => node.nodeType === 1;

/** The XML Schema element children of a node, without annotations. */
export function xsChildren(node: Node): Element[] {
  const out: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (isElement(child) && child.namespaceURI === XS && child.localName !== 'annotation') {
      out.push(child);
    }
  }
  return out;
}

export function xsChild(node: Node, localName: string): Element | undefined {
  return xsChildren(node).find((child) => child.localName === localName);
}

/**
 * The value of an attribute of type xs:boolean: true for `true` or `1`, false for `false` or `0`, with XML white space
 * (space, tab, line feed, carriage return) at both ends allowed, as xs:boolean collapses it; undefined for anything else.
 */
export function booleanOf(value: string | undefined): boolean | undefined {
  const token = value?.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
  return token === 'true' || token === '1' ? true : token === 'false' || token === '0' ? false : undefined;
}

export function attr(node: Element, name: string): string | undefined {
  return node.hasAttribute(name) ? (node.getAttribute(name) ?? undefined) : undefined;
}

/** The text of the xs:documentation elements of a component: lines joined, paragraphs kept. */
export function documentation(node: Node): string | undefined {
  const texts: string[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!isElement(child) || child.namespaceURI !== XS || child.localName !== 'annotation') {
      continue;
    }
    for (let doc = child.firstChild; doc; doc = doc.nextSibling) {
      if (isElement(doc) && doc.namespaceURI === XS && doc.localName === 'documentation') {
        const text = (doc.textContent ?? '')
          .split(/\r?\n\s*\r?\n/)
          .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
          .filter((paragraph) => paragraph.length > 0)
          .join('\n\n');
        if (text.length > 0) {
          texts.push(text);
        }
      }
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : undefined;
}

/** `{namespace}local`, the key of all component tables. */
export function clark(ns: string, local: string): string {
  return `{${ns}}${local}`;
}

/** An absolute URI such as `https://example.org/a.xsd`. One-letter schemes are left out: they are drive letters. */
export function isAbsoluteUri(path: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(path);
}

/**
 * Joins a relative path to the directory of `from` and normalizes `.` and `..`, with `/` as separator. Backslashes in
 * `relative` count as `/`, as schemas written on Windows sometimes use them in schemaLocation. An absolute URI stays
 * as it is, and a relative path is resolved against `from` if that is a URI.
 */
export function resolvePath(from: string, relative: string): string {
  relative = relative.replace(/\\/g, '/');
  if (isAbsoluteUri(relative)) {
    return relative;
  }
  if (isAbsoluteUri(from)) {
    try {
      return new URL(relative, from).href;
    } catch {
      return relative;
    }
  }
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return normalizePath(relative.startsWith('/') ? relative : base + relative);
}

export function normalizePath(path: string): string {
  if (isAbsoluteUri(path)) {
    return path;
  }
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop();
    } else if (segment !== '.' && segment !== '') {
      out.push(segment);
    }
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/');
}

export class SchemaDocument {
  readonly targetNamespace: string;
  readonly elementQualified: boolean;
  readonly attributeQualified: boolean;
  /** a document without target namespace, included into the namespace it now has (chameleon include) */
  readonly chameleon: boolean;

  /** @param includedInto - the target namespace a document without one takes from the document that includes it */
  constructor(
    readonly path: string,
    readonly root: Element,
    includedInto?: string,
  ) {
    const own = attr(root, 'targetNamespace') ?? '';
    this.chameleon = own === '' && includedInto !== undefined && includedInto !== '';
    this.targetNamespace = this.chameleon ? (includedInto ?? '') : own;
    this.elementQualified = attr(root, 'elementFormDefault') === 'qualified';
    this.attributeQualified = attr(root, 'attributeFormDefault') === 'qualified';
  }
}

/**
 * The schema documents reachable from an entry document through xs:import and xs:include, with their global
 * components by expanded name.
 */
export class SchemaSet {
  private loadedBytes = 0;
  /**
   * By path, or by path and namespace for a document included into a namespace it doesn't declare (see `load`); null
   * while a document is being read or if it could not be loaded
   */
  readonly documents = new Map<string, SchemaDocument | null>();
  /** the document of each loaded root element, to find the file of a node */
  private readonly byRoot = new Map<Element, SchemaDocument>();
  readonly components: Record<ComponentKind, Map<string, Component>> = {
    element: new Map(),
    attribute: new Map(),
    complexType: new Map(),
    simpleType: new Map(),
    group: new Map(),
    attributeGroup: new Map(),
  };
  private readonly read: (path: string) => string | undefined;
  readonly limits: EffectiveLimits;
  /** a group or attribute group in xs:redefine -> the definition it replaces, which a reference inside it means */
  private readonly originals = new Map<Element, Component>();
  /**
   * Why no schema may be written although documents were loaded: a size limit or unsafe input left a document out,
   * or an xs:redefine of a type or an xs:override can't be followed. A partial schema would look usable.
   */
  blocked = false;

  /**
   * @param sizeOf - the bytes of a document in its file, if the reader knows them; otherwise the bytes of its text as
   * UTF-8 count
   */
  constructor(
    source: SchemaSource,
    private readonly problems: Problems,
    limits?: Limits,
    private readonly sizeOf?: (path: string) => number | undefined,
  ) {
    this.limits = effectiveLimits(limits);
    this.read =
      typeof source === 'function' ? source : (path) => (Object.hasOwn(source, path) ? source[path] : undefined);
  }

  /**
   * Loads a document and everything it imports or includes.
   *
   * A document without target namespace that a document with one includes takes that namespace (chameleon include):
   * it is loaded once more for each such namespace, as a document of its own, and its components belong to that
   * namespace. References in it that resolve to no namespace refer to its components in that namespace.
   *
   * @param includedInto - the target namespace of the including document, for an xs:include
   */
  load(path: string, from?: At, includedInto?: string): SchemaDocument | undefined {
    path = normalizePath(path);
    const known = this.documents.get(path);
    const chameleonKey = `${path}\n${includedInto ?? ''}`;
    if (includedInto && known?.targetNamespace === '') {
      // Already loaded without a namespace: load it again into the namespace of the including document.
      return this.documents.has(chameleonKey)
        ? (this.documents.get(chameleonKey) ?? undefined)
        : this.loadAs(chameleonKey, path, from, includedInto);
    }
    if (this.documents.has(path)) {
      return known ?? undefined;
    }
    if (includedInto && this.documents.has(chameleonKey)) {
      return this.documents.get(chameleonKey) ?? undefined;
    }
    return this.loadAs(path, path, from, includedInto);
  }

  /** Reads and parses a document, registers its components and loads what it imports or includes. */
  private loadAs(
    key: string,
    path: string,
    from: At | undefined,
    includedInto: string | undefined,
  ): SchemaDocument | undefined {
    const { maxDocuments, maxFileBytes, maxTotalBytes } = this.limits;
    if (this.documents.size >= maxDocuments) {
      this.blocked = true;
      this.problems.error('resource-limit', `the schema set exceeds the limit of ${maxDocuments} documents`, from);
      return undefined;
    }
    this.documents.set(key, null);
    const at = { ...from, file: from?.file ?? path };
    let text: string | undefined;
    try {
      text = this.read(path);
    } catch (e) {
      if (e instanceof EncodingError) {
        this.blocked = true;
        this.problems.error(e.code, `schema document ${path}: ${messageOf(e)}`, at);
      } else if (e instanceof UnsafeLocation) {
        this.blocked = true;
        this.problems.error('unsafe-input', `schema document ${path} is not read: ${messageOf(e)}`, at);
      } else if (e instanceof FileTooLarge) {
        this.blocked = true;
        this.problems.error('resource-limit', `${path} exceeds the limit of ${maxFileBytes} bytes per file`, at);
      } else {
        this.problems.error('missing-file', `schema document ${path} could not be read: ${messageOf(e)}`, at);
      }
      return undefined;
    }
    if (text === undefined || text === null) {
      this.problems.error('missing-file', `schema document ${path} not found`, at);
      return undefined;
    }
    text = String(text);
    const bytes = this.sizeOf?.(path) ?? new TextEncoder().encode(text).length;
    this.loadedBytes += bytes;
    if (bytes > maxFileBytes) {
      this.blocked = true;
      this.problems.error('resource-limit', `${path} exceeds the limit of ${maxFileBytes} bytes per file`, at);
      return undefined;
    }
    if (this.loadedBytes > maxTotalBytes) {
      this.blocked = true;
      this.problems.error('resource-limit', `the schema set exceeds the limit of ${maxTotalBytes} bytes`, at);
      return undefined;
    }
    const doctype = checkDoctype(text);
    if (doctype.kind === 'invalid') {
      this.blocked = true;
      this.problems.error('invalid-xml', `${path}: ${doctype.reason}`, { file: path });
      return undefined;
    }
    if (doctype.kind === 'refused') {
      this.blocked = true;
      this.problems.error('unsafe-input', `the DOCTYPE declaration is refused: ${doctype.reason}`, { file: path });
      return undefined;
    }
    if (doctype.kind === 'neutralized') {
      text = doctype.text;
    }
    let root: Element | null;
    try {
      const xml = new DOMParser({
        // XML 1.0 ends lines with CR LF and CR only (2.11); U+0085, U+2028 and U+2029 stay characters.
        normalizeLineEndings: lineEnds,
        onError: (level, message) => {
          if (level !== 'warning') {
            throw new Error(message);
          }
        },
      }).parseFromString(text.replace(/^[\uFEFF \t\n\r]+/, ''), 'text/xml');
      root = xml.documentElement;
    } catch (e) {
      this.problems.error('invalid-xml', `${path}: ${messageOf(e)}`, { file: path });
      return undefined;
    }
    if (!root || root.namespaceURI !== XS || root.localName !== 'schema') {
      this.problems.error('not-a-schema', `${path} is no XML Schema document`, { file: path });
      return undefined;
    }
    if (doctype.kind === 'neutralized') {
      this.problems.warning(
        'neutralized-doctype',
        'the DOCTYPE declaration changes nothing and is ignored; its identifiers are not read',
        { file: path },
      );
    }
    let doc = new SchemaDocument(path, root, includedInto);
    if (doc.chameleon && key === path) {
      // A document without namespace, first reached through an include: keep it by path and namespace.
      this.documents.delete(path);
      key = `${path}\n${doc.targetNamespace}`;
    } else if (!doc.chameleon && key !== path) {
      doc = new SchemaDocument(path, root);
    }
    this.documents.set(key, doc);
    this.byRoot.set(root, doc);
    for (const child of xsChildren(root)) {
      const at = { file: path, node: child };
      const name = attr(child, 'name');
      const kind = KINDS.find((k) => k === child.localName);
      if (kind !== undefined && name !== undefined) {
        const table = this.components[kind];
        const id = clark(doc.targetNamespace, name);
        const known = table.get(id);
        if (known === undefined) {
          table.set(id, { node: child, doc });
        } else if (known.node !== child) {
          this.problems.error(
            'duplicate-component',
            `${child.localName} ${name} is defined in ${known.doc.path} and ${path}`,
            at,
          );
        }
      } else if (child.localName === 'import' || child.localName === 'include') {
        const location = attr(child, 'schemaLocation');
        if (location === undefined) {
          if (child.localName === 'include') {
            this.problems.error('missing-file', 'xs:include without schemaLocation', at);
          }
          continue;
        }
        const include = child.localName === 'include';
        const target = this.load(resolvePath(path, location), at, include ? doc.targetNamespace : undefined);
        if (target && child.localName === 'import' && (attr(child, 'namespace') ?? '') !== target.targetNamespace) {
          this.problems.error('namespace-mismatch', `import namespace does not match ${target.path}`, at);
        }
        if (target && include && target.targetNamespace !== doc.targetNamespace) {
          this.problems.error(
            'unsupported-include',
            `${target.path} has the target namespace ${target.targetNamespace || '(none)'}, not that of the including document`,
            at,
          );
        }
      } else if (child.localName === 'redefine') {
        this.redefine(child, doc, path);
      } else if (child.localName === 'override') {
        this.blocked = true;
        this.problems.error('unsupported-redefine', 'xs:override (XML Schema 1.1) is not supported', at);
      }
    }
    return doc;
  }

  /**
   * xs:redefine: includes a document and replaces some of its groups and attribute groups. A reference to the same
   * name inside a replacing definition means the replaced one. Redefined types are not supported.
   */
  private redefine(node: Element, doc: SchemaDocument, path: string): void {
    const at = { file: path, node };
    const location = attr(node, 'schemaLocation');
    if (location === undefined) {
      this.problems.error('missing-file', 'xs:redefine without schemaLocation', at);
      return;
    }
    const target = this.load(resolvePath(path, location), at, doc.targetNamespace);
    if (target && target.targetNamespace !== doc.targetNamespace) {
      this.problems.error(
        'unsupported-include',
        `${target.path} has the target namespace ${target.targetNamespace || '(none)'}, not that of the redefining document`,
        at,
      );
      return;
    }
    for (const child of xsChildren(node)) {
      const childAt = { file: path, node: child };
      const kind = child.localName;
      const name = attr(child, 'name');
      if ((kind === 'group' || kind === 'attributeGroup') && name !== undefined) {
        const table = this.components[kind];
        const id = clark(doc.targetNamespace, name);
        const original = table.get(id);
        if (!original) {
          this.problems.error(
            'unknown-group',
            `xs:redefine replaces ${kind} ${name}, which ${location} does not define`,
            childAt,
          );
          continue;
        }
        this.originals.set(child, original);
        table.set(id, { node: child, doc });
      } else {
        this.blocked = true;
        this.problems.error(
          'unsupported-redefine',
          `xs:redefine of a ${kind ?? 'component'} is not supported, only of groups and attribute groups; no schema is written`,
          childAt,
        );
      }
    }
  }

  /**
   * The group or attribute group a reference names. Inside a definition that replaces it in xs:redefine, a
   * reference to the same name means the replaced definition.
   */
  lookupRef(kind: 'group' | 'attributeGroup', name: QName, ref: Element): Component | undefined {
    const id = clark(name.ns, name.local);
    for (let node: Node | null = ref.parentNode; node; node = node.parentNode) {
      const original = isElement(node) ? this.originals.get(node) : undefined;
      if (
        original &&
        node.localName === kind &&
        clark(original.doc.targetNamespace, attr(node as Element, 'name') ?? '') === id
      ) {
        return original;
      }
    }
    return this.lookup(kind, name);
  }

  /** Resolves a QName written in an attribute value against the namespaces in scope of `node`. */
  resolveQName(node: Element, qname: string): QName {
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? null : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    if (prefix === 'xml') {
      return { ns: XML_NS, local };
    }
    // xmldom finds the default namespace with '' only; the DOM standard also accepts null.
    const ns =
      prefix === null ? node.lookupNamespaceURI('') || node.lookupNamespaceURI(null) : node.lookupNamespaceURI(prefix);
    if (prefix !== null && !ns) {
      this.problems.error('unknown-prefix', `prefix ${prefix} of ${qname} is not declared`, this.at(node));
    }
    // In a chameleon document, a name without namespace means a component of the namespace it was included into.
    if (!ns && prefix === null) {
      const doc = this.documentOf(node);
      if (doc?.chameleon) {
        return { ns: doc.targetNamespace, local };
      }
    }
    return { ns: ns || '', local };
  }

  lookup(kind: ComponentKind, name: QName): Component | undefined {
    return this.components[kind].get(clark(name.ns, name.local));
  }

  /** The place of a node for a problem: its file, line and column. */
  at(node: Node): At {
    return { file: this.pathOf(node), node };
  }

  /** The path of the document a node belongs to. */
  pathOf(node: Node): string | undefined {
    return this.documentOf(node)?.path;
  }

  /** The schema document a node belongs to. */
  documentOf(node: Node): SchemaDocument | undefined {
    const root = node.ownerDocument?.documentElement;
    return root ? this.byRoot.get(root) : undefined;
  }
}
