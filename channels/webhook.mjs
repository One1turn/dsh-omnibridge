/**
 * dsh-omnibridge channel: 通用 Webhook（飞书 / 企业微信 / 钉钉 / 自定义）。
 *
 * - 入站：DSH webServer 注册 POST /dsh-omnibridge/webhook/<id>，自动解析
 *   飞书 / 企业微信 / 钉钉 / 自定义 JSON 消息格式（可手动指定 format）。
 * - 出站：POST 到配置的机器人 webhook URL（企业微信 / 飞书 / 钉钉机器人）。
 *
 * 飞书入站事件示例（im.message.receive_v1）：
 *   { "header": { "event_type": "im.message.receive_v1" },
 *     "event": { "message": { "content": "{\"text\":\"...\"}", "chat_id": "oc_xxx" },
 *                "sender": { "sender_id": { "open_id": "ou_xxx" } } } }
 * 企业微信入站示例（文本回调）：
 *   { "MsgType": "text", "Content": "...", "FromUserName": "xxx", "ToUserName": "yyy" }
 * 自定义：{ "text": "...", "sender_id": "..." , "session_key": "..." }
 *
 * @module dsh-omnibridge/channels/webhook
 */

import { Channel, InboundMessage } from '../bridge-core.mjs'

export class WebhookChannel extends Channel {
  constructor(id, config) {
    super(id, config)
    this.format = this.config.format || 'auto'
  }

  get path() {
    return this.config.path || `/dsh-omnibridge/webhook/${this.id}`
  }

  get outboundUrl() {
    return this.config.outboundUrl || ''
  }

