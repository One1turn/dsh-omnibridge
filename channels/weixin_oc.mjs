/**
 * dsh-omnibridge channel: 个人微信（iLink 官方接口 weixin_oc）。
 *
 * 协议出处：AstrBot weixin_oc 适配器（iLink `https://ilinkai.weixin.qq.com`）。
 * 这是腾讯官方"个人微信"机器人入口，比逆向协议封号风险低得多。
 *
 * 与其它 channel 的关键差异：**自带二维码登录**。
 *   1) 启动时若无 bot_token，发起登录流程：GET ilink/bot/get_bot_qrcode，
 *      打印二维码到日志，用户用个人微信扫码确认。
 *   2) 长轮询 GET ilink/bot/get_qrcode_status 拿到 bot_token 后写入配置文件，
 *      之后直接进入 inbound 长轮询，下次启动无需再次扫码。
 *   3) inbound：POST ilink/bot/getupdates（35s 长轮询，Bearer bot_token），
 *      拿到 msgs[] 里的纯文本即转成 InboundMessage。
 *   4) outbound：POST ilink/bot/sendmessage，item_list 内放文本 item。
 *
 * 按实际平台情况取舍：本实现只做文本收发 + 扫码登录 + bot_token 持久化，
 * AES-ECB 的 CDN 媒体收发、typing 状态、引用回复匹配等暂不支持，
 * 如需可后续扩展（dsh 这条链路目前只回文本，媒体成本/复杂度性价比低）。
 *
 * target 约定：对方的 ilink user_id（即 inbound 消息中的 from_user_id）。
 *
 * @module dsh-omnibridge/channels/weixin_oc
 */

