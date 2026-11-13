/** Translates ordered public input to native records; turn dispatch and file reads belong to callers. */
import { fileURLToPath } from 'node:url'
import type { InputBlock } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import type { NativeRecord } from './native-values'

/** For turn/steer builders, preserve block order without reading files. Throws CAPABILITY_UNSUPPORTED for non-file URIs and propagates fileURLToPath errors for invalid file URLs. */
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
