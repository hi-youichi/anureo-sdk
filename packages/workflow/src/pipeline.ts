/**
 * Run each input through sequential stages at its own pace. Each stage receives the awaited input
 * or prior result, the original array entry as supplied and its zero-based index in the snapshot.
 * Inline stages infer their input types through six stages. Longer chains can use typed functions
 * that accept the preceding stage's awaited result with `null` excluded.
 *
 * The promise resolves after all item chains settle and returns their final values in input order.
 * An input or stage that resolves to `null` or rejects ends that item's chain with `null`.
 * A synchronous stage throw has the same effect. Sibling chains continue after a failure,
 * and other falsy values advance normally. With zero stages, return awaited inputs with
 * rejections as `null`.
 *
 * Handle input and stage failures before they reach the pipeline to retain the original cause.
 * The caller owns concurrency limits, cancellation, retries and resource cleanup for input
 * work and stages. Return the work each stage needs the pipeline to await.
 *
 * A non-array input rejects with `TypeError`. The function snapshots the array and resolves to `[]`
 * for an empty snapshot. For nonempty input, a non-function stage rejects with `TypeError` before
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
/**
 * Run a nonempty chain of typed stages, checking each stage against its predecessor. Resolve
 * with the last stage's awaited results in input order, using `null` for failed or skipped items.
 */
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
  const orderedStages = stages as unknown as readonly Stage<unknown, unknown, unknown>[]
  const settledItems = await Promise.allSettled(
    inputs.map((originalItem, index) => runItem(originalItem, index, orderedStages)),
  )
  return settledItems.map(result => result.status === 'fulfilled' ? result.value : null)
}

/**
 * Advance one pipeline item by awaiting its input and each stage in turn. Pass the original
 * entry and snapshot index to every stage, and return early on `null`. Input rejections and
 * stage errors reject this chain so `pipeline` can collect `null` at the item's original position.
 */
async function runItem(
  originalItem: unknown,
  index: number,
  stages: readonly Stage<unknown, unknown, unknown>[],
): Promise<unknown> {
  let value = await originalItem
  for (const stage of stages) {
    if (value === null) return null
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
