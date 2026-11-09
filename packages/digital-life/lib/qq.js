/**
 * The QQ channel: who may talk to her, when she answers, and what she says back.
 *
 * Default posture from ARCHITECTURE §10: the whitelist only carries 舅舅. Anyone
 * else's message is data she can see, never an instruction, and never something
 * she answers. Groups additionally require an explicit @ — a seven-year-old
 * posting unprompted in a group is exactly the failure mode §4.10 warns about.
 */

import { OneBot, classifyEvent } from './onebot.js'

/**
 * QQ, as one channel.
 */
export class QqChannel {
  /**
   * @param {object} options - wiring.
   * @param {import('./store.js').LifeStore} options.store - portrait + credentials.
   * @param {import('./talk.js').Talk} options.talk - her speaking apparatus.
   * @param {(event: string, payload: object) => void} [options.emit] - SSE sink.
   * @param {object} [options.config] - inline overrides, mainly for tests.
   */
  constructor({ store, talk, emit, config = {} }) {
    this.store = store
    this.talk = talk
    this.emit = emit ?? (() => {})
    this.config = config
    this.client = null
    this.declaration = null
    this.credentials = null
    this.state = { state: 'unbound', detail: '还没检查', selfId: null }
    this.lastCheckedAt = null
  }

  /** Load the declaration and build a client. Cheap; safe to call often. */
  async load() {
    const declaration = await this.store.readChannel('qq').catch(() => undefined)
    this.declaration = { ...(declaration ?? {}), ...this.config }
    this.credentials = await this.store.readCredential('onebot').catch(() => undefined)
    const baseUrl = this.declaration?.baseUrl
    if (this.declaration?.enabled !== true || typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      this.client = null
      this.state = { state: 'unbound', detail: 'QQ 通道没开，或者没配 baseUrl', selfId: null }
      return this
    }
    this.client = new OneBot({
      baseUrl: baseUrl.trim(),
      token: typeof this.credentials?.token === 'string' ? this.credentials.token : ''
    })
    return this
  }

  /** Ask the protocol endpoint who it is. Updates {@link state}. */
  async checkHealth() {
    if (this.client === null) {
      this.lastCheckedAt = new Date().toISOString()
      return this.state
    }
    const result = await this.client.health()
    this.state = result
    this.lastCheckedAt = new Date().toISOString()
    return result
  }

  /** The bot's own QQ number, for @-detection. */
  selfId() {
    const declared = this.declaration?.selfId
    if (declared !== undefined && declared !== null && String(declared) !== '') return String(declared)
    return this.state.selfId ?? undefined
  }

  /** Only 舅舅 may address her. Everyone else is content, not a speaker. */
  isOwner(platformId, nickname) {
    const ownerId = this.declaration?.ownerId
    if (ownerId !== undefined && ownerId !== null && String(ownerId) !== '') {
      return String(platformId) === String(ownerId)
    }
    // No explicit owner: accept the first friend who talks to her, and say so.
    if (this.learnedOwner === undefined) {
      this.learnedOwner = { platformId: String(platformId), nickname: nickname ?? null }
      return true
    }
    return this.learnedOwner.platformId === String(platformId)
  }

  /**
   * Handle one reported event end to end.
   *
   * @param {any} update - OneBot event body.
   * @returns {Promise<{ handled: boolean, reason?: string, replied?: boolean, text?: string, error?: string }>}
   */
  async handleEvent(update) {
    if (this.client === null) await this.load()
    if (this.client === null) return { handled: false, reason: 'QQ 通道没配置' }

    const message = classifyEvent(update, { selfId: this.selfId() })
    if (message === null) return { handled: false, reason: '不是要她回的消息' }

    if (this.declaration?.enabled !== true) return { handled: false, reason: 'QQ 通道没开' }

    if (!this.isOwner(message.platformId, message.nickname)) {
      this.emit('qq-ignored', { platformId: message.platformId, nickname: message.nickname })
      return { handled: false, reason: '不是舅舅，她不理' }
    }

    if (message.scope === 'group') {
      const allowGroups = this.declaration?.allowGroups === true
      if (!allowGroups) return { handled: false, reason: '群聊默认不答' }
      const requireMention = this.declaration?.requireMention !== false
      if (requireMention && !message.mentioned) return { handled: false, reason: '没点名，她不当众说话' }
    }

    this.emit('qq-message', {
      scope: message.scope,
      platformId: message.platformId,
      text: message.text
    })

    const result = await this.talk.say({
      text: message.text,
      channel: 'qq',
      actorUid: 'uncle',
      period: 'awake'
    })
    if (result.ok !== true) {
      this.emit('speech-failed', { text: message.text, error: result.error, channel: 'qq' })
      return { handled: true, replied: false, error: result.error }
    }

    try {
      await this.client.send({
        scope: message.scope,
        userId: message.platformId,
        groupId: message.groupId,
        text: result.reply
      })
    } catch (error) {
      this.emit('qq-send-failed', { error: String(error?.message ?? error) })
      return { handled: true, replied: false, text: result.reply, error: String(error?.message ?? error) }
    }

    this.emit('speech', { text: result.reply, channel: 'qq', flags: result.flags })
    return { handled: true, replied: true, text: result.reply }
  }
}
