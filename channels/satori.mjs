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

export class SatoriChannel extends Channel {
  constructor(config) {
    super('satori', config)
    this.ws = null
    this.pending = new Map()
    this.echoSeq = 0
    this.reconnectTimer = null
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
    if (this.closed || this.reconnectTimer) return
    const delay = this.config.reconnectDelayMs || 5000
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  handleFrame(data) {
    if (data?.type === 'ready') {
      this.ready = true
      this.ctx?.logger?.info?.('[dsh-omnibridge:satori] ready')
      return
    }
    if (data?.type === 'event' && data.body) {
      this.handleEvent(data.body)
    }
  }

  handleEvent(body) {
    // 消息创建事件
    if (body?.type !== 'message.created') return
    const message = body.message
    if (!message) return
    // 忽略自己发的
    if (message.user?.id && this.selfId && message.user.id === this.selfId) return
    // 提取纯文本（content 是含 At/图片的富文本，取 text 片段）
    const content = message.content || ''
    let text = ''
    if (typeof content === 'string') {
      text = content.replace(/<at[^>]*\/?>/g, '').replace(/<img[^>]*\/?>/g, '').trim()
    }
    if (!text) return
    const channelId = message.channel?.id || ''
    if (!channelId) return
    const guildId = message.guild?.id
    const userId = message.user?.id || ''
    const sessionKey = guildId ? `satori:${guildId}:${channelId}` : `satori:${channelId}`
    const senderName = message.user?.name || message.user?.nick || userId
    this.bridge.handleInbound(new InboundMessage({
      platform: 'satori',
      sessionKey,
      senderId: userId || channelId,
      senderName,
      text,
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
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) throw new Error(`Satori message.create -> ${resp.status}`)
  }

  async stop() {
    this.closed = true
    this.ready = false
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    try { this.ws?.close() } catch {}
    // 与 onebot 对齐：丢弃挂起的 RPC 回执
    for (const p of this.pending.values()) {
      if (p?.timer) clearTimeout(p.timer)
      try { p?.reject?.(new Error('channel stopped')) } catch {}
    }
    this.pending.clear()
  }
}
