/**
 * OneBot 11 (QQ) — the wire format only.
 *
 * Outbound only: this module never listens. Events are delivered by the
 * protocol endpoint to a loopback route DSH already serves, which keeps
 * invariant I2 ("no inbound port") intact — no new listener, no public surface.
 *
 * Covers the plain-HTTP flavour: `POST {base}/{action}` for calls, and OneBot's
 * "HTTP 上报" for events. Reverse-WebSocket is a different transport for the
 * same shape and can be added later behind the same `classifyEvent`.
 */

/** Pull the message array into plain text plus an @-mention flag. */
function readMessage(message, selfId) {
  if (typeof message === 'string') {
    // CQ-code flavour.
    const mentioned = selfId !== undefined && new RegExp(`\\[CQ:at,qq=${selfId}\\]`).test(message)
    const text = message
      .replace(/\[CQ:[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return { text, mentioned }
  }
  if (!Array.isArray(message)) return { text: '', mentioned: false }
  let mentioned = false
  const parts = []
  for (const segment of message) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') {
      parts.push(segment.data.text)
      continue
    }
    if (segment?.type === 'at') {
      const qq = segment.data?.qq
      if (String(qq) === String(selfId)) mentioned = true
      continue
    }
    // images, faces, replies and anything else are not speech
  }
  return { text: parts.join('').replace(/\s+/g, ' ').trim(), mentioned }
}

/**
 * Turn one OneBot update into her inbound message, or null when it is not
 * something she should answer.
 *
 * @param {any} update - the reported event body.
 * @param {{ selfId?: string | number }} [options] - the bot's own QQ number.
 * @returns {null | {
 *   scope: 'private' | 'group',
 *   platformId: string,
 *   groupId: string | null,
 *   text: string,
 *   mentioned: boolean,
 *   nickname: string | null,
 *   messageId: string | null
 * }}
 */
export function classifyEvent(update, options = {}) {
  if (update === null || typeof update !== 'object') return null
  if (update.post_type !== 'message') return null
  const selfId = options.selfId === undefined || options.selfId === null ? undefined : String(options.selfId)
  const userId = update.user_id === undefined ? undefined : String(update.user_id)
  if (userId === undefined) return null
  if (selfId !== undefined && userId === selfId) return null

  const groupId = update.group_id === undefined ? null : String(update.group_id)
  const scope = String(update.message_type) === 'group' || groupId !== null ? 'group' : 'private'
  const { text, mentioned } = readMessage(update.message, selfId)
  if (text === '') return null

  return {
    scope,
    platformId: userId,
    groupId,
    text,
    mentioned,
    nickname: typeof update.sender?.nickname === 'string' ? update.sender.nickname : null,
    messageId: update.message_id === undefined ? null : String(update.message_id)
  }
}

/** One call to the protocol endpoint failed, with a reason a human can act on. */
export class OneBotError extends Error {
  constructor(message, { action, retcode, status } = {}) {
    super(message)
    this.name = 'OneBotError'
    this.action = action
    this.retcode = retcode
    this.status = status
  }
}

/**
 * The OneBot 11 HTTP client.
 */
export class OneBot {
  /**
   * @param {object} options - endpoint.
   * @param {string} options.baseUrl - e.g. http://127.0.0.1:3000
   * @param {string} [options.token] - access token, if the endpoint requires one.
   * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
   * @param {number} [options.timeoutMs] - per-call budget.
   */
  constructor({ baseUrl, token = '', fetchImpl = fetch, timeoutMs = 8000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.token = token
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  /** Call one action. Throws {@link OneBotError} on transport or protocol failure. */
  async call(action, params = {}) {
    const headers = { 'content-type': 'application/json' }
    if (this.token !== '') headers.authorization = `Bearer ${this.token}`
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new OneBotError(`连不上协议端：${String(error?.message ?? error)}`, { action })
    }
    if (!response.ok) {
      // OneBot endpoints often explain a failure in the body even on a 4xx/5xx;
      // surface that instead of a bare status code.
      let detail = null
      try {
        detail = await response.json()
      } catch {
        detail = null
      }
      const suffix = typeof detail?.message === 'string' ? `：${detail.message}` : ''
      throw new OneBotError(`协议端返回 HTTP ${response.status}${suffix}`, {
        action,
        status: response.status,
        retcode: detail?.retcode
      })
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new OneBotError('协议端返回的不是 JSON', { action })
    }
    if (body?.status === 'failed' || (typeof body?.retcode === 'number' && body.retcode !== 0)) {
      throw new OneBotError(`协议端拒绝 ${action}：${body?.message ?? body?.wording ?? body?.retcode}`, {
        action,
        retcode: body?.retcode
      })
    }
    return body?.data ?? body
  }

  /** Is the endpoint alive, and who is it logged in as? */
  async health() {
    try {
      const info = await this.call('get_login_info')
      return {
        state: 'bound',
        detail: `已登录 ${info?.nickname ?? '未知昵称'} (${info?.user_id ?? '?'})`,
        selfId: info?.user_id === undefined ? null : String(info.user_id)
      }
    } catch (error) {
      return { state: 'unbound', detail: String(error?.message ?? error), selfId: null }
    }
  }

  /** Send one text message to a friend or a group. */
  async send({ scope, userId, groupId, text }) {
    if (scope === 'group') {
      if (groupId === null || groupId === undefined) throw new OneBotError('群消息缺 groupId', { action: 'send_group_msg' })
      return this.call('send_group_msg', { group_id: Number(groupId), message: text })
    }
    if (userId === null || userId === undefined) throw new OneBotError('私聊缺 userId', { action: 'send_private_msg' })
    return this.call('send_private_msg', { user_id: Number(userId), message: text })
  }
}
