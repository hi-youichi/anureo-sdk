// Bounds the stderr tail included in ACP failure diagnostics and filters recognized credentials.

export const DEFAULT_STDERR_TAIL_LINES = 200;

/**
 * Prepare one stderr line for StderrTail.push. Redact recognized credential patterns before
 * truncating to 8,192 UTF-16 code units plus an ellipsis when needed.
 */
export function redactLine(line: string): string {
  let value = line;
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  return value.length > LINE_CODE_UNIT_LIMIT ? `${value.slice(0, LINE_CODE_UNIT_LIMIT)}…` : value;
}

/**
 * Buffer decoded stderr for captureStderr. The tail keeps at most 32,768 UTF-16 code units
 * of redacted text, counting each retained line's length plus one for its separator.
 */
export class StderrTail {
  /**
   * Set the retained line limit. A nonpositive limit disables capture and the optional synchronous
   * onLine callback. Callback throws are ignored so captureStderr can keep draining.
   */
  constructor(
    private readonly maxLines: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  /** Redact one line and notify onLine before updating the tail. Evict oldest entries to enforce both bounds. */
  push(line: string): void {
    if (this.maxLines <= 0) return;
    const redacted = redactLine(line);
    try { this.onLine?.(redacted); } catch { /* a consumer callback must not break draining */ }
    this.retainedCodeUnits += redacted.length + 1;
    this.lines.push(redacted);
    while (this.lines.length > this.maxLines || this.retainedCodeUnits > TOTAL_CODE_UNIT_LIMIT) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.retainedCodeUnits -= dropped.length + 1;
    }
  }

  /**
   * Buffer decoded stderr across chunks and publish each LF-delimited line.
   * Replace an oversized unterminated line with a marker and discard its continuation through the next LF.
   */
  write(chunk: string): void {
    if (this.maxLines <= 0) return;
    if (this.discardingLine) {
      const index = chunk.indexOf('\n');
      if (index < 0) return;
      this.discardingLine = false;
      chunk = chunk.slice(index + 1);
    }
    this.partial += chunk;
    for (let index = this.partial.indexOf('\n'); index >= 0; index = this.partial.indexOf('\n')) {
      this.push(this.partial.slice(0, index));
      this.partial = this.partial.slice(index + 1);
    }
    // A child that never emits a newline must not grow the buffer without bound.
    if (this.partial.length > LINE_CODE_UNIT_LIMIT) {
      this.partial = '';
      this.discardingLine = true;
      this.push('[stderr line truncated]');
    }
  }

  /** Publish and clear any buffered fragment. captureStderr calls this when draining ends. */
  flush(): void {
    if (this.partial) this.push(this.partial);
    this.partial = '';
    this.discardingLine = false;
  }

  /** Rendered tail, oldest first. Empty when capture is disabled or nothing arrived. */
  text(): string {
    return this.lines.join('\n');
  }

  /** Number of retained lines, excluding a buffered partial line. */
  get size(): number {
    return this.lines.length;
  }
  private readonly lines: string[] = [];
  private retainedCodeUnits = 0;
  private partial = '';
  private discardingLine = false;
}

const LINE_CODE_UNIT_LIMIT = 8 * 1024;
const TOTAL_CODE_UNIT_LIMIT = 32 * 1024;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)\S+/gi, '$1[redacted]'],
];
