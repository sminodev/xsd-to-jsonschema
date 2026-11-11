import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { type At, messageOf, type Problems } from './problems.js';

export const XS = 'http://www.w3.org/2001/XMLSchema';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

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

export const MAX_DOCUMENTS = 128;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SET_BYTES = 16 * 1024 * 1024;

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

  constructor(
    source: SchemaSource,
    private readonly problems: Problems,
  ) {
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
    if (this.documents.size >= MAX_DOCUMENTS) {
      this.problems.error('resource-limit', `schema set exceeds ${MAX_DOCUMENTS} documents`, from);
      return undefined;
    }
    this.documents.set(key, null);
    const at = { ...from, file: from?.file ?? path };
    let text: string | undefined;
    try {
      text = this.read(path);
    } catch (e) {
      this.problems.error('missing-file', `schema document ${path} could not be read: ${messageOf(e)}`, at);
      return undefined;
    }
    if (text === undefined || text === null) {
      this.problems.error('missing-file', `schema document ${path} not found`, at);
      return undefined;
    }
    text = String(text);
    const bytes = new TextEncoder().encode(text).length;
    this.loadedBytes += bytes;
    if (bytes > MAX_FILE_BYTES || this.loadedBytes > MAX_SET_BYTES) {
      this.problems.error('resource-limit', 'schema input exceeds the 2 MiB file or 16 MiB set limit', { file: path });
      return undefined;
    }
    if (/<!DOCTYPE\b/i.test(text)) {
      this.problems.error('unsafe-input', 'DOCTYPE declarations are not accepted in schema input', { file: path });
      return undefined;
    }
    let root: Element | null;
    try {
      const xml = new DOMParser({
        onError: (level, message) => {
          if (level !== 'warning') {
            throw new Error(message);
          }
        },
      }).parseFromString(text.replace(/^[\uFEFF\s]+/, ''), 'text/xml');
      root = xml.documentElement;
    } catch (e) {
      this.problems.error('invalid-xml', `${path}: ${messageOf(e)}`, { file: path });
      return undefined;
    }
    if (!root || root.namespaceURI !== XS || root.localName !== 'schema') {
      this.problems.error('not-a-schema', `${path} is no XML Schema document`, { file: path });
      return undefined;
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
      } else if (child.localName === 'redefine' || child.localName === 'override') {
        this.problems.error('unsupported-redefine', `xs:${child.localName} is not supported`, at);
      }
    }
    return doc;
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
