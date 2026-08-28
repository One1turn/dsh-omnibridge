/**
 * dsh-omnibridge channel: Satori（通用聊天平台协议）。
 *
 * Satori 是一套跨平台消息协议，一个 Satori 服务端（如 Chronocat /
 * satori-js / Satori App）可以同时接 Discord / KOOK / Slack /
 * Mattermost / Misskey / LINE / 飞书 等多个平台。本 channel 直连
 * Satori 网关，一个 channel 覆盖全部接入平台的入站+出站。
 *
 * 协议（Satori v1）：
 *   - 入站：WebSocket ws://host:port/v1/ws?token=xxx
 *     首帧发 {"type":"login","token":"xxx"}，收到 {"type":"ready"}
 *     后续收到 {"type":"event","body":{...}}
 *   - 出站：POST http://host:port/v1/message.create
 *     {"channel_id":"...","content":"..."}
 *
 * target 约定：channel_id
 *
 * @module dsh-omnibridge/channels/satori
 */

import { Channel, InboundMessage } from '../bridge-core.mjs'
import { Reconnector, escapeRegExp } from './retry.mjs'

/** HTTP 出站请求超时。 */
const HTTP_TIMEOUT_MS = 10000

export class SatoriChannel extends Channel {
  constructor(config) {
    super('satori', config)
    this.ws = null
    this.pending = new Map()
    this.echoSeq = 0
    this.reconnector = new Reconnector({ baseDelayMs: config.reconnectDelayMs || 5000 })
    this.closed = false
    this.ready = false
    this.selfId = this.config.selfId || null
  }

  get baseUrl() {
    return this.config.baseUrl || 'http://127.0.0.1:5140'
  }

  get wsUrl() {
    const u = new URL(this.baseUrl)
    const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = this.config.token
    return `${scheme}//${u.host}/v1/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
  }

  async start(ctx, bridge) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 无全局 WebSocket（需要 Node ≥ 22 或 --experimental-websocket）')
    }
    this.ctx = ctx
    this.bridge = bridge
    this.closed = false
    this.connect()
  }

  connect() {
    if (this.closed) return
    try {
      this.ws = new WebSocket(this.wsUrl)
    } catch (error) {
      this.ctx?.logger?.error?.('[dsh-omnibridge:satori] connect error: %s', error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = () => {
      this.ctx?.logger?.info?.('[dsh-omnibridge:satori] connected to %s', this.wsUrl)
      this.ready = false
      // 登录帧
      const login = { type: 'login' }
      if (this.config.token) login.token = this.config.token
      this.ws.send(JSON.stringify(login))
    }
    this.ws.onmessage = (ev) => {
      let data
      try { data = JSON.parse(String(ev.data)) } catch { return }
      this.handleFrame(data)
    }
    this.ws.onclose = () => {
      this.ctx?.logger?.warn?.('[dsh-omnibridge:satori] connection closed, reconnecting…')
      this.scheduleReconnect()
    }
    this.ws.onerror = () => {
      try { this.ws?.close() } catch {}
    }
  }

  scheduleReconnect() {
    // 指数退避 + 抖动（Reconnector 内部管理 attempt，ready 帧时 reset）
    this.reconnector.schedule(() => this.connect())
  }

  handleFrame(data) {
    if (data?.type === 'ready') {
      this.ready = true
      this.ctx?.logger?.info?.('[dsh-omnibridge:satori] ready')
      // 鉴权握手成功才证明连接可用：退避归零；随后自识别 bot id（群聊 waking 用）
      this.reconnector.reset()
      if (!this.selfId) void this._fetchSelfId()
      return
    }
    if (data?.type === 'event' && data.body) {
      this.handleEvent(data.body)
    }
  }

  /** ready 后自识别 bot id（Satori GET /v1/user/me），供群聊 waking 判定使用。 */
  async _fetchSelfId() {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/user/me`, {
        headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!resp.ok) throw new Error(`status ${resp.status}`)
      const data = await resp.json()
      // 兼容裸 User 对象与 { data: User } 包裹两种响应
      const id = String(data?.data?.id ?? data?.id ?? '')
      if (!id) throw new Error('响应缺少 user id')
      this.selfId = id
      this.ctx?.logger?.info?.('[dsh-omnibridge:satori] 自识别 bot id=%s', id)
    } catch (error) {
      // 无法确定自身 id 时放行所有群消息（同 onebot「未就绪先放行」惯例）
      if (!this.selfId) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:satori] 获取 bot id 失败，群聊仅@唤醒降级为全量响应: %s', error instanceof Error ? error.message : String(error))
      }
    }
  }

  handleEvent(body) {
    // 消息创建事件
    if (body?.type !== 'message.created') return
    const message = body.message
    if (!message) return
    // 忽略自己发的
    if (message.user?.id && this.selfId && message.user.id === this.selfId) return
    const channelId = message.channel?.id || ''
    if (!channelId) return
    const guildId = message.guild?.id
    const content = typeof message.content === 'string' ? message.content : ''

    // 富文本里的图片在剥离前收集 src（字节由 Bridge 统一拉取落库）
    const images = []
    for (const m of content.matchAll(/<img[^>]*src=["']([^"']+)["']/gi)) {
      const url = m[1]
      if (/^https?:\/\//i.test(url)) images.push({ url })
    }

    // 群聊（有 guild）默认仅响应 @机器人 或引用机器人消息（对齐 AstrBot waking check）；
    // groupAtOnly=false 恢复全量响应。at 检测必须在剥标签之前。
    if (guildId && this.config.groupAtOnly !== false && this.selfId) {
      const atMe = new RegExp(`<at[^>]*id=["']${escapeRegExp(String(this.selfId))}["']`, 'i').test(content)
      const quotedMe = String(message.quote?.user?.id ?? '') === String(this.selfId)
      if (!atMe && !quotedMe) return
    }

    // 提取纯文本（content 是含 At/图片的富文本，取 text 片段）
    let text = ''
    text = content.replace(/<at[^>]*\/?>/g, '').replace(/<img[^>]*\/?>/g, '').trim()
    if (!text && !images.length) return

    const userId = message.user?.id || ''
    const sessionKey = guildId ? `satori:${guildId}:${channelId}` : `satori:${channelId}`
    const senderName = message.user?.name || message.user?.nick || userId
    this.bridge.handleInbound(new InboundMessage({
      platform: 'satori',
      sessionKey,
      senderId: userId || channelId,
      senderName,
      text,
      images: images.length ? images : undefined,
      raw: { target: channelId, messageId: message.id, guildId },
    })).catch(() => {})
  }

  /** 发送文本：POST /v1/message.create。target = channel_id。 */
  async send(target, text) {
    const url = `${this.baseUrl}/v1/message.create`
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
      },
      body: JSON.stringify({ channel_id: target, content: text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`Satori message.create -> ${resp.status}`)
  }

  async stop() {
    this.closed = true
    this.ready = false
    this.reconnector.close()
    try { this.ws?.close() } catch {}
    // 与 onebot 对齐：丢弃挂起的 RPC 回执
    for (const p of this.pending.values()) {
      if (p?.timer) clearTimeout(p.timer)
      try { p?.reject?.(new Error('channel stopped')) } catch {}
    }
    this.pending.clear()
  }
}
