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
import { backoffDelayMs } from './retry.mjs'

/** poll 连续失败退避封顶。 */
const MAX_POLL_BACKOFF_MS = 30000
/** sendMessage 单条上限（Telegram 协议 4096，留实体长度余量）。 */
const SEND_MAX_CHARS = 4000

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
    this.selfId = me?.id != null ? String(me.id) : ''
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
      // 连续失败指数退避（封顶 MAX_POLL_BACKOFF_MS）：坏 token/断网时不再每秒刷日志，
      // 抖动避免多实例同时恢复后的同步惊群（公式统一走 channels/retry.mjs）
      this.errorStreak = (this.errorStreak || 0) + 1
      delay = backoffDelayMs(this.errorStreak, this.config.pollIntervalMs || 1000, MAX_POLL_BACKOFF_MS)
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

    // 图文消息：photo 取最大尺寸，caption 兼作正文（图片 URL 换取异步进行，失败降级纯文本）
    const photos = Array.isArray(msg.photo) ? msg.photo : []
    let imagePromise = null
    if (photos.length) {
      imagePromise = this._photoImageDescriptor([...photos]).catch((e) => {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:telegram] 照片地址获取失败: %s', e instanceof Error ? e.message : String(e))
        return null
      })
    }

    // 正文：文本消息用 text，媒体消息用 caption
    const text = String(msg.text ?? msg.caption ?? '').trim()
    if (!text && !photos.length) return
    const chatId = String(msg.chat?.id ?? '')
    if (!chatId) return

    // 群聊默认仅响应 @机器人 或回复机器人消息（对齐 AstrBot waking check）；
    // groupAtOnly=false 恢复全量响应。selfId 未就绪时放行，兼容启动初期窗口。
    const chatType = msg.chat?.type
    const isGroup = chatType === 'group' || chatType === 'supergroup'
    if (isGroup && this.config.groupAtOnly !== false && this.selfId) {
      const mentionSelf = !!this.username && text.toLowerCase().includes(this.username.toLowerCase())
      const replyToSelf = String(msg.reply_to_message?.from?.id ?? '') === this.selfId
      if (!mentionSelf && !replyToSelf) return
    }

    void Promise.resolve(imagePromise).then((image) => {
      const images = image ? [image] : null
      if (!images && !text) return
      return this.bridge.handleInbound(new InboundMessage({
        platform: 'telegram',
        sessionKey: `tg:${chatId}`,
        senderId: String(msg.from?.id ?? chatId),
        senderName: msg.from?.first_name || msg.from?.username || String(msg.from?.id ?? ''),
        text,
        images: images || undefined,
        raw: { target: chatId, messageId: msg.message_id },
      }))
    }).catch(() => {})
  }

  /** 选最大尺寸照片并经 getFile 换取带 token 的下载 URL（字节由 Bridge 统一拉取落库）。 */
  async _photoImageDescriptor(sizes) {
    const best = sizes.reduce((a, b) => (
      (a?.width ?? 0) * (a?.height ?? 0) >= (b?.width ?? 0) * (b?.height ?? 0) ? a : b
    ))
    if (!best?.file_id) return null
    const file = await this.call('getFile', { file_id: best.file_id })
    const filePath = file?.file_path
    if (!filePath) return null
    const base = this.api.replace(/\/bot[^/?]*$/, '')
    return {
      url: `${base}/file/bot${this.token}/${filePath}`,
      name: String(filePath.split('/').pop() || 'photo').slice(0, 120),
    }
  }

  /** 发送文本。target = chat_id。Telegram 单条上限 4096 字符，超长自动分块。 */
  async send(target, text) {
    const chunks = splitForDelivery(text, SEND_MAX_CHARS)
    for (const chunk of chunks) {
      await this.call('sendMessage', { chat_id: target, text: chunk })
    }
  }

  async stop() {
    this.closed = true
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }
}
