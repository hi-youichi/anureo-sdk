/**
 * Bounded stderr capture for spawned ACP agents.
 *
 * The adapter never forwards raw stderr to callers: provider output can contain
 * credentials, prompts, or absolute paths. We retain a short redacted tail only,
 * attached to failures so a startup crash stays diagnosable.
 */

const LINE_LIMIT = 8 * 1024;
const TOTAL_LIMIT = 32 * 1024;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)\S+/gi, '$1[redacted]'],
  [/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@'],
];

export function redactLine(line: string): string {
  let value = line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line;
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  return value;
}

/** FIFO ring of already-redacted lines with a hard byte budget. */
export class StderrTail {
  private readonly lines: string[] = [];
  private bytes = 0;
  private partial = '';
  constructor(
    private readonly limit: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  push(line: string): void {
    if (this.limit <= 0) return;
    const redacted = redactLine(line);
    try { this.onLine?.(redacted); } catch { /* a consumer callback must not break draining */ }
    this.bytes += redacted.length + 1;
    this.lines.push(redacted);
    while (this.lines.length > this.limit || this.bytes > TOTAL_LIMIT) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.bytes -= dropped.length + 1;
    }
  }

  /** Accepts arbitrary chunks, buffering the trailing partial line. */
  write(chunk: string): void {
    if (this.limit <= 0) return;
    this.partial += chunk;
    for (let index = this.partial.indexOf('\n'); index >= 0; index = this.partial.indexOf('\n')) {
      this.push(this.partial.slice(0, index));
      this.partial = this.partial.slice(index + 1);
    }
    // A child that never emits a newline must not grow the buffer without bound.
    if (this.partial.length > LINE_LIMIT) {
      this.push(this.partial);
      this.partial = '';
    }
  }

  /** Flushes the trailing partial line; call once the stream ends. */
  flush(): void {
    if (!this.partial) return;
    this.push(this.partial);
    this.partial = '';
  }

  /** Rendered tail, oldest first. Empty when capture is disabled or nothing arrived. */
  text(): string {
    return this.lines.join('\n');
  }

  get size(): number {
    return this.lines.length;
  }
}
