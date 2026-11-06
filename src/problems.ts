import type { Node } from '@xmldom/xmldom';

/**
 * Something the JSON Schema cannot express exactly. An `error` means the schema differs from the XML Schema; a
 * `warning` means it accepts some values the XML Schema rejects.
 */
export interface Problem {
  /** stable identifier, e.g. `unsupported-list` */
  code: string;
  severity: 'error' | 'warning';
  message: string;
  /** path of the schema document */
  file?: string;
  line?: number;
  column?: number;
}

/** Where a problem was found. */
export interface At {
  file?: string | undefined;
  node?: Node | undefined;
}

export class Problems {
  readonly list: Problem[] = [];

  add(severity: Problem['severity'], code: string, message: string, at: At = {}): void {
    const problem: Problem = { code, severity, message };
    if (at.file !== undefined) {
      problem.file = at.file;
    }
    if (at.node?.lineNumber !== undefined) {
      problem.line = at.node.lineNumber;
      if (at.node.columnNumber !== undefined) {
        problem.column = at.node.columnNumber;
      }
    }
    const key = JSON.stringify(problem);
    if (!this.list.some((p) => JSON.stringify(p) === key)) {
      this.list.push(problem);
    }
  }

  error(code: string, message: string, at?: At): void {
    this.add('error', code, message, at);
  }

  warning(code: string, message: string, at?: At): void {
    this.add('warning', code, message, at);
  }
}
