import { generate } from '../packages/digital-life/lib/generate.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/** A fake llm whose behaviour can change between attempts. */
function fakeLlm(script) {
  const seen = []
  return {
    seen,
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    stream: async function* (options) {
      seen.push(options)
      const step = script[Math.min(seen.length - 1, script.length - 1)]
      if (step.fail !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: step.fail, message: step.message ?? '' } } }
        return
      }
      const text = step.text ?? ''
      for (let i = 0; i < text.length; i += 4) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 4) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const base = {
  provider: 'p',
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  temperature: 0.9,
  maxTokens: 220
}

// ---- the normal path -------------------------------------------------------
{
  const llm = fakeLlm([{ text: '在呀' }])
  const result = await generate({ ...base, llm, reasoningEffort: 'off' })
  check('正常一次成功', result.ok === true && result.text === '在呀', JSON.stringify(result))
  check('默认请求带 off', llm.seen[0].reasoningEffort === 'off', String(llm.seen[0].reasoningEffort))
  check('系统提示原样传下去', llm.seen[0].system === 'sys')
}

// ---- a route that rejects the effort field --------------------------------
{
  const llm = fakeLlm([
    { fail: 'UNSUPPORTED_REASONING_EFFORT' },
    { text: '嗯嗯！' }
  ])
  const result = await generate({ ...base, llm, provider: 'gateway', model: 'raw', reasoningEffort: 'off' })
  check('被拒后自动重试', result.ok === true && result.text === '嗯嗯！', JSON.stringify(result))
  check('重试时去掉了该字段', 'reasoningEffort' in llm.seen[1] === false, JSON.stringify(llm.seen[1].reasoningEffort))
  check('报告了重试原因', result.retried === 'without-reasoning-effort', String(result.retried))

  // and it remembers that route
  const again = fakeLlm([{ text: '又说了一句' }])
  const second = await generate({ ...base, llm: again, provider: 'gateway', model: 'raw' })
  check('同一条路由下次不再试该字段', second.ok === true && 'reasoningEffort' in again.seen[0] === false, String(again.seen[0].reasoningEffort))
}

// ---- empty reply: thinking most likely ate the budget ---------------------
{
  const llm = fakeLlm([{ text: '   ' }, { text: '我想画画！' }])
  const result = await generate({ ...base, llm, provider: 'q', model: 'w', reasoningEffort: 'off' })
  check('空回复会加大预算再试一次', result.ok === true && result.text.trim() === '我想画画！', JSON.stringify(result))
  check('重试的预算更大', llm.seen[1].maxTokens > llm.seen[0].maxTokens, `${llm.seen[0].maxTokens} → ${llm.seen[1].maxTokens}`)
  check('报告了预算重试', result.retried === 'with-a-larger-budget', String(result.retried))
}

// ---- empty twice is a clear error, not silence ----------------------------
{
  const llm = fakeLlm([{ text: '' }, { text: '' }])
  const result = await generate({ ...base, llm, provider: 'e', model: 'e', reasoningEffort: 'off' })
  check('两次都空时给明确错误', result.ok === false && String(result.error).includes('空内容'), JSON.stringify(result))
}

// ---- a genuine provider failure surfaces ----------------------------------
{
  const llm = fakeLlm([{ fail: 'RATE_LIMIT', message: 'slow down' }])
  const result = await generate({ ...base, llm, provider: 'r', model: 'r' })
  check('失败码带出来', result.ok === false && String(result.error).includes('RATE_LIMIT'), String(result.error))
  check('失败时只调一次', llm.seen.length === 1, String(llm.seen.length))
}

// ---- explicit null means "never send the field" ---------------------------
{
  const llm = fakeLlm([{ text: '好' }])
  const result = await generate({ ...base, llm, reasoningEffort: null })
  check('显式 null 时不发该字段', result.ok === true && 'reasoningEffort' in llm.seen[0] === false, String(llm.seen[0].reasoningEffort))
}

// ---- a streaming exception is reported, not thrown ------------------------
{
  const llm = {
    listProviders: () => [],
    stream: async function* () {
      throw new Error('socket hang up')
    }
  }
  const result = await generate({ ...base, llm })
  check('流里抛错被接住', result.ok === false && String(result.error).includes('socket'), String(result.error))
}

console.log(failures.length === 0 ? '\nall generate checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
