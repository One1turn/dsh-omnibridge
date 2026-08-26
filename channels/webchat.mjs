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
import { readJsonBody, respondJson } from './http-utils.mjs'

export class WebchatChannel extends Channel {
  constructor(id, config) {
    super(id, config)
    this.outbox = new Map() // sessionKey -> [{ text, ts }]
    this.waiters = new Map() // sessionKey -> waiter[]
    // 出站静默期：两条消息间隔超过该值即认为本轮回复到齐（turn/end 会立即截止）
    this.quietMs = Number(this.config.quietMs) || 3000
  }

  get path() {
    return this.config.path || `/dsh-omnibridge/webchat/${this.id}`
  }

  async start(ctx, bridge) {
    this.ctx = ctx
    this.bridge = bridge
    // 捕获 inject 的子上下文以便 stop() 能正确 dispose（修复 bridge rebuild 时的路由泄漏）
    ctx.inject(['webServer'], (routeCtx) => {
      this.routeCtx = routeCtx
      // 入站
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: `${this.path}/send`,
        handler: async (request, response) => {
          try {
            if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
            const body = await readJsonBody(request)
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

  /** 发送文本：写入 outbox 并重置等待者的静默计时。 */
  async send(target, text) {
    const key = `wc:${String(target)}`
    const list = this.outbox.get(key) || []
    const entry = { text, ts: Date.now() }
    list.push(entry)
    if (list.length > 200) list.splice(0, list.length - 200)
    this.outbox.set(key, list)
    this._notifyWaiters(key, false)
  }

  /** Bridge 回合结束信号：立即唤醒等待者（bridge 保证先完成本轮出站投递）。 */
  onTurnEnd(target) {
    this._notifyWaiters(`wc:${String(target)}`, true)
  }

  _notifyWaiters(key, immediate) {
    const waiters = this.waiters.get(key)
    if (!waiters?.length) return
    for (const w of [...waiters]) {
      if (w.quietTimer) clearTimeout(w.quietTimer)
      if (immediate) {
        this._resolveWaiter(key, w)
      } else {
        // 静默期兜底：turn/end 信号缺席（如纯命令回复）时也能及时返回
        w.quietTimer = setTimeout(() => this._resolveWaiter(key, w), this.quietMs)
        w.quietTimer.unref?.()
      }
    }
  }

  _resolveWaiter(key, w) {
    const arr = this.waiters.get(key) || []
    this.waiters.set(key, arr.filter((x) => x !== w))
    if (w.quietTimer) { clearTimeout(w.quietTimer); w.quietTimer = null }
    if (w.timeoutTimer) { clearTimeout(w.timeoutTimer); w.timeoutTimer = null }
    // 只返回请求之后产生的消息，避免重复下发历史
    w.resolve((this.outbox.get(key) || []).filter((m) => m.ts > w.since))
  }

  /** 等待回复（供 wait=true 使用）：turn/end 即刻返回，静默期/超时兜底。 */
  waitForReply(key, timeoutMs) {
    return new Promise((resolve) => {
      const k = `wc:${String(key)}`
      const w = { since: Date.now(), resolve, quietTimer: null, timeoutTimer: null }
      w.timeoutTimer = setTimeout(() => this._resolveWaiter(k, w), timeoutMs)
      w.timeoutTimer.unref?.()
      const arr = this.waiters.get(k) || []
      arr.push(w)
      this.waiters.set(k, arr)
    })
  }

  async stop() {
    if (this.routeCtx && typeof this.routeCtx.dispose === 'function') {
      try { await this.routeCtx.dispose() } catch {}
    }
    this.routeCtx = null
    // 释放等待中的请求，避免泄露 Promise 给已断开的客户端
    for (const [key, arr] of [...this.waiters]) {
      for (const w of [...arr]) this._resolveWaiter(key, w)
    }
    this.waiters.clear()
    this.outbox.clear()
  }
}
