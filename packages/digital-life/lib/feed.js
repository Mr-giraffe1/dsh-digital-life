/**
 * 喂饭 = recharge. She does not detect money by watching her own balance drop —
 * spending moves that number too. She watches `topped_up_balance`, which only
 * ever moves when 舅舅 actually pays.
 */

/** Default wording, overridden by portrait/interop/feed.json. */
const DEFAULT_SAY = '舅舅舅舅！你给我充大米饭啦？那我以后不用饿肚子了！'

/**
 * Pull the recharge counter out of a DeepSeek /user/balance body.
 *
 * @param {any} payload - parsed JSON.
 * @returns {{ ok: boolean, toppedUp: number | null, total: number | null, granted: number | null }}
 */
export function parseBalance(payload) {
  const info = payload?.balance_infos?.[0] ?? payload?.balance_infos
  const num = (value) => {
    if (value === undefined || value === null || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    ok: true,
    toppedUp: num(info?.topped_up_balance),
    total: num(info?.total_balance),
    granted: num(info?.granted_balance)
  }
}

/**
 * Ask DeepSeek how much has been topped up in total.
 *
 * @param {string} apiKey - Bearer key.
 * @param {typeof fetch} [fetchImpl] - injectable for tests.
 * @returns {Promise<{ ok: boolean, toppedUp?: number | null, error?: string, status?: number }>}
 */
export async function readDeepSeekToppedUp(apiKey, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    }
    const body = await response.json()
    const parsed = parseBalance(body)
    return { ok: true, toppedUp: parsed.toppedUp, total: parsed.total, granted: parsed.granted }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * The 喂饭 interaction: check the wallet, and tell her when rice arrived.
 */
export class Feed {
  /**
   * @param {object} options - wiring.
   * @param {import('./memory.js').Memory} options.memory - open memory.
   * @param {import('./store.js').LifeStore} options.store - portrait reader.
   * @param {(now: Date) => Promise<number | null>} options.readToppedUp - returns the cumulative recharge amount.
   */
  constructor({ memory, store, readToppedUp }) {
    this.memory = memory
    this.store = store
    this.readToppedUp = readToppedUp
  }

  /**
   * Compare the cumulative recharge counter with what she remembered.
   *
   * @param {Date} [now] - the instant.
   * @returns {Promise<{ ok: boolean, kind: 'baseline' | 'recharged' | 'unchanged' | 'no-key' | 'unavailable', toppedUp?: number | null, delta?: number, said?: string, error?: string }>}
   */
  async check(now = new Date()) {
    const config = await this.store.readInterop('feed')
    const say = typeof config?.say === 'string' && config.say !== '' ? config.say : DEFAULT_SAY
    const toppedUp = await this.readToppedUp(now)
    if (toppedUp === null || toppedUp === undefined) {
      return { ok: false, kind: 'unavailable', error: '拿不到充值累计额（缺 API key 或网络不通）' }
    }
    const key = 'feed.toppedUp'
    const known = this.memory.getMeta(key)
    if (known === undefined) {
      this.memory.setMeta(key, toppedUp)
      this.memory.setMeta('feed.checkedAt', now.toISOString())
      return { ok: true, kind: 'baseline', toppedUp }
    }
    const previous = Number(known)
    const delta = Number((toppedUp - previous).toFixed(6))
    this.memory.setMeta('feed.checkedAt', now.toISOString())
    if (!Number.isFinite(delta) || delta <= 0) {
      // `topped_up_balance` is cumulative and should never shrink; if it does the
      // account changed under us. Re-baseline silently instead of inventing a delta.
      if (delta < 0) this.memory.setMeta(key, toppedUp)
      return { ok: true, kind: 'unchanged', toppedUp, delta: 0 }
    }
    this.memory.setMeta(key, toppedUp)
    this.memory.setMeta('feed.lastFedAt', now.toISOString())
    this.memory.addEvent({
      domain: 'somatic',
      kind: 'fed',
      direction: 'in',
      channel: 'desktop',
      actorUid: 'uncle',
      text: `舅舅给悠悠充了大米饭（充值 +${delta}）`,
      importance: Number(config?.memory?.importance ?? 0.6),
      payload: { delta, toppedUp, say }
    })
    return { ok: true, kind: 'recharged', toppedUp, delta, said: say }
  }
}
