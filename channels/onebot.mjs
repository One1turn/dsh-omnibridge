/**
 * dsh-omnibridge channel: QQ（OneBot v11 正向 WS 客户端）。
 *
 * 直连 NapCat / go-cqhttp / Lagrange 等 OneBot v11 实现的 WebSocket
 * 服务端。本机 NapCat 示例：ws://127.0.0.1:3001?access_token=%20
 *
 * target 约定："group:<群号>" | "private:<QQ号>"
 *
 * @module dsh-omnibridge/channels/onebot
 */

import { Channel, InboundMessage } from '../bridge-core.mjs'

export class OneBotChannel extends Channel {
  constructor(config) {
    super('onebot', config)
    this.ws = null
    this.pending = new Map()
    this.echoSeq = 0
    this.selfId = null
    this.reconnectTimer = null
    this.closed = false
  }

  get url() {
    return this.config.url || 'ws://127.0.0.1:3001?access_token=%20'
  }

  /** 发送 OneBot action 并等待回执。 */
  call(action, params, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('OneBot WebSocket 未连接'))
        return
      }
      const echo = `omni-${++this.echoSeq}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot action ${action} 超时`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ action, params, echo }))
    })
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
      this.ws = new WebSocket(this.url)
    } catch (error) {
      this.ctx?.logger?.error?.('[dsh-omnibridge:onebot] connect error: %s', error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = () => {
      this.ctx?.logger?.info?.('[dsh-omnibridge:onebot] connected to %s', this.url)
      // 取 bot 自身 id 用于过滤自己的消息
      this.call('get_login_info', {}, 5000).then((r) => {
        if (r?.retcode === 0 && r?.data?.user_id) this.selfId = String(r.data.user_id)
      }).catch(() => {})
    }
    this.ws.onmessage = (ev) => {
      let data
      try { data = JSON.parse(String(ev.data)) } catch { return }
      this.handleMessage(data)
    }
    this.ws.onclose = () => {
      this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] connection closed, reconnecting…')
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

  handleMessage(data) {
    // 回执
    if (data.echo && this.pending.has(String(data.echo))) {
      const p = this.pending.get(String(data.echo))
      this.pending.delete(String(data.echo))
      clearTimeout(p.timer)
      if (data.status === 'ok' || data.retcode === 0) p.resolve(data)
      else p.reject(new Error(`OneBot retcode ${data.retcode}: ${data.status || ''}`))
      return
    }
    // 事件
    if (data.post_type === 'message') {
      const self = String(data.self_id ?? this.selfId ?? '')
      const senderId = String(data.user_id ?? '')
      if (self && senderId === self) return // 忽略自己的消息
      let text = ''
      if (typeof data.raw_message === 'string') {
        text = data.raw_message.replace(/\[CQ:[^\]]+\]/g, '').trim()
      } else if (Array.isArray(data.message)) {
        text = data.message
          .filter((s) => s?.type === 'text')
          .map((s) => String(s.data?.text ?? ''))
          .join('')
          .trim()
      }
      if (!text) return
      const isGroup = data.message_type === 'group'
      const target = isGroup ? `group:${data.group_id}` : `private:${senderId}`
      const sessionKey = isGroup ? `qq-group:${data.group_id}` : `qq-private:${senderId}`
      const senderName = data.sender?.card || data.sender?.nickname || senderId
      this.bridge.handleInbound(new InboundMessage({
        platform: 'onebot',
        sessionKey,
        senderId,
        senderName,
        text,
        raw: { target, messageId: data.message_id },
      })).catch(() => {})
    }
  }

  /** 发送文本。target: "group:<id>" | "private:<id>" */
  async send(target, text) {
    const [kind, id] = String(target).split(':')
    if (!id) throw new Error(`无效 target: ${target}`)
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }
    params.message = text
    await this.call(action, params)
  }

  async stop() {
    this.closed = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    try { this.ws?.close() } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('channel stopped')) }
    this.pending.clear()
  }
}
