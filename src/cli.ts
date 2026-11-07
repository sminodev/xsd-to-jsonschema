import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { convertFile } from './node.js';

export const USAGE = `Usage: xsd-to-jsonschema <entry.xsd> [options]

Generates a JSON Schema 2020-12 for one root element of an XML Schema.
Imports and includes are read relative to the entry file.

Options:
  --root <name>          root element: name, prefix:name or {namespace}name
                         (needed if the entry declares more than one global element)
  --date-time <mode>     format (RFC 3339, the default) or pattern (the XML Schema format)
  --no-xml               leave out the xml annotations
  --text-property <name> property for the text of elements with simple content (default: value)
  --out <file>           write to a file instead of stdout
  --strict               exit with 1 if the conversion reports an error
  -h, --help             show this help

Problems are printed to stderr.

Exit codes:
  0  schema written
  1  schema written, but the conversion reported errors (only with --strict)
  2  no schema written: bad arguments, an unreadable entry schema, a missing or unknown
     root element, or an output file that can't be written`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  writeFile(path: string, text: string): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeFile: (path, text) => writeFileSync(path, text),
};

/** Runs the command line with the given arguments and returns the exit code. */
export function run(argv: string[], io: Io = processIo): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        'date-time': { type: 'string', default: 'format' },
        'no-xml': { type: 'boolean', default: false },
        'text-property': { type: 'string', default: 'value' },
        out: { type: 'string' },
        strict: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.stderr(`${messageOf(e)}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const [entry] = positionals;
  if (entry === undefined || positionals.length !== 1) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const dateTime = values['date-time'];
  if (dateTime !== 'format' && dateTime !== 'pattern') {
    io.stderr('--date-time must be format or pattern\n');
    return 2;
  }
  if (values['text-property'] === '') {
    io.stderr('--text-property must not be empty\n');
    return 2;
  }
  const { schema, problems } = convertFile(entry, {
    root: values.root,
    options: { dateTime, xml: !values['no-xml'], textProperty: values['text-property'] },
  });
  for (const p of problems) {
    const where = p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : '';
    io.stderr(`${p.severity} ${p.code}: ${where}${p.message}\n`);
  }
  if (!schema) {
    return 2;
  }
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  if (values.out) {
    try {
      io.writeFile(values.out, text);
    } catch (e) {
      io.stderr(`cannot write ${values.out}: ${messageOf(e)}\n`);
      return 2;
    }
  } else {
    io.stdout(text);
  }
  return values.strict && problems.some((p) => p.severity === 'error') ? 1 : 0;
}
