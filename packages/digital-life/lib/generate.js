/**
 * One model call, shared by replies and spontaneous lines.
 *
 * Two provider differences are handled here instead of leaking into the two
 * call sites:
 *
 *  - `reasoningEffort`. DeepSeek defaults to the composition's agent effort
 *    (often "high"), and thinking tokens then compete with her tiny output
 *    budget, ending in an empty visible reply. So we ask for "off" — but routes
 *    without a declared effort mapping reject that outright, so a rejection
 *    retries once without the field and the route is remembered.
 *  - an empty visible reply when thinking did consume the budget. One retry
 *    with a larger budget; then a clear error instead of silent nothing.
 */

/** Routes that refused a reasoning-effort field, so we stop sending one. */
const noEffortRoutes = new Set()

/** Provider-qualified key for the effort memo. */
function routeKey(provider, model) {
  return `${provider}\u0000${model}`
}

/** Pull the terminal failure out of a finish chunk. */
function finishFailure(finish) {
  const reason = finish?.reason
  if (reason === undefined || reason === null) return null
  const kind = typeof reason === 'string' ? reason : reason.kind
  if (kind !== 'error' && kind !== 'aborted') return null
  const failure = (typeof reason === 'object' ? reason.failure : undefined) ?? finish?.failure
  return { code: String(failure?.code ?? kind), message: String(failure?.message ?? '') }
}

/** One streaming attempt. Returns text plus the terminal failure, if any. */
async function attempt({ llm, provider, model, system, messages, temperature, maxTokens, effort }) {
  const options = {
    provider,
    model,
    system,
    messages,
    temperature,
    maxTokens
  }
  if (effort !== undefined && effort !== null) options.reasoningEffort = effort
  let text = ''
  let failure = null
  const stream = llm.stream(options)
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish') failure = finishFailure(chunk)
  }
  return { text, failure, options }
}

/**
 * Call the model once, with the provider quirks absorbed.
 *
 * @param {object} input - call description.
 * @param {object} input.llm - the `llm` service.
 * @param {string} input.provider - route name.
 * @param {string} input.model - model id.
 * @param {string} input.system - the whole system prompt.
 * @param {Array<object>} input.messages - request messages (user role only).
 * @param {number} [input.temperature] - sampling temperature.
 * @param {number} [input.maxTokens] - output budget.
 * @param {string | null} [input.reasoningEffort] - preferred effort; null omits it.
 * @returns {Promise<{ ok: boolean, text?: string, error?: string, options?: object, retried?: string }>}
 */
export async function generate(input) {
  const { llm, provider, model } = input
  const key = routeKey(provider, model)
  const preferred = input.reasoningEffort === null
    ? undefined
    : input.reasoningEffort ?? (noEffortRoutes.has(key) ? undefined : 'off')

  let result
  try {
    result = await attempt({ ...input, effort: preferred })
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }

  // A route with no effort mapping rejects the field itself.
  if (result.failure !== null && result.failure.code === 'UNSUPPORTED_REASONING_EFFORT' && preferred !== undefined) {
    noEffortRoutes.add(key)
    try {
      const retry = await attempt({ ...input, effort: undefined })
      result = retry
      if (retry.failure === null && retry.text.trim() !== '') {
        return { ok: true, text: retry.text, options: retry.options, retried: 'without-reasoning-effort' }
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  if (result.failure !== null) {
    return { ok: false, error: `${result.failure.code}${result.failure.message === '' ? '' : `: ${result.failure.message}`}` }
  }
  if (result.text.trim() !== '') {
    return { ok: true, text: result.text, options: result.options }
  }

  // Empty but not failed: thinking most likely ate the budget. One bigger try.
  try {
    const retry = await attempt({
      ...input,
      effort: preferred,
      maxTokens: Math.max(600, Number(input.maxTokens ?? 0) * 3)
    })
    if (retry.failure !== null) {
      return { ok: false, error: `${retry.failure.code}${retry.failure.message === '' ? '' : `: ${retry.failure.message}`}` }
    }
    if (retry.text.trim() !== '') {
      return { ok: true, text: retry.text, options: retry.options, retried: 'with-a-larger-budget' }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  return { ok: false, error: '模型返回了空内容（可能是思考 token 吃光了输出预算）' }
}
