/**
 * dsh-omnibridge channel: WebChat（HTTP 聊天端点，AstrBot webchat 对应物）。
 *
 * 入站：POST /dsh-omnibridge/webchat/<id>/send
 *   { "text": "...", "sender_id": "u1", "session_key": "u1" }
 * 出站：GET  /dsh-omnibridge/webchat/<id>/poll?since=0
 *   → { "messages": [{ "text": "...", "ts": 123 }] }（轮询消费回复）
 * 也支持 POST /dsh-omnibridge/webchat/<id>/send 时带上 wait=true 同步等回复。
 *
 * 出站缓冲按条数（200）与保留期（retentionMinutes，默认 30 分钟）双重淘汰。
 *
 * 适合网页/脚本/机器人面板等任意 HTTP 客户端接入。
 *
 * @module dsh-omnibridge/channels/webchat
 */

import { Channel, InboundMessage } from '../bridge-core.mjs'
import { readJsonBody, respondJson } from './http-utils.mjs'

/** 每个 sessionKey 的出站缓冲上限。 */
const MAX_OUTBOX_ENTRIES = 200
/** 出站保留分钟数缺省值（可配 webchat.retentionMinutes）。 */
const DEFAULT_RETENTION_MINUTES = 30
/** 过期清扫周期。 */
const SWEEP_INTERVAL_MS = 60000

/** 解析入站 images 字段：接受 [{url}] 或字符串数组（http(s) / data:image/*），非法项丢弃。 */
function parseWebchatImages(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  const out = []
  for (const item of arr.slice(0, 9)) {
    const url = typeof item === 'string' ? item : (typeof item?.url === 'string' ? item.url : '')
    if (!/^(https?:\/\/|data:image\/)/i.test(url)) continue
    const name = typeof item === 'object' && item?.name ? String(item.name).slice(0, 120) : undefined
    out.push(name ? { url, name } : { url })
  }
  return out
}

export class WebchatChannel extends Channel {
  constructor(id, config) {
    super(id, config)
    this.outbox = new Map() // sessionKey -> [{ text, ts, seq }]
    this._seq = 0 // 出站单调序号：wait=true 的过滤依据（Date.now 毫秒精度会碰撞）
    this.waiters = new Map() // sessionKey -> waiter[]
    this.waiters = new Map() // sessionKey -> waiter[]
    // agent 回合进行中的 target（wait=true 的等待者据此挂起静默期，等 turn/end 即时唤醒）
    this.turnInFlight = new Set()
    // 出站静默期：两条消息间隔超过该值即认为本轮回复到齐（仅无回合信号时兜底）
    this.quietMs = Number(this.config.quietMs) || 3000
    // 出站保留时长：超时自动淘汰并回收空 key（长跑防内存泄漏）
    const minutes = Number(this.config.retentionMinutes) > 0
      ? Number(this.config.retentionMinutes)
      : DEFAULT_RETENTION_MINUTES
    this.retentionMs = minutes * 60 * 1000
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
      // 周期清扫过期出站（随 routeCtx 释放）；send() 内也会顺带修剪本 key
      routeCtx.effect(() => {
        const timer = setInterval(() => { try { this._sweepOutbox() } catch {} }, Math.min(SWEEP_INTERVAL_MS, this.retentionMs))
        timer.unref?.()
        return () => clearInterval(timer)
      })
      // 入站
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: `${this.path}/send`,
        handler: async (request, response) => {
          try {
            if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
            const body = await readJsonBody(request)
            const text = String(body.text ?? '').trim()
            const images = parseWebchatImages(body.images)
            if (!text && !images.length) { respondJson(response, 400, { error: 'text 不能为空' }); return }
            const senderId = String(body.sender_id ?? 'webuser')
            const key = String(body.session_key ?? senderId)
            const msg = new InboundMessage({
              platform: this.id,
              sessionKey: `wc:${key}`,
              senderId,
              senderName: String(body.sender_name ?? senderId),
              text,
              images: images.length ? images : undefined,
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
    list.push({ text, ts: Date.now(), seq: ++this._seq })
    this._pruneList(list)
    if (list.length) this.outbox.set(key, list)
    else this.outbox.delete(key)
    this._notifyWaiters(key, false)
  }

  /** 单条 outbox 修剪：超容量截尾 + 超保留期淘汰头部。 */
  _pruneList(list) {
    if (list.length > MAX_OUTBOX_ENTRIES) list.splice(0, list.length - MAX_OUTBOX_ENTRIES)
    const cutoff = Date.now() - this.retentionMs
    while (list.length && list[0].ts < cutoff) list.shift()
  }

  /** 全量清扫：修剪所有 key 并回收空 key（补齐无新入站流量的会话）。 */
  _sweepOutbox() {
    for (const [key, list] of [...this.outbox]) {
      this._pruneList(list)
      if (!list.length) this.outbox.delete(key)
    }
  }

  /** Bridge 回合开始信号：挂起该 target 的静默期唤醒（wait=true 等 turn/end）。 */
  onTurnStart(target) {
    this.turnInFlight.add(`wc:${String(target)}`)
  }

  /** Bridge 回合结束信号：解除挂起并立即唤醒等待者（bridge 保证先完成本轮出站投递）。 */
  onTurnEnd(target) {
    const key = `wc:${String(target)}`
    this.turnInFlight.delete(key)
    this._notifyWaiters(key, true)
  }

  _notifyWaiters(key, immediate) {
    const waiters = this.waiters.get(key)
    if (!waiters?.length) return
    // 回合进行中：静默期不可信（agent 思考期无出站），一律等 turn/end 即时唤醒
    if (!immediate && this.turnInFlight.has(key)) return
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
    // 只返回登记之后产生的消息（seq 单调，杜绝同时毫秒被严格大于过滤掉）
    w.resolve((this.outbox.get(key) || []).filter((m) => m.seq > w.sinceSeq))
  }

  /** 等待回复（供 wait=true 使用）：turn/end 即刻返回，静默期/超时兜底。 */
  waitForReply(key, timeoutMs) {
    return new Promise((resolve) => {
      const k = `wc:${String(key)}`
      // sinceSeq = 当前出站序号：之后 push 的条目（seq 更大）才属于本次回复
      const w = { sinceSeq: this._seq, resolve, quietTimer: null, timeoutTimer: null }
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
    this.turnInFlight.clear()
    // 释放等待中的请求，避免泄露 Promise 给已断开的客户端
    for (const [key, arr] of [...this.waiters]) {
      for (const w of [...arr]) this._resolveWaiter(key, w)
    }
    this.waiters.clear()
    this.outbox.clear()
  }
}
