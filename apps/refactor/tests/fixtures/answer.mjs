/** Build scripted structured output for ACP's MCP submission, AHP's final message and Claude's
 * fake SDK result. Planning prompts must carry an Inventory JSON line. Malformed fixtures throw
 * so a peer cannot complete planning with an invented inventory. */
export function answer(prompt) {
  if (!prompt.startsWith('PLAN')) return { summary: 'Keep the existing code.', changes: [], deferred: [] }
  const inventory = prompt.split('\n').find(line => line.startsWith('Inventory: '))
  const files = JSON.parse(inventory.slice('Inventory: '.length))
  return { summary: 'One module', modules: [{ id: 'main', name: 'Main', description: 'Entry point', files }] }
}

/** The Hermes fake gateway calls this to put the same scripted result in a completed text turn.
 * Planning input errors propagate from answer. */
export function respond(prompt) {
  return JSON.stringify(answer(prompt))
}
