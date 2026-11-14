// Produces a deterministic refactor result for scripted Harness processes.
export function answer(prompt) {
  if (!prompt.startsWith('PLAN')) return { summary: 'Keep the existing code.', changes: [], deferred: [] }
  const inventory = prompt.split('\n').find(line => line.startsWith('Inventory: '))
  const files = JSON.parse(inventory.slice('Inventory: '.length))
  return { summary: 'One module', modules: [{ id: 'main', name: 'Main', description: 'Entry point', files }] }
}

export function respond(prompt) {
  return JSON.stringify(answer(prompt))
}
