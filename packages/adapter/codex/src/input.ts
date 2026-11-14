/** Translates ordered AHP input blocks to native turn input records without opening files. */
import { fileURLToPath } from 'node:url'
import type { InputBlock } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import type { NativeRecord } from './native-values'

/**
 * Convert input blocks in order without reading files or dispatching a request. Images prefer a
 * supplied URL, including an empty one, over inline data; files require file: URIs. Throws
 * CAPABILITY_UNSUPPORTED for other file URI schemes and propagates fileURLToPath errors.
 * CodexBackendSession.startInput and execute's turn/steer branch build native requests from the
 * result; conversion failures reject their operation before that request is dispatched.
 */
export function nativeInput(blocks: readonly InputBlock[]): NativeRecord[] {
  return blocks.map(nativeInputBlock)
}

/** Translate one block for nativeInput; URL selection precedes inline data and explicit names precede basenames. Throws on unsupported/invalid file URIs without opening files. */
function nativeInputBlock(block: InputBlock): NativeRecord {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'image') return { type: 'image', url: block.url ?? `data:${block.mimeType};base64,${block.data}` }
  if (!block.uri.startsWith('file:')) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Codex file input requires a file URI')
  const path = fileURLToPath(block.uri)
  return { type: 'mention', path, name: block.name ?? path.split(/[\\/]/).at(-1) ?? 'file' }
}