  async start(ctx, bridge) {
    this.ctx = ctx
    this.bridge = bridge
    if (!ctx.webServer) {
      this.ctx?.logger?.warn?.('[dsh-omnibridge:webhook:%s] webServer 服务不可用，入站禁用（出站仍可用）', this.id)
      return
    }
    ctx.inject(['webServer'], (routeCtx) => {
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: this.path,
        handler: async (request, response) => {
          try {
            if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
            const body = await readJson(request)
            const parsed = this.parseInbound(body)
            if (parsed) {
              await this.bridge.handleInbound(parsed)
            }
            // 飞书要求快速应答（v2 需要 challenge 响应）
            if (body?.challenge !== undefined) {
              respondJson(response, 200, { challenge: body.challenge })
              return
            }
            respondJson(response, 200, { status: 'ok' })
          } catch (error) {
            respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
      }), `dsh-omnibridge webhook ${this.id}`)
    })
  }

  /** 解析入站 JSON → InboundMessage | null。 */
  parseInbound(body) {
    if (!body || typeof body !== 'object') return null
    const fmt = this.format === 'auto' ? detectFormat(body) : this.format
    if (fmt === 'feishu') {
      // 飞书事件订阅
      const eventType = body?.header?.event_type
      if (eventType === 'im.message.receive_v1' || body?.event?.message) {
        const event = body.event
        const message = event?.message
        let text = ''
        try {
          const content = JSON.parse(message?.content || '{}')
          text = String(content.text ?? '')
        } catch {}
        if (!text.trim()) return null
        const openId = String(event?.sender?.sender_id?.open_id ?? '')
        const chatId = String(message?.chat_id ?? '')
        const key = chatId || openId || 'default'
        return new InboundMessage({
          platform: this.id,
          sessionKey: `feishu:${key}`,
          senderId: openId || key,
          senderName: openId || key,
          text,
          raw: { target: chatId || openId || key, messageId: String(message?.message_id ?? '') },
        })
      }
      return null
    }
    if (fmt === 'wecom') {
      // 企业微信回调（文本）
      if (body?.MsgType === 'text') {
        const from = String(body.FromUserName ?? '')
        const to = String(body.ToUserName ?? '')
        return new InboundMessage({
          platform: this.id,
          sessionKey: `wecom:${from || to}`,
          senderId: from || to || 'unknown',
          senderName: from || to || 'unknown',
          text: String(body.Content ?? '').trim(),
          raw: { target: from || to, messageId: String(body.MsgId ?? '') },
        })
      }
      return null
    }
    if (fmt === 'dingtalk') {
      // 钉钉（自定义机器人回调，需加解密，此处仅支持明文 text）
      if (body?.text?.content) {
        const senderId = String(body.senderNick ?? body.senderStaffId ?? 'unknown')
        return new InboundMessage({
          platform: this.id,
          sessionKey: `ding:${senderId}`,
          senderId,
          senderName: senderId,
          text: String(body.text.content).trim(),
          raw: { target: senderId, messageId: String(body.msgId ?? '') },
        })
      }
      return null
    }
    if (fmt === 'line') {
      // LINE Messaging API：webhook 事件（text message）
      const events = Array.isArray(body.events) ? body.events : []
      for (const ev of events) {
        if (ev.type !== 'message' || ev.message?.type !== 'text') continue
        const userId = String(ev.source?.userId ?? ev.source?.groupId ?? '')
        if (!userId) continue
        return new InboundMessage({
          platform: this.id,
          sessionKey: `line:${userId}`,
          senderId: userId,
          senderName: userId,
          text: String(ev.message.text ?? '').trim(),
          raw: { target: userId, replyToken: ev.replyToken },
          replyToken: ev.replyToken,
        })
      }
      return null
    }
    if (fmt === 'mp') {
      // 微信公众号（明文模式回调，XML 由网关层转 JSON 或原样字符串）
      const text = String(body.Content ?? body.content ?? '').trim()
      if (!text) return null
      const from = String(body.FromUserName ?? body.from ?? 'unknown')
      return new InboundMessage({
        platform: this.id,
        sessionKey: `mp:${from}`,
        senderId: from,
        senderName: from,
        text,
        raw: { target: from, messageId: String(body.MsgId ?? body.MsgID ?? '') },
      })
    }
    if (fmt === 'wecom_ai') {
      // 企业微信智能机器人回调
      const text = String(body.text?.content ?? body.Content ?? '').trim()
      if (!text) return null
      const from = String(body.from ?? body.FromUserName ?? 'unknown')
      return new InboundMessage({
        platform: this.id,
        sessionKey: `wecomai:${from}`,
        senderId: from,
        senderName: String(body.senderName ?? body.sender_name ?? from),
        text,
        raw: { target: from, messageId: String(body.msgid ?? '') },
      })
    }
    // custom：{ text, sender_id?, session_key?, target? }
    const text = String(body.text ?? body.content ?? body.message ?? '').trim()
    if (!text) return null
    const senderId = String(body.sender_id ?? body.sender ?? 'unknown')
    const key = String(body.session_key ?? senderId)
    return new InboundMessage({
      platform: this.id,
      sessionKey: `wh:${key}`,
      senderId,
      senderName: String(body.sender_name ?? senderId),
      text,
      raw: { target: String(body.target ?? key), messageId: String(body.message_id ?? '') },
    })
  }

  /** 发送文本：POST 到机器人 webhook。 */
  async send(target, text) {
    if (!this.outboundUrl) {
      this.ctx?.logger?.warn?.('[dsh-omnibridge:webhook:%s] 未配置 outboundUrl，消息未发送', this.id)
      return
    }
    let payload
    if (this.format === 'line') {
      // LINE 出站走 Reply API（需 channelAccessToken 与 replyToken）
      if (!this.config.channelAccessToken || !target.startsWith('reply:')) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:webhook:%s] LINE 出站需要 channelAccessToken + reply token', this.id)
        return
      }
      const replyToken = target.slice('reply:'.length)
      const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.channelAccessToken}`,
        },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) throw new Error(`LINE reply -> ${resp.status}`)
      return
    }
    if (this.format === 'mp') {
      // 微信公众号：出站走客服消息 API（需要 accessToken + openid）
      if (!this.config.mpAccessToken || !target.startsWith('openid:')) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:webhook:%s] 公众号出站需要 mpAccessToken + openid', this.id)
        return
      }
      const openid = target.slice('openid:'.length)
      const resp = await fetch(
        `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(this.config.mpAccessToken)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ touser: openid, msgtype: 'text', text: { content: text } }),
          signal: AbortSignal.timeout(10000),
        },
      )
      if (!resp.ok) throw new Error(`mp custom send -> ${resp.status}`)
      return
    }
    if (this.format === 'wecom') {
      payload = { msgtype: 'text', text: { content: text } }
    } else if (this.format === 'dingtalk') {
      payload = { msgtype: 'text', text: { content: text } }
    } else if (this.format === 'feishu') {
      // 飞书机器人 webhook（老式自定义机器人）
      payload = { msg_type: 'text', content: JSON.stringify({ text }) }
    } else {
      payload = this.config.customOutboundTemplate
        ? { ...this.config.customOutboundTemplate, text }
        : { text }
    }
    const resp = await fetch(this.outboundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) throw new Error(`webhook send -> ${resp.status}`)
    // 飞书/钉钉 webhook 会返回 JSON，企业微信返回 { errcode: 0 }
    const data = await resp.json().catch(() => null)
    if (data && typeof data.errcode === 'number' && data.errcode !== 0) {
      throw new Error(`webhook errcode ${data.errcode}: ${data.errmsg || ''}`)
    }
  }

  async stop() {}
}

/** 自动识别消息格式。 */
function detectFormat(body) {
  if (body?.header?.event_type || body?.event?.message?.content) return 'feishu'
  if (Array.isArray(body.events) && body.events.some((e) => e.type === 'message')) return 'line'
  if (body?.MsgType) return 'wecom'
  if (body?.MsgType === 'text' || body?.MsgId || body?.MsgID) return 'mp'
  if (body?.text?.content && (body.msgtype === 'text' || body.senderStaffId)) return 'dingtalk'
  if (body?.msgid && body?.text?.content && body?.tousername) return 'wecom_ai'
  return 'custom'
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('请求体不是合法 JSON'))
      }
    })
  })
}

function respondJson(response, status, value) {
  response.writeHead(status)
  response.end(JSON.stringify(value))
}
