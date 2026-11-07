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

/**
 * Joins a relative path to the directory of `from` and normalizes `.` and `..`, with `/` as separator. Backslashes in
 * `relative` count as `/`, as schemas written on Windows sometimes use them in schemaLocation.
 */
export function resolvePath(from: string, relative: string): string {
  relative = relative.replace(/\\/g, '/');
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return normalizePath(relative.startsWith('/') ? relative : base + relative);
}

export function normalizePath(path: string): string {
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

  constructor(
    readonly path: string,
    readonly root: Element,
  ) {
    this.targetNamespace = attr(root, 'targetNamespace') ?? '';
    this.elementQualified = attr(root, 'elementFormDefault') === 'qualified';
    this.attributeQualified = attr(root, 'attributeFormDefault') === 'qualified';
  }
}

/**
 * The schema documents reachable from an entry document through xs:import and xs:include, with their global
 * components by expanded name.
 */
export class SchemaSet {
  /** null while a document is being loaded or if it could not be loaded */
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
    this.read = typeof source === 'function' ? source : (path) => source[path];
  }

  /** Loads a document and everything it imports or includes. */
  load(path: string, from?: At): SchemaDocument | undefined {
    path = normalizePath(path);
    if (this.documents.has(path)) {
      return this.documents.get(path) ?? undefined;
    }
    this.documents.set(path, null);
    let text: string | undefined;
    try {
      text = this.read(path);
    } catch (e) {
      this.problems.error('missing-file', `schema document ${path} could not be read: ${messageOf(e)}`, from);
      return undefined;
    }
    if (text === undefined || text === null) {
      this.problems.error('missing-file', `schema document ${path} not found`, from);
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
      }).parseFromString(String(text).replace(/^[\uFEFF\s]+/, ''), 'text/xml');
      root = xml.documentElement;
    } catch (e) {
      this.problems.error('invalid-xml', `${path}: ${messageOf(e)}`, { file: path });
      return undefined;
    }
    if (!root || root.namespaceURI !== XS || root.localName !== 'schema') {
      this.problems.error('not-a-schema', `${path} is no XML Schema document`, { file: path });
      return undefined;
    }
    const doc = new SchemaDocument(path, root);
    this.documents.set(path, doc);
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
        const target = this.load(resolvePath(path, location), at);
        if (target && child.localName === 'include' && target.targetNamespace !== doc.targetNamespace) {
          this.problems.error(
            'unsupported-include',
            `${target.path} is included into another target namespace (chameleon include)`,
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
    const root = node.ownerDocument?.documentElement;
    return root ? this.byRoot.get(root)?.path : undefined;
  }
}
