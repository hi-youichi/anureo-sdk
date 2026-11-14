/** Translates ordered AHP input blocks to native turn input records without opening files. */
import { fileURLToPath } from 'node:url'
import type { InputBlock } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import type { NativeRecord } from './native-values'

/**
 * Build native request input in block order without opening files. An explicit image URL,
 * including an empty one, takes precedence over inline data. Files become mentions using
 * their local path and explicit name, or the path's basename when the name is absent.
 *
 * A URI without a file: prefix throws CAPABILITY_UNSUPPORTED. Invalid file URLs propagate
 * fileURLToPath errors. CodexBackendSession.startInput uses the records in turn/start, and
 * CodexBackendSession.execute uses them in turn/steer. Conversion failures reject before
 * the corresponding turn request is sent.
 */
export function nativeInput(blocks: readonly InputBlock[]): NativeRecord[] {
  return blocks.map(nativeInputBlock)
}

/** Encode one native input record. File path conversion can throw before nativeInput returns its list. */
function nativeInputBlock(block: InputBlock): NativeRecord {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'image') {
    const url = block.url ?? `data:${block.mimeType};base64,${block.data}`
    return { type: 'image', url }
  }
  if (!block.uri.startsWith('file:')) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Codex file input requires a file URI')
  const path = fileURLToPath(block.uri)
  return { type: 'mention', path, name: block.name ?? path.split(/[\\/]/).at(-1) ?? 'file' }
}
