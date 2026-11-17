import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { HarnessSdkError, type TurnResult } from '@anureo/sdk'

export interface SwarmResultOptions { maxBytes?: number; maxTextBytesPerTask?: number }
export interface ResultDescriptor {
  resultRef: string; taskId: string; attemptId: string; status: TurnResult['status']
  availability: 'available' | 'omitted'; textBytes: number; preview: string; previewTruncated: boolean
  contentHash?: string; reason?: string
}

export function utf8End(bytes: Uint8Array, start: number, maxBytes: number) {
  let end = Math.min(bytes.length, start + maxBytes)
  if (end === bytes.length) return end
  while (end > start && (bytes[end] & 0xc0) === 0x80) end--
  return end
}

export function preview(text: string, maxBytes = 16 * 1024) {
  let prefix = text.slice(0, 12000)
  const last = prefix.charCodeAt(prefix.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1)
  const bytes = Buffer.from(prefix)
  const value = bytes.subarray(0, utf8End(bytes, 0, maxBytes)).toString('utf8')
  return { text: value, truncated: value.length < text.length }
}

/** Session-local immutable text objects. Cursors are authenticated and never interpreted as paths. */
export class ResultStore {
  private readonly entries = new Map<string, { descriptor: ResultDescriptor; bytes?: Buffer }>()
  private readonly secret = randomBytes(32)
  private size = 0
  private readonly limits: Required<SwarmResultOptions>

  constructor(options: SwarmResultOptions = {}) {
    this.limits = { maxBytes: options.maxBytes ?? 32 * 1024 * 1024, maxTextBytesPerTask: options.maxTextBytesPerTask ?? 8 * 1024 * 1024 }
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new HarnessSdkError('SWARM_INVALID_RESULT_LIMITS')
  }

  put(taskId: string, attemptId: string, result: TurnResult): ResultDescriptor {
    const bytes = Buffer.from(result.text)
    const validUnicode = !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result.text)
    const available = validUnicode && bytes.length <= this.limits.maxTextBytesPerTask && this.size + bytes.length <= this.limits.maxBytes
    const truncated = preview(validUnicode ? result.text : '')
    const descriptor: ResultDescriptor = {
      resultRef: randomUUID(), taskId, attemptId, status: result.status,
      availability: available ? 'available' : 'omitted', textBytes: bytes.length,
      preview: truncated.text, previewTruncated: truncated.truncated || !validUnicode,
      ...(available ? { contentHash: createHash('sha256').update(bytes).digest('hex') } : { reason: validUnicode ? 'SWARM_RESULT_CAPACITY' : 'SWARM_RESULT_ENCODING' }),
    }
    this.entries.set(descriptor.resultRef, { descriptor, ...(available ? { bytes } : {}) })
    if (available) this.size += bytes.length
    return structuredClone(descriptor)
  }

  read(resultRef: string, cursor: unknown, maxBytes: unknown) {
    const entry = this.entries.get(resultRef)
    if (!entry) throw new HarnessSdkError('SWARM_RESULT_EXPIRED')
    if (!entry.bytes) throw new HarnessSdkError('SWARM_RESULT_OMITTED', `SWARM_RESULT_OMITTED: ${entry.descriptor.reason}`)
    const limit = maxBytes === undefined ? 16 * 1024 : maxBytes
    if (!Number.isInteger(limit) || (limit as number) < 4 || (limit as number) > 32 * 1024) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
    const start = cursor === undefined ? 0 : this.decodeCursor(resultRef, cursor)
    if (start > entry.bytes.length || start < 0 || (start < entry.bytes.length && (entry.bytes[start] & 0xc0) === 0x80)) throw new HarnessSdkError('SWARM_INVALID_CURSOR')
    let end = utf8End(entry.bytes, start, limit as number)
    while (true) {
      const page = {
        resultRef, text: entry.bytes.subarray(start, end).toString('utf8'),
        ...(end < entry.bytes.length ? { nextCursor: this.encodeCursor(resultRef, end) } : {}),
        done: end === entry.bytes.length, totalBytes: entry.bytes.length, contentHash: entry.descriptor.contentHash!,
      }
      if (Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024) return page
      end = utf8End(entry.bytes, start, Math.floor((end - start) / 2))
    }
  }

  expire(resultRef: string) {
    const entry = this.entries.get(resultRef)
    if (entry?.bytes) this.size -= entry.bytes.length
    this.entries.delete(resultRef)
  }

  close() { this.entries.clear(); this.size = 0 }

  private encodeCursor(resultRef: string, offset: number) {
    const data = Buffer.from(JSON.stringify([resultRef, offset])).toString('base64url')
    return data + '.' + createHmac('sha256', this.secret).update(data).digest('base64url')
  }

  private decodeCursor(resultRef: string, cursor: unknown): number {
    try {
      if (typeof cursor !== 'string' || cursor.length > 1024) throw new Error()
      const [data, signature, extra] = cursor.split('.')
      const expected = createHmac('sha256', this.secret).update(data).digest()
      const actual = Buffer.from(signature, 'base64url')
      if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
      const value: unknown = JSON.parse(Buffer.from(data, 'base64url').toString())
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== resultRef || !Number.isSafeInteger(value[1])) throw new Error()
      return value[1]
    } catch { throw new HarnessSdkError('SWARM_INVALID_CURSOR') }
  }
}
