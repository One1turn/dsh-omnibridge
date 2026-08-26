/**
 * dsh-omnibridge channel: Telegram（Bot API long polling）。
 *
 * 零依赖，仅用内置 fetch。需要先向 @BotFather 申请 token。
 *
 * target 约定：chat_id（字符串数字或频道 @id）
 *
 * @module dsh-omnibridge/channels/telegram
 */

import { Channel, InboundMessage, splitForDelivery } from '../bridge-core.mjs'

export class TelegramChannel extends Channel {
  constructor(config) {
    super('telegram', config)
    this.offset = 0
    this.pollTimer = null
    this.closed = false
  }

  get token() {
    return this.config.token || ''
  }

  get api() {
    return this.config.apiBase || `https://api.telegram.org/bot${this.token}`
  }

  async call(method, params, timeoutMs = 10000) {
    const url = `${this.api}/${method}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) throw new Error(`Telegram ${method} -> ${resp.status}`)
    const data = await resp.json()
    if (!data.ok) throw new Error(`Telegram ${method} -> ${data.description || 'unknown error'}`)
    return data.result
  }

  async start(ctx, bridge) {
    if (!this.token) {
      throw new Error('telegram channel 缺少 token（BotFather 申请）')
    }
    this.ctx = ctx
    this.bridge = bridge
    this.closed = false
    // 启动即校验 token，坏 token 直接抛错（而不是进入每秒报错的轮询循环）
    const me = await this.call('getMe', {}, 10000)
    this.username = me?.username ? `@${me.username}` : ''
    this.ctx?.logger?.info?.('[dsh-omnibridge:telegram] bot 已连接 %s', this.username || `(id ${me?.id ?? '?'})`)
    // 清掉旧 offset 前的挂起更新
    await this.call('getUpdates', { offset: -1, timeout: 1 }).catch(() => {})
    this.poll()
  }

  async poll() {
    if (this.closed) return
    let delay = this.config.pollIntervalMs || 1000
    try {
      const updates = await this.call('getUpdates', {
        offset: this.offset,
        timeout: 30,
        allowed_updates: ['message'],
      })
      for (const up of updates) {
        this.offset = Math.max(this.offset, up.update_id + 1)
        this.handleUpdate(up)
      }
      this.errorStreak = 0
    } catch (error) {
      // 连续失败指数退避（上限 30s），避免坏 token/断网时每秒刷日志
      this.errorStreak = (this.errorStreak || 0) + 1
      const factor = Math.min(8, 2 ** this.errorStreak)
      const jitter = 0.8 + Math.random() * 0.4 // 0.8~1.2，避免多实例同步"惊群"
      delay = Math.min(30000, Math.floor(delay * factor * jitter))
      this.ctx?.logger?.warn?.('[dsh-omnibridge:telegram] poll error (%d 连续): %s', this.errorStreak, error instanceof Error ? error.message : String(error))
    } finally {
      if (!this.closed) {
        this.pollTimer = setTimeout(() => this.poll(), delay)
        this.pollTimer.unref?.()
      }
    }
  }

  handleUpdate(up) {
    const msg = up.message
    if (!msg) return
    if (msg.from?.is_bot) return
    const text = String(msg.text ?? '').trim()
    if (!text) return
    const chatId = String(msg.chat?.id ?? '')
    if (!chatId) return
    this.bridge.handleInbound(new InboundMessage({
      platform: 'telegram',
      sessionKey: `tg:${chatId}`,
      senderId: String(msg.from?.id ?? chatId),
      senderName: msg.from?.first_name || msg.from?.username || String(msg.from?.id ?? ''),
      text,
      raw: { target: chatId, messageId: msg.message_id },
    })).catch(() => {})
  }

  /** 发送文本。target = chat_id。Telegram 单条上限 4096 字符，超长自动分块。 */
  async send(target, text) {
    const max = 4000 // 留余量（实体长度计入）
    const chunks = splitForDelivery(text, max)
    for (const chunk of chunks) {
      await this.call('sendMessage', { chat_id: target, text: chunk })
    }
  }

  async stop() {
    this.closed = true
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }
}
