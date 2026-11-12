/** Prints the models Pi can use with the credentials in the environment (no prompt is sent). */
import { createPiCatalogSession } from '../src/index'

const { models } = await createPiCatalogSession({})
for (const model of models) console.log(model.ref, model.reasoning ? '(reasoning)' : '')
console.log(`${models.length} model(s)`)