import { Channel, InboundMessage, splitForDelivery } from '../bridge-core.mjs'
import { backoffDelayMs, sleep } from './retry.mjs'
import { readJsonBody, respondJson } from './http-utils.mjs'
import { randomUUID, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_BOT_TYPE = '3'
const LONG_POLL_MS = 35000
const API_TIMEOUT_MS = 15000
const QR_POLL_HEADER = { 'iLink-App-ClientVersion': '1' }
const API_PREFIX = '/dsh-omnibridge'
/** 高频字段（syncBuf/contextTokens）写盘去抖窗口。 */
const PERSIST_DEBOUNCE_MS = 2000

export class WeixinOCChannel extends Channel {
  constructor(config) {
    super('weixin_oc', config)
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    this.botType = config.botType || DEFAULT_BOT_TYPE
    this.token = config.token || ''
    this.accountId = config.accountId || ''
    this.userId = config.userId || ''
    this.statePath = config.statePath || join(dirname(fileURLToPath(import.meta.url)), '..', 'weixin_oc.state.json')
    // inbound 长轮询的同步游标，每次回包会更新
    this.syncBuf = ''
    // 出站需要的 per-user context_token（inbound 会带回来）
    this.contextTokens = new Map()
    this.closed = false
    this.polling = false
    this.ctx = null
    this.bridge = null
    // 二维码展示（HTTP 端点 + PNG 缓存）
    this.qrContent = ''
    this.qrPng = null
    this.qrUrl = ''
    this.qrUpdatedAt = 0
    this.routesRegistered = false
    // 恢复持久化的 context_tokens（避免重启丢失、导致首次回复失败）
    try {
      const st = this._readState()
      if (st?.token) this.token = this.token || st.token
      if (st?.accountId) this.accountId = this.accountId || st.accountId
      if (st?.userId) this.userId = this.userId || st.userId
      if (typeof st?.syncBuf === 'string') this.syncBuf = st.syncBuf
      if (st?.contextTokens && typeof st.contextTokens === 'object') {
        this.contextTokens = new Map(Object.entries(st.contextTokens))
      }
    } catch {}
  }

  meta() {
    return {
      id: this.id,
      name: this.config.name || '个人微信 (iLink)',
      enabled: this.enabled,
    }
  }

  // —— 持久化。bot_token 一旦拿到不能丢，否则要重新扫码 ——
  _readState() {
    try {
      if (existsSync(this.statePath)) return JSON.parse(readFileSync(this.statePath, 'utf8'))
    } catch {}
    return null
  }
  _writeState(patch = {}) {
    try {
      const cur = this._readState() || {}
      const next = {
        ...cur,
        ...patch,
        contextTokens: Object.fromEntries(this.contextTokens),
        syncBuf: this.syncBuf,
      }
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(next, null, 2), 'utf8')
    } catch {}
    // 立即写已覆盖全量状态，取消挂起的去抖冲刷
    this._persistDirty = false
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null }
  }

  /**
   * 高频字段（syncBuf / contextTokens）写盘去抖：尾沿窗口内合并为一次磁盘写。
   * 每次长轮询回包都会推进 syncBuf，逐条同步读改写毫无必要；
   * bot_token 等关键状态转换仍直接走 _writeState()（丢失要重新扫码）。
   */
  _schedulePersist(delayMs = PERSIST_DEBOUNCE_MS) {
    this._persistDirty = true
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      if (!this._persistDirty) return
      this._persistDirty = false
      this._writeState()
    }, delayMs)
    this._persistTimer.unref?.()
  }

  /** 冲刷挂起脏数据（stop 时调用，防正常退出丢 context_token）。 */
  _flushPersist() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null }
    if (!this._persistDirty) return
    this._persistDirty = false
    this._writeState()
  }

  // —— HTTP 基础 ——
  _headers(tokenRequired) {
    const h = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      // iLink 要一个 base64 随机数当 X-WECHAT-UIN，不必真实，每次随机即可
      'X-WECHAT-UIN': randomBytes(32).toString('base64'),
    }
    if (tokenRequired && this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  async _request(method, endpoint, { params, payload, tokenRequired, timeoutMs, headers } = {}) {
    const url = new URL(this.baseUrl + '/' + endpoint)
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const merged = { ...this._headers(tokenRequired), ...(headers || {}) }
    const resp = await fetch(url, {
      method,
      headers: merged,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs || API_TIMEOUT_MS),
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`weixin_oc ${method} ${endpoint} -> ${resp.status} ${text.slice(0, 200)}`)
    if (!text) return {}
    return JSON.parse(text)
  }

  _isSuccess(data) {
    // iLink 用 base_resp.ret 或 errcode 字段报错，0/-1 等正负惯例不统一，
    // 这里只要 base_resp.ret===0 或 errcode===0 或没有 errcode 就算大致成功。
    const base = data?.base_resp
    if (base && typeof base.ret === 'number') return base.ret === 0
    if (typeof data?.errcode === 'number') return data.errcode === 0
    return true
  }

  // —— 启动 ——
  async start(ctx, bridge) {
    this.ctx = ctx
    this.bridge = bridge
    this.closed = false
    this._registerHttpRoutes()
    if (this.token) {
      this._pollInboundLoop()
      return
    }
    // 无 token 时登录流程放后台跑（扫码可能耗时数分钟），不阻塞 bridge 启动
    void this._loginFlow().then(() => {
      if (!this.closed && this.token) this._pollInboundLoop()
    })
  }

  // 暴露二维码图片给浏览器扫码：GET /dsh-omnibridge/weixin_oc/qrcode.png
  _registerHttpRoutes() {
    if (!this.ctx?.inject || this.routesRegistered) return
    this.routesRegistered = true
    try {
      this.ctx.inject(['webServer'], (routeCtx) => {
        this.routeCtx = routeCtx
        const self = this
        routeCtx.effect(() => routeCtx.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/weixin_oc/qrcode.png`,
          handler: async (request, response) => {
            const png = self.qrPng
            if (!png || !self.qrContent) {
              response.writeHead(404)
              response.end('no qr code yet')
              return
            }
            response.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'no-store',
            })
            response.end(png)
          },
        }), 'dsh-omnibridge weixin_oc qrcode png')

        routeCtx.effect(() => routeCtx.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/weixin_oc/qrcode.txt`,
          handler: async (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            response.end(self.qrContent || 'no qr code yet')
          },
        }), 'dsh-omnibridge weixin_oc qrcode txt')

        // 登录状态查询（扫码登录面板轮询用）
        routeCtx.effect(() => routeCtx.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/weixin_oc/login-status`,
          handler: async (request, response) => {
            try {
              if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
              respondJson(response, 200, {
                loggedIn: !!self.token,
                loggingIn: !!self._loginPromise,
                hasQr: !!self.qrPng,
                qrUrl: `${API_PREFIX}/weixin_oc/qrcode.png`,
                qrUpdatedAt: self.qrUpdatedAt || null,
              })
            } catch (error) {
              respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }), 'dsh-omnibridge weixin_oc login-status')

        // 手动刷新二维码：登录流程进行中仅重取二维码（不动轮询）；未在登录则后台拉起登录流程。
        // {restart:true}：退出当前登录态（旧 token 备份进 state.previousToken）并重新出码扫码。
        routeCtx.effect(() => routeCtx.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/weixin_oc/qr-refresh`,
          handler: async (request, response) => {
            try {
              if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
              const body = await readJsonBody(request).catch(() => ({}))
              if (self.token && body.restart !== true) { respondJson(response, 200, { ok: true, loggedIn: true }); return }
              if (self.token && body.restart === true) {
                const prev = self.token
                self.token = ''
                self.accountId = ''
                self.userId = ''
                self._writeState({ token: '', accountId: '', userId: '', previousToken: prev })
                self.contextTokens.clear()
                void self._loginFlow().catch(() => {})
                respondJson(response, 200, { ok: true, restarted: true, loggingIn: true })
                return
              }
              // 未登录：确保扫码轮询流程在跑（否则只出码、扫了没反应），再等首张二维码落地
              if (!self._loginPromise) void self._loginFlow().catch(() => {})
              for (let i = 0; i < 16 && !self.qrPng && !self.closed; i++) await sleep(500)
              respondJson(response, 200, { ok: !!self.qrPng, hasQr: !!self.qrPng, loggingIn: !!self._loginPromise, qrUpdatedAt: self.qrUpdatedAt || null })
            } catch (error) {
              respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }), 'dsh-omnibridge weixin_oc qr-refresh')
      })
    } catch (e) {
      this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] 注册二维码路由失败: %s', e?.message || e)
    }
  }

  // —— 二维码登录流程 ——
  // 幂等保护：session 失效触发重登时，若已有登录流程在跑则直接等它结束。
  async _loginFlow() {
    if (this._loginPromise) return this._loginPromise
    this._loginPromise = this._doLoginFlow().finally(() => { this._loginPromise = null })
    return this._loginPromise
  }

  async _doLoginFlow() {
    let retries = 0
    while (!this.closed && !this.token) {
      const qr = await this._requestLoginQr().catch((e) => {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] 获取二维码失败: %s', e?.message || e)
        return null
      })
      if (!qr) {
        if (this.closed) return
        await sleep(10_000)
        continue
      }
      this._printQr(qr)
      // 单张二维码轮询，过期就重取（最多 3 次）
      let expiredCount = 0
      while (!this.closed && !this.token && expiredCount < 3) {
        const r = await this._pollQrOnce(qr.qrcode).catch((e) => {
          this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] 二维码轮询失败: %s', e?.message || e)
          return { status: 'pending' }
        })
        if (r.status === 'created') {
          this.token = r.weixin_oc_token
          this.accountId = r.weixin_oc_account_id || ''
          this.userId = r.weixin_oc_user_id || ''
          this.baseUrl = r.weixin_oc_base_url ? r.weixin_oc_base_url.replace(/\/$/, '') : this.baseUrl
          this._writeState({ token: this.token, accountId: this.accountId, userId: this.userId, baseUrl: this.baseUrl })
          this.ctx?.logger?.info?.('[dsh-omnibridge:weixin_oc] 登录成功 accountId=%s', this.accountId)
          return
        }
        if (r.status === 'expired') {
          expiredCount++
          this.ctx?.logger?.info?.('[dsh-omnibridge:weixin_oc] 二维码过期，重新获取（第 %s 次）', expiredCount)
          break
        }
        if (r.status === 'denied') {
          this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] 用户取消登录')
          // 不立刻重试，等一会
          await sleep(10_000)
          break
        }
        // pending 继续
      }
      if (++retries >= 12) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] 登录重试次数过多，放弃')
        return
      }
    }
  }

  async _requestLoginQr() {
    const data = await this._request('GET', 'ilink/bot/get_bot_qrcode', {
      params: { bot_type: this.botType },
      tokenRequired: false,
      timeoutMs: API_TIMEOUT_MS,
    })
    const qr = String(data?.qrcode || '')
    const img = String(data?.qrcode_img_content || '')
    if (!qr) return null
    // qrcode_img_content 是登录链（AstrBot 也这么用），用 qrserver 渲染成 PNG
    this.qrContent = img
    this.qrPng = null
    this.qrUpdatedAt = Date.now()
    if (img) {
      try {
        const url = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=8&data=${encodeURIComponent(img)}`
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
        if (resp.ok) {
          this.qrPng = Buffer.from(await resp.arrayBuffer())
        }
      } catch {}
    }
    return { qrcode: qr, img }
  }

  get qrPageUrl() {
    return `${API_PREFIX}/weixin_oc/qrcode.png`
  }

  async _pollQrOnce(qrcode) {
    const data = await this._request('GET', 'ilink/bot/get_qrcode_status', {
      params: { qrcode },
      tokenRequired: false,
      timeoutMs: LONG_POLL_MS,
      headers: QR_POLL_HEADER,
    })
    const raw = String(data?.status || 'wait')
    if (raw === 'confirmed') {
      const bot_token = String(data?.bot_token || '')
      if (!bot_token) return { status: 'error' }
      return {
        status: 'created',
        weixin_oc_token: bot_token,
        weixin_oc_account_id: String(data?.ilink_bot_id || ''),
        weixin_oc_base_url: String(data?.baseurl || this.baseUrl),
        weixin_oc_user_id: String(data?.ilink_user_id || ''),
      }
    }
    if (raw === 'expired') return { status: 'expired' }
    if (['cancel', 'canceled', 'denied'].includes(raw)) return { status: 'denied' }
    return { status: 'pending' }
  }

  _printQr(qr) {
    // 简易 ASCII 框 + 二维码内容字符串，用户也可自行用其它工具扫 qr.qrcode
    const line = '─'.repeat(48)
    this.ctx?.logger?.info?.(
      '\n%s\n  请用个人微信扫码登录(有效期约 5 分钟,过期自动刷新)\n%s\n浏览器查看: http://127.0.0.1:3080%s\n二维码内容: %s\n%s',
      line,
      line,
      this.qrPageUrl,
      qr.qrcode,
      line,
    )
  }

  // —— inbound 长轮询主循环 ——
  async _pollInboundLoop() {
    if (this.polling) return
    this.polling = true
    let errorStreak = 0
    while (!this.closed) {
      // 重登期间无 token：等登录流程产出，不打空 API
      if (!this.token) {
        await sleep(5_000)
        continue
      }
      try {
        await this._pollInboundOnce()
        errorStreak = 0
      } catch (e) {
        // 连续错误指数退避（封顶 30s）：断网/服务端异常时不再固定节奏打点
        errorStreak++
        this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] inbound 轮询错误(连续 %d): %s', errorStreak, e?.message || e)
        await sleep(backoffDelayMs(errorStreak, 5000))
      }
    }
    this.polling = false
  }

  async _pollInboundOnce() {
    const data = await this._request('POST', 'ilink/bot/getupdates', {
      payload: {
        base_info: { channel_version: 'dsh-omnibridge' },
        get_updates_buf: this.syncBuf,
        // 部分 iLink 版本要求同时带 sync_buf，否则不推进游标
        sync_buf: this.syncBuf,
      },
      tokenRequired: true,
      timeoutMs: LONG_POLL_MS,
    })
    if (!this._isSuccess(data)) {
      const msg = data?.base_resp?.err_msg || data?.errmsg || JSON.stringify(data).slice(0, 200)
      this.ctx?.logger?.warn?.('[dsh-omnibridge:weixin_oc] getupdates 失败: %s', msg)
      // session 超时通常意味着 token 失效，触发重新登录
      if (this._isSessionTimeout(data)) {
        this.token = ''
        this._writeState({ token: '' })
        void this._loginFlow().catch(() => {})
      }
      await sleep(5_000)
      return
    }
    let dirty = false
    // 优先 sync_buf（iLink 实际 ack 推进字段），回退 get_updates_buf（AstrBot 兼容字段）
    const newBuf = (typeof data?.sync_buf === 'string' && data.sync_buf) ? data.sync_buf
      : (typeof data?.get_updates_buf === 'string' && data.get_updates_buf) ? data.get_updates_buf : ''
    if (newBuf) {
      this.syncBuf = newBuf
      dirty = true
    }
    const msgs = Array.isArray(data?.msgs) ? data.msgs : []
    for (const msg of msgs) {
      if (this.closed) return
      if (!msg || typeof msg !== 'object') continue
      this._handleInbound(msg).catch(() => {})
    }
    if (dirty) this._schedulePersist()
  }

  _isSessionTimeout(data) {
    // iLink session 失效常见 errcode，不同版本可能不同，保守判定
    const code = data?.errcode ?? data?.base_resp?.ret
    return typeof code === 'number' && (code === -102 || code === 110 || code === 4001)
  }

  _handleInbound(msg) {
    const fromUserId = String(msg?.from_user_id ?? '').trim()
    if (!fromUserId) return
    // 出站发送必须带 context_token，inbound 来了就记下
    const ctxTok = String(msg?.context_token ?? '').trim()
    if (ctxTok && this.contextTokens.get(fromUserId) !== ctxTok) {
      this.contextTokens.set(fromUserId, ctxTok)
      this._schedulePersist()
    }
    const itemList = Array.isArray(msg?.item_list) ? msg.item_list : []
    const text = this._textFromItems(itemList)
    if (!text) return
    const messageId = String(msg?.message_id || msg?.msg_id || randomUUID())
    this.bridge?.handleInbound(new InboundMessage({
      platform: 'weixin_oc',
      sessionKey: `wxoc:${fromUserId}`,
      senderId: fromUserId,
      senderName: fromUserId,
      text,
      raw: { target: fromUserId, messageId },
    }))
  }

  // 把 item_list 里的 type=1 文本 item 拼成纯文本
  _textFromItems(itemList) {
    let parts = []
    for (const item of itemList) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 1 && item.text_item?.text) parts.push(String(item.text_item.text))
    }
    return parts.join('').trim()
  }

  // —— outbound ——
  async send(target, text) {
    if (!this.token) throw new Error('weixin_oc 未登录，无法发送')
    const userId = String(target)
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) {
      throw new Error(`weixin_oc 缺少 ${userId} 的 context_token（需对方先发消息刷新）`)
    }
    const chunks = splitForDelivery(text, 1800)
    for (const chunk of chunks) {
      await this._sendOne(userId, contextToken, chunk)
    }
  }

  async _sendOne(userId, contextToken, text) {
    const payload = {
      base_info: { channel_version: 'dsh-omnibridge' },
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: randomUUID().replace(/-/g, ''),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    }
    const data = await this._request('POST', 'ilink/bot/sendmessage', {
      payload,
      tokenRequired: true,
      timeoutMs: API_TIMEOUT_MS,
    })
    if (!this._isSuccess(data)) {
      const msg = data?.base_resp?.err_msg || data?.errmsg || JSON.stringify(data).slice(0, 200)
      throw new Error(`weixin_oc sendmessage 失败: ${msg}`)
    }
  }

  async stop() {
    this.closed = true
    // 长轮询靠 AbortSignal.timeout 自然超时，无需显式 cancel
    this._flushPersist()
    if (this.routeCtx && typeof this.routeCtx.dispose === 'function') {
      try { await this.routeCtx.dispose() } catch {}
    }
    this.routeCtx = null
  }
}
