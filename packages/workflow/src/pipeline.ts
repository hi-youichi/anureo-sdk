/**
 * Run each input through sequential stages, letting items advance independently without a stage barrier.
 * Each stage receives the awaited input or prior result, the original unawaited input entry and its
 * zero-based index. Inline stages infer their input types through six stages. Longer chains can
 * use typed functions that accept the preceding stage's awaited, non-null result.
 *
 * The promise resolves after all item chains settle and returns their final values in input order.
 * A null input or stage result skips the remaining stages for that item. A rejected input, thrown
 * stage error or rejected stage result also skips the remaining stages and yields null for that item.
 * Sibling chains continue after a failure. Other falsy values advance normally. With zero stages,
 * return awaited inputs with rejections as null.
 *
 * Handle input and stage failures before they reach the pipeline if you need the original cause.
 * Arrange any concurrency limits, cancellation, retries and resource cleanup for input work and stages.
 *
 * A non-array input rejects with TypeError. The function snapshots the array and resolves to []
 * for an empty snapshot. For nonempty input, a non-function stage rejects with TypeError before
 * item processing starts.
 */
export function pipeline<Input>(items: readonly Input[]): Promise<(Awaited<Input> | null)[]>
export function pipeline<A, B>(items: readonly A[], first: Stage<A, A, B>): Promise<(Awaited<B> | null)[]>
export function pipeline<A, B, C>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
): Promise<(Awaited<C> | null)[]>
export function pipeline<A, B, C, D>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>,
): Promise<(Awaited<D> | null)[]>
export function pipeline<A, B, C, D, E>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>, fourth: Stage<D, A, E>,
): Promise<(Awaited<E> | null)[]>
export function pipeline<A, B, C, D, E, F>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>, fourth: Stage<D, A, E>, fifth: Stage<E, A, F>,
): Promise<(Awaited<F> | null)[]>
export function pipeline<A, B, C, D, E, F, G>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>, fourth: Stage<D, A, E>,
  fifth: Stage<E, A, F>, sixth: Stage<F, A, G>,
): Promise<(Awaited<G> | null)[]>
/** Use a chain of typed stages of any length, with each stage checked against its predecessor. */
export function pipeline<Input, Outputs extends readonly unknown[]>(
  items: readonly Input[],
  ...stages: Stages<Input, Outputs> & { 0: Stage<Input, Input, unknown> }
): Promise<(LastAwaitedOutput<Outputs> | null)[]>
export async function pipeline(
  items: readonly unknown[],
  ...stages: Stage<never, never, unknown>[]
): Promise<unknown[]> {
  if (!Array.isArray(items)) throw new TypeError('pipeline expects an array as the first argument')
  const inputs = [...items]
  if (!inputs.length) return []
  if (stages.some(stage => typeof stage !== 'function')) throw new TypeError('pipeline stages must be functions')
  // The overloads check compatibility between adjacent stages. The runner only needs their order.
  const itemStages = stages as unknown as readonly Stage<unknown, unknown, unknown>[]
  const results = await Promise.allSettled(
    inputs.map((originalItem, index) => runItem(originalItem, index, itemStages)),
  )
  return results.map(result => result.status === 'fulfilled' ? result.value : null)
}

/** Run one item chain with its original entry and index. A null value ends the chain early.
 * Input and stage errors reject the chain so pipeline can preserve its slot as null. */
async function runItem(
  originalItem: unknown,
  index: number,
  stages: readonly Stage<unknown, unknown, unknown>[],
): Promise<unknown> {
  let value = await originalItem
  for (const stage of stages) {
    if (value === null) break
    value = await stage(value, originalItem, index)
  }
  return value
}

/** Align each stage with its predecessor's output by prepending the original input type. */
type PreviousStageOutput<Input, Outputs extends readonly unknown[], K> =
  K extends '0' ? Input : [Input, ...Outputs][K & keyof [Input, ...Outputs]]

/** Check each variadic stage against the preceding output while retaining the original input context. */
type Stages<Input, Outputs extends readonly unknown[]> = {
  [K in keyof Outputs]: Stage<PreviousStageOutput<Input, Outputs, K>, Input, Outputs[K]>
}

/** Infer the pipeline's resolved value type from the final stage of a typed chain. */
type LastAwaitedOutput<Outputs extends readonly unknown[]> =
  Outputs extends readonly [...unknown[], infer Output] ? Awaited<Output> : never

/** Exclude only null from a stage's awaited input because null short-circuits the item at runtime. */
type Stage<Previous, Input, Output> = (value: Exclude<Awaited<Previous>, null>, originalItem: Input, index: number) => Output
