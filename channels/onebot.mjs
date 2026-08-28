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
import { Reconnector, escapeRegExp } from './retry.mjs'

/** OneBot action 回执等待上限。 */
const RPC_TIMEOUT_MS = 8000
/** 登录信息查询回执上限。 */
const LOGIN_TIMEOUT_MS = 5000

export class OneBotChannel extends Channel {
  constructor(config) {
    super('onebot', config)
    this.ws = null
    this.pending = new Map()
    this.echoSeq = 0
    this.selfId = null
    this.reconnector = new Reconnector({ baseDelayMs: config.reconnectDelayMs || 5000 })
    this.closed = false
  }

  get url() {
    return this.config.url || 'ws://127.0.0.1:3001?access_token=%20'
  }

  /** 发送 OneBot action 并等待回执。 */
  call(action, params, timeoutMs = RPC_TIMEOUT_MS) {
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
      // 连接成功，退避归零
      this.reconnector.reset()
      // 取 bot 自身 id 用于过滤自己的消息
      this.call('get_login_info', {}, LOGIN_TIMEOUT_MS).then((r) => {
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
    // 指数退避 + 抖动（Reconnector 内部管理 attempt，连接成功时 reset）
    this.reconnector.schedule(() => this.connect())
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
      let atMe = false
      const images = []
      if (typeof data.raw_message === 'string') {
        if (self) atMe = new RegExp(`\\[CQ:at,qq=${escapeRegExp(self)}[,\\]]`).test(data.raw_message)
        collectCqImages(data.raw_message, images)
        text = data.raw_message.replace(/\[CQ:[^\]]+\]/g, '').trim()
      } else if (Array.isArray(data.message)) {
        text = data.message
          .filter((s) => s?.type === 'text')
          .map((s) => String(s.data?.text ?? ''))
          .join('')
          .trim()
        if (self) atMe = data.message.some((s) => s?.type === 'at' && String(s.data?.qq ?? '') === self)
        for (const seg of data.message) {
          if (seg?.type !== 'image') continue
          const url = String(seg.data?.url || seg.data?.file || '')
          if (/^https?:\/\//i.test(url)) {
            images.push({ url, ...(seg.data?.file ? { name: String(seg.data.file).slice(0, 120) } : {}) })
          }
        }
      }
      if (!text && !images.length) return
      const isGroup = data.message_type === 'group'
      // 群聊默认只响应 @机器人，防止群里每条消息都驱动 agent（刷屏+放大消耗）；
      // groupAtOnly=false 恢复全量响应。selfId 未就绪时放行，兼容连接初期窗口。
      if (isGroup && this.config.groupAtOnly !== false && self && !atMe) return
      const target = isGroup ? `group:${data.group_id}` : `private:${senderId}`
      const sessionKey = isGroup ? `qq-group:${data.group_id}` : `qq-private:${senderId}`
      const senderName = data.sender?.card || data.sender?.nickname || senderId
      this.bridge.handleInbound(new InboundMessage({
        platform: 'onebot',
        sessionKey,
        senderId,
        senderName,
        text,
        images: images.length ? images : undefined,
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
    this.reconnector.close()
    try { this.ws?.close() } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('channel stopped')) }
    this.pending.clear()
  }
}

/** OneBot CQ 码实体反转义（url 等值内含的 &, [, ], 逗号会被转义）。 */
function cqUnescape(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&comma;/g, ',')
}

/** 从 raw_message 的 [CQ:image,…] 码中收集图片下载地址（剥离前调用）。 */
function collectCqImages(rawMessage, out) {
  for (const m of String(rawMessage).matchAll(/\[CQ:image,[^\]]*\]/g)) {
    const url = cqUnescape(/(?:^|[&,])url=([^,\]]*)/.exec(m[0])?.[1] || '')
    if (!/^https?:\/\//i.test(url)) continue
    const file = cqUnescape(/(?:^|[&,])file=([^,\]]*)/.exec(m[0])?.[1] || '')
    out.push({ url, ...(file ? { name: file.slice(0, 120) } : {}) })
  }
}
