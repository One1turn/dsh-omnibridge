/**
 * dsh-omnibridge channel: WebChat（HTTP 聊天端点，AstrBot webchat 对应物）。
 *
 * 入站：POST /dsh-omnibridge/webchat/<id>/send
 *   { "text": "...", "sender_id": "u1", "session_key": "u1" }
 * 出站：GET  /dsh-omnibridge/webchat/<id>/poll?since=0
 *   → { "messages": [{ "text": "...", "ts": 123 }] }（轮询消费回复）
 * 也支持 POST /dsh-omnibridge/webchat/<id>/send 时带上 wait=true 同步等回复。
 *
 * 适合网页/脚本/机器人面板等任意 HTTP 客户端接入。
 *
 * @module dsh-omnibridge/channels/webchat
 */

import { Channel, InboundMessage } from '../bridge-core.mjs'

export class WebchatChannel extends Channel {
  constructor(id, config) {
    super(id, config)
    this.outbox = new Map() // sessionKey -> [{ text, ts }]
    this.waiters = new Map() // sessionKey -> resolve[]
  }

  get path() {
    return this.config.path || `/dsh-omnibridge/webchat/${this.id}`
  }

  async start(ctx, bridge) {
    this.ctx = ctx
    this.bridge = bridge
    ctx.inject(['webServer'], (routeCtx) => {
      // 入站
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: `${this.path}/send`,
        handler: async (request, response) => {
          try {
            if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
            const body = await readJson(request)
            const text = String(body.text ?? '').trim()
            if (!text) { respondJson(response, 400, { error: 'text 不能为空' }); return }
            const senderId = String(body.sender_id ?? 'webuser')
            const key = String(body.session_key ?? senderId)
            const msg = new InboundMessage({
              platform: this.id,
              sessionKey: `wc:${key}`,
              senderId,
              senderName: String(body.sender_name ?? senderId),
              text,
              raw: { target: key },
            })
            const wait = body.wait === true || body.wait === 'true'
            const replyPromise = wait ? this.waitForReply(key, 60000) : null
            await this.bridge.handleInbound(msg)
            if (replyPromise) {
              const replies = await replyPromise
              respondJson(response, 200, { replies })
            } else {
              respondJson(response, 200, { status: 'ok' })
            }
          } catch (error) {
            respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
      }), `dsh-omnibridge webchat ${this.id} send`)

      // 轮询出站
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: `${this.path}/poll`,
        handler: async (request, response) => {
          try {
            if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
            const url = new URL(request.url ?? '', 'http://localhost')
            const key = url.searchParams.get('session_key') || 'webuser'
            const since = Number(url.searchParams.get('since') || 0)
            const list = this.outbox.get(`wc:${key}`) || []
            const messages = list.filter((m) => m.ts > since)
            respondJson(response, 200, { messages })
          } catch (error) {
            respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
      }), `dsh-omnibridge webchat ${this.id} poll`)
    })
  }

  /** 发送文本：写入 outbox 并唤醒等待者。 */
  async send(target, text) {
    const key = `wc:${String(target)}`
    const list = this.outbox.get(key) || []
    const entry = { text, ts: Date.now() }
    list.push(entry)
    if (list.length > 200) list.splice(0, list.length - 200)
    this.outbox.set(key, list)
    const waiters = this.waiters.get(key) || []
    this.waiters.delete(key)
    for (const resolve of waiters) resolve(list.slice())
  }

  /** 等待回复（供 wait=true 使用）。 */
  waitForReply(key, timeoutMs) {
    return new Promise((resolve) => {
      const k = `wc:${String(key)}`
      let waiter = null
      const timer = setTimeout(() => {
        const arr = this.waiters.get(k) || []
        this.waiters.set(k, arr.filter((w) => w !== waiter))
        resolve(this.outbox.get(k) || [])
      }, timeoutMs)
      waiter = {
        resolve: (list) => {
          clearTimeout(timer)
          resolve(list)
        },
      }
      const arr = this.waiters.get(k) || []
      arr.push(waiter)
      this.waiters.set(k, arr)
    })
  }

  async stop() {}
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
