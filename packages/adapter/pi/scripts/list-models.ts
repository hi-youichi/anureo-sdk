/** Print the models available under Pi's configured credentials. Catalog discovery sends no prompt. */
import { createPiCatalogSession } from '../src/index'

const { models } = await createPiCatalogSession()
for (const model of models) console.log(model.ref, model.reasoning ? '(reasoning)' : '')
console.log(`${models.length} model(s)`)
