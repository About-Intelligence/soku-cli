/** Output + exit-code conventions shared by every command.
 *
 * Agents/pipes get JSON (`!isTty()`); humans at a terminal get a readable view
 * (tables, friendly lines). Pass a `human` renderer to `emitSuccess` for the
 * TTY view; without one it falls back to pretty JSON. Errors are a structured
 * envelope on stderr (JSON when piped, a colored line at a TTY) with a semantic
 * exit code.
 */

export const ExitCode = {
  OK: 0,
  USAGE: 1,
  AUTH: 2,
  NOT_FOUND: 4,
  RUNTIME: 5,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

export interface ErrorEnvelope {
  ok: false
  error: {
    type: string
    message: string
    hint?: string
  }
}

export function isTty(): boolean {
  return Boolean(process.stdout.isTTY)
}

// ── Minimal ANSI styling (no dependency); no-op when not a TTY ──────────────
function style(code: string, text: string): string {
  return isTty() ? `\x1b[${code}m${text}\x1b[0m` : text
}
export const bold = (t: string) => style('1', t)
export const dim = (t: string) => style('2', t)
export const green = (t: string) => style('32', t)
export const red = (t: string) => style('31', t)
export const cyan = (t: string) => style('36', t)

export interface Column {
  key: string
  header: string
}

type RecordValue = Record<string, unknown>

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g
/** Visible length, ignoring ANSI color escapes (so colored cells align). */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length
}
/** padEnd that accounts for invisible ANSI escapes in the value. */
function padVisible(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleLen(s)))
}

/** Render an aligned text table from a list of row objects. */
export function table(rows: Array<Record<string, unknown>>, columns: Column[]): string {
  if (rows.length === 0) return dim('(none)')
  const cell = (r: Record<string, unknown>, k: string): string => {
    const v = r[k]
    return v === null || v === undefined ? '' : String(v)
  }
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => visibleLen(cell(r, c.key)))),
  )
  const line = (cells: string[]): string =>
    cells.map((c, i) => padVisible(c, widths[i])).join('  ')
  const header = bold(line(columns.map((c) => c.header)))
  const body = rows.map((r) => line(columns.map((c) => cell(r, c.key)))).join('\n')
  return `${header}\n${body}`
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecordList(value: unknown[]): value is RecordValue[] {
  return value.every(isRecord)
}

function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return dim('(none)')
    if (value.every((item) => !isRecord(item) && !Array.isArray(item))) {
      return value.map(compactValue).join(', ')
    }
  }
  return JSON.stringify(value)
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function recordColumns(rows: RecordValue[]): Column[] {
  const keys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key)
      if (keys.length >= 6) break
    }
    if (keys.length >= 6) break
  }
  return keys.map((key) => ({ key, header: humanizeKey(key).toUpperCase() }))
}

function renderRecordList(rows: RecordValue[]): string {
  if (rows.length === 0) return dim('(none)')
  const columns = recordColumns(rows)
  const printableRows = rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column.key, compactValue(row[column.key])])),
  )
  return table(printableRows, columns)
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return dim('(no data)')
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return dim('(none)')
    if (isRecordList(value)) return renderRecordList(value)
    return value.map((item) => `- ${compactValue(item)}`).join('\n')
  }
  if (isRecord(value)) return renderRecord(value)
  return String(value)
}

function renderRecord(record: RecordValue): string {
  const entries = Object.entries(record)
  if (entries.length === 0) return dim('(empty)')

  return entries
    .map(([key, value]) => {
      const label = bold(humanizeKey(key))
      if (Array.isArray(value) && isRecordList(value)) {
        return `${label}\n${indent(renderRecordList(value))}`
      }
      if (isRecord(value)) {
        return `${label}\n${indent(renderRecord(value))}`
      }
      if (Array.isArray(value) && value.length > 0 && !value.every((item) => !isRecord(item) && !Array.isArray(item))) {
        return `${label}\n${indent(renderValue(value))}`
      }
      return `${label}: ${compactValue(value)}`
    })
    .join('\n')
}

export function renderHumanData(data: unknown): string {
  return renderValue(data)
}

/** Print a success result and exit 0.
 *
 * @param data    machine-readable payload (always used for the JSON/agent path)
 * @param human   optional renderer for the TTY view; receives `data`
 */
export function emitSuccess<T>(data: T, human?: (data: T) => string): never {
  return emitSuccessExit(data, ExitCode.OK, human)
}

/** Like {@link emitSuccess} but exits with an explicit code. Batch commands that
 * finish with partial failures emit a success-shaped summary (callers still want
 * the JSON results) but exit non-zero so scripts can detect the failures. */
export function emitSuccessExit<T>(
  data: T,
  code: ExitCodeValue,
  human?: (data: T) => string,
): never {
  if (!isTty()) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`)
  } else if (human) {
    process.stdout.write(`${human(data)}\n`)
  } else {
    process.stdout.write(`${renderHumanData(data)}\n`)
  }
  process.exit(code)
}

/** Print a structured error to stderr and exit with the given code. */
export function emitError(
  type: string,
  message: string,
  code: ExitCodeValue = ExitCode.RUNTIME,
  hint?: string,
): never {
  if (isTty()) {
    let out = `${red('✖')} ${message}`
    if (hint) out += `\n  ${dim(hint)}`
    process.stderr.write(`${out}\n`)
  } else {
    const envelope: ErrorEnvelope = {
      ok: false,
      error: { type, message, ...(hint ? { hint } : {}) },
    }
    process.stderr.write(`${JSON.stringify(envelope)}\n`)
  }
  process.exit(code)
}
