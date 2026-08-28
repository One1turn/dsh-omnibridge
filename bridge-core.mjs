/**
 * dsh-omnibridge bridge-core：综合消息桥核心（架构参考 AstrBot Platform 抽象）。
 *
 * - Channel：平台适配器基类（对标 AstrBot 的 Platform）——实现 start() 监听
 *   平台消息、send() 出站发送、meta() 元信息。
 * - InboundMessage：统一入站消息模型（对标 AstrBotMessage 精简版）。
 * - Bridge：会话路由 + 白名单（平台级通配 + 精确 id）+ 速率限制 + 命令 +
 *   DSH turn 桥接（agent.followup）+ 出站（session/event → channel.send）。
 *
 * 安全边界（同 AstrBot 的权限意识）：allowFrom 为空时拒绝一切入站——
 * 一个允许任何人驱动本地 agent 的桥就是提示注入前门。
 *
 * @module dsh-omnibridge/bridge-core
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 平台 Channel 基类（对标 AstrBot Platform）。 */
export class Channel {
  constructor(id, config) {
    this.id = id
    this.config = config || {}
    this.enabled = this.config.enabled !== false
  }

  /** 启动平台监听（子类实现）。 */
  async start(ctx, bridge) {}

  /** 停止监听（子类实现）。 */
  async stop() {}

  /** 发送文本到平台会话（子类实现）。 */
  async send(target, text) {}

  /** 平台元信息。 */
  meta() {
    return { id: this.id, name: this.config.name || this.id, enabled: this.enabled }
  }
}

/** 统一入站消息（对标 AstrBotMessage 精简）。 */
export class InboundMessage {
  constructor({ platform, sessionKey, senderId, senderName, text, raw, replyToken, images }) {
    this.platform = platform
    this.sessionKey = sessionKey
    this.senderId = senderId
    this.senderName = senderName || senderId
    this.text = text || ''
    this.raw = raw
    this.replyToken = replyToken || null
    /**
     * 入站图片描述列表（channel 只负责提取，Bridge 统一取字节并经 attachments 落库）：
     * { url?: 'https://…' } 或 { dataUrl?: 'data:image/png;base64,…' }，均可带 name。
     */
    this.images = Array.isArray(images) && images.length ? images : null
    this.timestamp = Date.now()
  }
}

/** 会话 id 生成：平台前缀 + 时间 + 随机。 */
export function newSessionId(platform) {
  return `${platform}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 默认命令帮助。 */
export function helpText(config) {
  const lines = [
    '🤖 dsh-omnibridge 命令：',
    '/new <提示词> — 新建会话并开始',
    '/reset — 重置当前会话（清空上下文重新开始）',
    '/sessions — 列出当前桥的会话（管理员）',
    '/switch <id> — 切换活动会话（管理员）',
    '/status — 当前活动会话',
    '/gc [分钟] — 清理闲置超时的会话路由（管理员，默认 30 分钟）',
    '/model [provider/]model — 查看/切换模型（管理员，如 /model ai/gpt-5.6-luna）',
    '/help — 本帮助',
  ]
  if (config.allowedCommands?.length) {
    lines.push('自定义命令：' + config.allowedCommands.join(' '))
  }
  if (config.admins?.length) {
    lines.push('提示：标注（管理员）的命令仅限 admins 名单内的发送者使用。')
  }
  return lines.join('\n')
}

/** 解析 allowFrom 为规范化数组（保留条目原值，便于平台级匹配）。 */
function parseAllowList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) return raw.split(/[,，;；\s]+/).filter(Boolean)
  return []
}

/** 管理员专属命令集（对齐 AstrBot 权限分级）。 */
const ADMIN_COMMANDS = new Set(['/model', '/gc', '/sessions', '/switch'])

/**
 * 唤醒前缀匹配（对齐 AstrBot waking 的前缀模式）：命中最长前缀即剥离。
 * 未配置前缀时视为全部匹配（行为与不启用完全一致）。
 * @returns {{ matched: boolean, rest: string }} matched=false 表示未携带任何前缀
 */
export function applyWakePrefixes(text, prefixes) {
  const list = (Array.isArray(prefixes) ? prefixes : [])
    .map((p) => String(p))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (!list.length) return { matched: true, rest: text }
  for (const p of list) {
    if (text.startsWith(p)) return { matched: true, rest: text.slice(p.length).trim() }
  }
  return { matched: false, rest: '' }
}

// —— 入站媒体：主机安全防护 + 字节来源解析 ——

/** 视为私网/本机的 hostname（尽力而为的字面量检查，DNS rebinding 不在此防线内）。 */
const PRIVATE_HOST_RE = /^(localhost|::1|\[::1\]|0\.0\.0\.0|(?:127|10)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/i

/**
 * 入站图片抓取地址防护：仅 http(s)，默认拒绝 loopback/私网地址字面量。
 * 自托管平台（如本机 NapCat）的局域网媒体地址可用 mediaAllowPrivateHosts 放行。
 */
export function isInboundImageUrlAllowed(rawUrl) {
  let u
  try { u = new URL(String(rawUrl)) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return !PRIVATE_HOST_RE.test(u.hostname)
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i

/** 解析 data:image/*;base64,... → attachments 输入；非法返回 null。 */
export function decodeImageDataUrl(dataUrl) {
  const m = DATA_URL_RE.exec(String(dataUrl || '').trim())
  if (!m) return null
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) return null
  return { data: new Uint8Array(buf), mediaType: m[1].toLowerCase() }
}

const EXT_MEDIA_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** 从响应 Content-Type 或 URL 扩展名推断图片媒体类型；推断不出返回 null。 */
export function imageMediaTypeFrom(contentType, urlPath) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/')) return ct
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(urlPath || ''))
  return ext ? (EXT_MEDIA_TYPE[ext[1].toLowerCase()] || null) : null
}

/** 速率限制器：每 senderId 一个滑动窗口。 */
class RateLimiter {
  constructor(maxPerWindow, windowMs) {
    this.maxPerWindow = Math.max(0, maxPerWindow | 0)
    this.windowMs = Math.max(0, windowMs | 0) || 60000
    this.buckets = new Map() // senderId -> number[]
  }
  /** 返回 true 表示放行，false 表示已被限速。 */
  allow(senderId) {
    if (this.maxPerWindow <= 0) return true
    const now = Date.now()
    let arr = this.buckets.get(senderId)
    if (!arr) {
      arr = []
      this.buckets.set(senderId, arr)
    }
    const cutoff = now - this.windowMs
    let i = 0
    while (i < arr.length && arr[i] <= cutoff) i++
    if (i > 0) arr.splice(0, i)
    if (arr.length >= this.maxPerWindow) return false
    arr.push(now)
    return true
  }
  forget(senderId) { this.buckets.delete(senderId) }
  clear() { this.buckets.clear() }
}

/** 入站图片下载超时。 */
const MEDIA_FETCH_TIMEOUT_MS = 15000

/**
 * Bridge：综合桥主体。
 * @param {object} ctx Cordis Context
 * @param {object} config 插件配置
 * @param {Channel[]} channels 已实例化的 channel 列表
 */
export class Bridge {
  constructor(ctx, config, channels) {
    this.ctx = ctx
    this.config = config
    this.channels = channels
    this.allowList = parseAllowList(this.config.allowFrom)
    this.adminList = parseAllowList(this.config.admins)
    /** sessionKey → { sessionId, target, channel, replyToken, lastActive } */
    this.routes = new Map()
    /** sessionId → route（反向） */
    this.routesBySession = new Map()
    this.disposers = []

    // 速率限制
    const rl = config.rateLimit || {}
    this.limiter = new RateLimiter(
      Number(rl.maxPerMinute) || 0,
      Number(rl.windowMs) || 60000,
    )

    // 校验白名单
    const allow = this.allowFrom()
    if (allow.length === 0) {
      ctx.logger?.warn?.('[dsh-omnibridge] allowFrom 未配置——所有平台消息将被忽略。配置 allowFrom 才能驱动 agent（安全边界）。')
    }
  }

  allowFrom() {
    return this.allowList
  }

  /**
   * 名单匹配共享逻辑（allowFrom / admins 同语法）。支持：
   *  - '*'：放行所有
   *  - '<senderId>'：精确匹配发送者（平台原始 id）
   *  - '<platform>:*'：放行整个平台（如 onebot:*）
   *  - '<platform>:<id>'：平台 + 平台内 id 精确匹配（如 tg:12345）
   * 兼容 senderId 形如 "platform:id" 的转发场景。空表 = 不匹配任何人。
   */
  _match(list, msg) {
    if (!list.length) return false
    if (list.includes('*')) return true
    if (list.includes(msg.senderId)) return true
    if (list.includes(`${msg.platform}:*`)) return true
    if (msg.senderId && msg.senderId.includes(':')) {
      const [plat] = msg.senderId.split(':')
      if (plat && list.includes(`${plat}:*`)) return true
    }
    return list.includes(`${msg.platform}:${msg.senderId}`)
  }

  /** 白名单判定（空表 = 拒绝一切，安全边界）。 */
  isAllowed(msg) {
    return this._match(this.allowList, msg)
  }

  /**
   * 管理员判定。admins 未配置时白名单内全员视为管理员（兼容单人部署现状）；
   * 配置后受限命令（/model /gc /sessions /switch）仅名单成员可用。
   */
  isAdmin(msg) {
    if (!this.adminList.length) return true
    return this._match(this.adminList, msg)
  }

  /** 启动所有 channel。 */
  async start() {
    for (const ch of this.channels) {
      if (!ch.enabled) continue
      try {
        await ch.start(this.ctx, this)
        this.ctx.logger?.info?.('[dsh-omnibridge] channel %s started', ch.id)
      } catch (error) {
        this.ctx.logger?.error?.('[dsh-omnibridge] channel %s start failed: %s', ch.id, error instanceof Error ? error.message : String(error))
      }
    }
    this.attachOutbound()

    // 会话自动清理：周期性 GC 超过 TTL 的空闲会话（仅当配置了 sessionTtlMinutes>0）
    const ttl = Number(this.config?.sessionTtlMinutes) || 0
    if (ttl > 0) {
      const intervalMs = Math.max(60, ttl) * 60 * 1000
      const timer = setInterval(() => {
        try { this.gc(ttl) } catch (e) {
          this.ctx.logger?.warn?.('[dsh-omnibridge] session TTL gc error: %s', e instanceof Error ? e.message : String(e))
        }
      }, intervalMs)
      timer.unref?.()
      this.disposers.push(() => clearInterval(timer))
      this.ctx.logger?.info?.('[dsh-omnibridge] session TTL gc armed (%d min interval)', ttl)
    }
  }

  /** 停止所有 channel。 */
  async stop() {
    for (const d of this.disposers) { try { d() } catch {} }
    this.disposers = []
    for (const ch of this.channels) { try { await ch.stop() } catch {} }
    this.limiter.clear()
  }

  /** 入站统一入口（channel 调用）。 */
  async handleInbound(msg) {
    if (!(msg instanceof InboundMessage)) return
    let text = (msg.text || '').trim()
    const hasImages = !!msg.images?.length
    if (!text && !hasImages) return

    // 白名单
    if (!this.isAllowed(msg)) {
      this.ctx.logger?.debug?.('[dsh-omnibridge] 拒绝未加白发送方 %s', msg.senderId)
      return
    }

    // 唤醒前缀（对齐 AstrBot waking check）：配置后普通文本消息必须携带任一前缀；
    // '/' 命令与纯图消息豁免（纯图无文本可剥）
    if (text && !text.startsWith('/')) {
      const wake = applyWakePrefixes(text, this.config.wakePrefixes)
      if (!wake.matched || !wake.rest.trim()) return
      text = wake.rest.trim()
    }

    // 速率限制（命令也限，防止刷屏注入）
    if (!this.limiter.allow(msg.senderId)) {
      if (this.config.rateLimit?.silent !== true) {
        await this.reply(msg, '⏳ 请求过于频繁，请稍后再试。').catch(() => {})
      }
      return
    }

    // 命令（只看文本；纯图片消息不可能命中命令分支）
    if (text.startsWith('/')) {
      await this.handleCommand(msg, text)
      return
    }

    // 图片落库：先于 turn 提交。附件服务缺失/全部失败时按有无文本决定降级或拒收
    let imageBlocks = []
    if (hasImages) {
      try {
        imageBlocks = await this.resolveImages(msg)
      } catch (error) {
        this.ctx.logger?.warn?.('[dsh-omnibridge] 图片接收不可用: %s', error instanceof Error ? error.message : String(error))
        if (!text) {
          await this.reply(msg, `⚠️ 图片接收失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
      if (!imageBlocks.length && !text) {
        await this.reply(msg, '⚠️ 图片全部接收失败，未处理该消息。')
        return
      }
    }

    // 路由到 agent
    const route = this.routeFor(msg)
    route.lastActive = Date.now()
    // 每条入站刷新 reply token（如 LINE 的一次性 replyToken，随消息更新）
    if (msg.replyToken || msg.raw?.replyToken) {
      route.replyToken = msg.replyToken || msg.raw?.replyToken
    }
    let agent
    try {
      agent = await this.ensureAgent(route)
    } catch (error) {
      this.ctx.logger?.error?.('[dsh-omnibridge] ensureAgent failed: %s', error instanceof Error ? error.stack : String(error))
      await this.reply(msg, `❌ 无法连接 agent：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!agent) {
      await this.reply(msg, '💤 会话正在准备中，请稍后重试，或发送 /new <提示词> 新建会话。')
      return
    }
    const content = []
    if (text) content.push({ type: 'text', text })
    content.push(...imageBlocks)
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
  }

  /**
   * 入站图片 → attachments 落库 → image 内容块（对齐 AstrBot 图片组件入站）。
   * attachments 服务缺失时抛错，由调用方决定降级；单张失败跳过不阻塞其余。
   */
  async resolveImages(msg) {
    const store = this.ctx.attachments
    if (!store?.saveImage) throw new Error('附件存储服务不可用（ctx.attachments 缺失）')
    const limits = store.imageLimits || {}
    const maxImages = Math.max(1, Number(limits.maxImagesPerMessage) || 4)
    const maxBytes = Math.max(1024, Number(limits.maxImageBytes) || 10 * 1024 * 1024)
    const blocks = []
    for (const img of msg.images.slice(0, maxImages)) {
      try {
        const input = await this._inboundImageInput(img, maxBytes)
        blocks.push({ type: 'image', attachment: await store.saveImage(input) })
      } catch (error) {
        this.ctx.logger?.warn?.('[dsh-omnibridge] 图片落库失败(%s): %s',
          img?.name || img?.url || 'unnamed', error instanceof Error ? error.message : String(error))
      }
    }
    return blocks
  }

  /** 单张图片描述 → SaveImageAttachment 输入（dataUrl 解码或 url 拉取，含尺寸/类型校验）。 */
  async _inboundImageInput(img, maxBytes) {
    const name = img?.name ? String(img.name).slice(0, 120) : undefined
    if (img?.dataUrl) {
      const decoded = decodeImageDataUrl(img.dataUrl)
      if (!decoded) throw new Error('无法解析的 dataUrl')
      if (decoded.data.byteLength > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节上限`)
      return { ...decoded, ...(name ? { name } : {}) }
    }
    const url = String(img?.url || '')
    if (!url) throw new Error('图片缺少 url/dataUrl')
    if (!this.config.mediaAllowPrivateHosts && !isInboundImageUrlAllowed(url)) {
      throw new Error('地址被媒体安全策略拒绝（私网/非 http(s)；自托管平台可用 mediaAllowPrivateHosts 放行）')
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) })
    if (!resp.ok) throw new Error(`下载失败 status ${resp.status}`)
    const declaredLen = Number(resp.headers.get('content-length')) || 0
    if (declaredLen > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节上限`)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节上限`)
    const mediaType = imageMediaTypeFrom(resp.headers.get('content-type'), url)
    if (!mediaType) throw new Error('无法识别图片类型（响应头与扩展名均无 image 信息）')
    return { data: new Uint8Array(buf), mediaType, ...(name ? { name } : {}) }
  }

  // 确保 session 存在：已有则复用，没有则创建。避免重复 create 报 already exists。
  // 同一 session 并发创建用 in-flight promise 去重（快速连发两条消息的常见竞态）。
  async ensureAgent(route) {
    if (route.agentPromise) return route.agentPromise
    const existing = this.ctx.agents.get(route.sessionId)
    if (existing) return existing
    const p = (async () => {
      const meta = {}
      if (this.config.cwd) meta.cwd = this.config.cwd
      if (this.config.agentPreset) meta.agentPreset = this.config.agentPreset
      try {
        const handle = await this.ctx.agents.create({
          sessionId: route.sessionId,
          meta,
          agentOptions: {
            ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
            ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
          },
        })
        if (handle?.id) route.createdId = String(handle.id)
        return this.ctx.agents.get(route.sessionId) || handle?.agent
      } catch (error) {
        // 已存在（或多进程竞争）→ 直接复用
        const agent = this.ctx.agents.get(route.sessionId)
        if (agent) return agent
        throw error
      }
    })().finally(() => { if (route.agentPromise === p) route.agentPromise = null })
    route.agentPromise = p
    return p
  }

  /** 会话路由：懒创建。返回 route（已存在或新创建）。 */
  routeFor(msg) {
    let route = this.routes.get(msg.sessionKey)
    if (route) return route
    const sessionId = newSessionId(msg.platform)
    route = {
      sessionId,
      target: msg.raw?.target ?? msg.sessionKey,
      channelId: msg.platform,
      replyToken: msg.replyToken || msg.raw?.replyToken || null,
      lastActive: Date.now(),
    }
    this.routes.set(msg.sessionKey, route)
    this.routesBySession.set(sessionId, route)
    return route
  }

  /** 通过 channel 回复消息来源（优先单次 reply token，如 LINE）。 */
  async reply(msg, text) {
    const ch = this.channelOf(msg.platform)
    if (!ch) return
    const token = msg.replyToken || msg.raw?.replyToken
    const target = token ? `reply:${token}` : (msg.raw?.target ?? msg.sessionKey)
    await ch.send(target, text)
  }

  channelOf(id) {
    return this.channels.find((c) => c.id === id && c.enabled)
  }

  /** 命令处理。 */
  async handleCommand(msg, text) {
    try {
      const [cmd, ...rest] = text.split(/\s+/)
      const arg = rest.join(' ').trim()
      // 管理员分级（对齐 AstrBot 权限体系）：admins 为空时全员即管理员
      if (ADMIN_COMMANDS.has(cmd) && !this.isAdmin(msg)) {
        await this.reply(msg, '⛔ 该命令需要管理员权限。')
        return
      }
      switch (cmd) {
        case '/help': {
          await this.reply(msg, helpText(this.config))
          return
        }
        case '/new': {
          await this.createSession(msg, arg)
          return
        }
        case '/reset': {
          await this.resetSession(msg)
          return
        }
        case '/sessions': {
          const list = []
          let i = 0
          for (const [key, route] of this.routes) {
            if (i++ >= 20) { list.push(`…另有 ${this.routes.size - 20} 个会话未列出`); break }
            list.push(`${route.sessionId}  ← ${key}`)
          }
          await this.reply(msg, list.length ? '会话列表：\n' + list.join('\n') : '暂无会话。发送 /new <提示词> 新建。')
          return
        }
        case '/switch': {
          if (!arg) { await this.reply(msg, '用法：/switch <sessionId>'); return }
          // 在已有路由中查找
          for (const [key, route] of this.routes) {
            if (route.sessionId === arg) {
              this.routes.delete(key)
              // 重绑到当前发送渠道：否则跨平台 /switch 后回复仍走原 channel（发错平台）
              const rebound = {
                ...route,
                channelId: msg.platform,
                target: msg.raw?.target ?? msg.sessionKey,
                replyToken: msg.replyToken || msg.raw?.replyToken || null,
                lastActive: Date.now(),
              }
              this.routes.set(msg.sessionKey, rebound)
              this.routesBySession.set(route.sessionId, rebound)
              await this.reply(msg, `✅ 已切换到 ${route.sessionId}`)
              return
            }
          }
          await this.reply(msg, `❌ 未找到会话 ${arg}，发送 /sessions 查看列表`)
          return
        }
        case '/status': {
          const route = this.routes.get(msg.sessionKey)
          await this.reply(msg, route ? `当前会话：${route.sessionId}` : '当前无会话。发送 /new <提示词> 新建。')
          return
        }
        case '/gc': {
          const minutes = Number(arg) > 0 ? Number(arg) : 30
          const removed = this.gc(minutes)
          await this.reply(msg, `🧹 已清理 ${removed} 个闲置超过 ${minutes} 分钟的会话路由。`)
          return
        }
        case '/model': {
          await this.handleModelCommand(msg, arg)
          return
        }
        default:
          // 不回显未知命令到有 reply token 的一次性渠道，只给提示
          await this.reply(msg, `未知命令 ${cmd}。发送 /help 查看。`)
      }
    } catch (error) {
      this.ctx.logger?.error?.('[dsh-omnibridge] command %s failed: %s', text.slice(0, 40), error instanceof Error ? error.message : String(error))
      await this.reply(msg, `❌ 命令执行出错：${error instanceof Error ? error.message : String(error)}`).catch(() => {})
    }
  }

  /** 清理闲置超时的会话路由（停止对应 agent）。返回清理数量。 */
  gc(minutes) {
    const cutoff = Date.now() - minutes * 60 * 1000
    let removed = 0
    for (const [key, route] of [...this.routes]) {
      if ((route.lastActive || 0) < cutoff) {
        try {
          const agent = this.ctx.agents.get(route.sessionId)
          if (agent?.dispose) agent.dispose()
        } catch {}
        this.routes.delete(key)
        this.routesBySession.delete(route.sessionId)
        removed++
      }
    }
    return removed
  }

  /** 面向状态 API 的精简摘要（避免序列化活对象，只取叶子字段）。 */
  statusSummary() {
    const rl = this.config?.rateLimit || {}
    const routes = []
    for (const [key, route] of this.routes) {
      routes.push({
        sessionKey: key,
        sessionId: route.sessionId || null,
        channel: route.channelId || null,
        lastActive: route.lastActive || null,
        idleSeconds: route.lastActive ? Math.max(0, Math.round((Date.now() - route.lastActive) / 1000)) : null,
      })
    }
    return {
      rateLimit: {
        maxPerMinute: rl.maxPerMinute || 0,
        windowMs: rl.windowMs || 60000,
        silent: !!rl.silent,
        trackedSenders: this.limiter.buckets.size,
      },
      sessionTtlMinutes: Number(this.config?.sessionTtlMinutes) || 0,
      routes: routes.length,
      routeDetails: routes,
    }
  }

  /** 切换模型：/model [provider/]model。走 DSH agentDefaultModel 官方切换。 */
  async handleModelCommand(msg, arg) {
    const service = this.ctx.get?.('agentDefaultModel')
    // 当前选择：优先 service（真实运行时），回退 config
    const current = service?.currentSelection?.() || {
      provider: this.config.agentProvider || '?',
      model: this.config.agentModel || '?',
    }
    if (!arg) {
      await this.reply(msg, `当前模型：${current.provider}/${current.model}`)
      return
    }
    // 解析 provider/model
    let provider = ''
    let model = ''
    if (arg.includes('/')) {
      const [p, ...rest] = arg.split('/')
      provider = p.trim()
      model = rest.join('/').trim()
    } else {
      provider = current.provider !== '?' ? current.provider : (this.config.agentProvider || '')
      model = arg.trim()
    }
    if (!model) {
      await this.reply(msg, '用法：/model <provider/model> 或 /model <model>')
      return
    }
    if (!provider) {
      await this.reply(msg, '无法确定 provider，请用 /model <provider>/<model> 格式')
      return
    }
    if (!service || typeof service.saveSelection !== 'function') {
      await this.reply(msg, '当前环境未提供模型切换能力（agentDefaultModel 缺失）')
      return
    }
    try {
      await service.saveSelection({ provider, model })
      this.config.agentProvider = provider
      this.config.agentModel = model
      await this.reply(msg, `✅ 已切换模型：${provider}/${model}（后续会话生效）`)
    } catch (error) {
      await this.reply(msg, `❌ 切换失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 重置当前绑定会话（对齐 AstrBot /reset 清空上下文语义）：
   * 释放旧 agent，route 重指新 sessionId，绑定关系与一次性 replyToken 一并清理。
   */
  async resetSession(msg) {
    const route = this.routes.get(msg.sessionKey)
    if (!route) {
      await this.reply(msg, '当前无会话，直接发消息即可开始。')
      return
    }
    const oldId = route.sessionId
    try {
      const oldAgent = this.ctx.agents.get(oldId)
      if (oldAgent?.dispose) oldAgent.dispose()
    } catch {}
    this.routesBySession.delete(oldId)
    route.sessionId = newSessionId(msg.platform)
    route.agentPromise = null
    route.replyToken = null
    route.lastActive = Date.now()
    this.routesBySession.set(route.sessionId, route)
    await this.reply(msg, `♻️ 会话已重置（原 ${oldId}），上下文已清空。直接发消息开始新对话。`)
  }

  /** 新建会话。 */
  async createSession(msg, prompt) {
    const route = this.routeFor(msg)
    try {
      const agent = await this.ensureAgent(route)
      route.lastActive = Date.now()
      if (prompt) {
        agent?.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await this.reply(msg, `✅ 已创建会话 ${route.sessionId}，开始处理…`)
      } else {
        await this.reply(msg, `✅ 已创建会话 ${route.sessionId}（无初始提示词）`)
      }
    } catch (error) {
      this.ctx.logger?.error?.('[dsh-omnibridge] createSession failed: %s', error instanceof Error ? error.stack : String(error))
      // routeFor 已写入路由，创建失败时回滚避免悬空
      this.routes.delete(msg.sessionKey)
      this.routesBySession.delete(route.sessionId)
      await this.reply(msg, `❌ 创建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 出站：session/event → channel.send。 */
  attachOutbound() {
    // 发送并统一捕获失败。reply token（如 LINE）是一次性的：首次出站用掉后
    // 立即清除，后续消息回退到常规 target（channel 需支持 push 类出站）。
    const sendOutbound = async (route, text) => {
      const ch = this.channelOf(route.channelId)
      if (!ch) return
      let sendTarget = route.target
      if (route.replyToken) {
        sendTarget = `reply:${route.replyToken}`
        route.replyToken = null
      }
      try {
        await this.sendChunks(ch, sendTarget, text, this.config.maxMessageChars || 2000)
      } catch (error) {
        this.ctx.logger?.warn?.('[dsh-omnibridge] outbound send failed: %s', error instanceof Error ? error.message : String(error))
      }
    }
    const onEvent = (session, event) => {
      const route = this.routesBySession.get(String(session.id))
      if (!route) return
      if (event.type === 'turn/start') {
        // 先挂「回合进行中」标记再发 ack：sendOutbound 同步执行到 ch.send()，
        // 顺序颠倒会让 ack 的静默期定时器抢在标记之前武装（wait=true 提前返回）
        const startCh = this.channelOf(route.channelId)
        try { startCh?.onTurnStart?.(route.target) } catch {}
        if (this.config.ackTurnStart !== false) void sendOutbound(route, '⏳ 收到，开始处理…')
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOfAssistantMessage(event.data?.message)
        if (text.trim()) {
          route.lastActive = Date.now()
          void sendOutbound(route, text)
        }
        return
      }
      if (event.type === 'turn/end') {
        const reason = event.data?.reason
        route.lastActive = Date.now()
        void (async () => {
          if (reason?.kind === 'error') {
            await sendOutbound(route, `❌ 处理出错：${summarizeError(reason.error)}`)
          } else if (reason?.kind === 'aborted') {
            await sendOutbound(route, '⏹ 已停止')
          } else if (reason?.kind === 'max-tokens') {
            await sendOutbound(route, '⚠️ 达到输出上限，本轮已截断')
          }
          // 通知 channel 本轮结束（先等出站投递完成，如 webchat wait=true 的同步等待）
          const ch = this.channelOf(route.channelId)
          try { ch?.onTurnEnd?.(route.target) } catch {}
        })()
      }
    }
    this.disposers.push(this.ctx.on('session/event', onEvent))
  }

  /** 按序发送分块文本（避免乱序与背压）。 */
  async sendChunks(ch, sendTarget, text, max) {
    for (const chunk of splitForDelivery(text, max)) {
      await ch.send(sendTarget, chunk)
    }
  }
}

/** 提取 assistant 消息文本（text + reasoning）。 */
function textOfAssistantMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  let out = ''
  for (const block of message.content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

function summarizeError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message).slice(0, 200)
  }
  return String(error).slice(0, 200)
}

/**
 * 简单分块（尽量保留代码块不拆，超长硬截断），供平台消息上限使用。
 *
 * 规则：
 *  - 当 max <= 0 视为无限制，返回原文。
 *  - 按行累加；当加入下一行会超过 max 时，先把当前块收口，再起新块。
 *  - 代码块（``` 围栏）跨越多块时，在每个新块开头补一个 ``` 语言标记，
 *    在被切走的块末尾补一个闭合 ```，保证每块都是合法的围栏段。
 *  - 单行本身超 max 时，按字符硬切分。
 *  - 不产生空块。
 */
export function splitForDelivery(content, max) {
  if (typeof content !== 'string') return []
  if (!max || max <= 0 || content.length <= max) return [content]

  // 把每行当作"行内容 + 尾换行"的基本单位，逐行累加；超界即收口块起新块。
  // 这样块内部与块边界都保留换行，blocks.join('') 可无损还原原文。
  const lines = content.split('\n')
  const units = []
  for (let i = 0; i < lines.length; i++) {
    // 除最后一行外，每行后续都跟一个换行；最后一行以原文是否以换行结尾决定
    const line = lines[i]
    const hasEol = i < lines.length - 1 || content.endsWith('\n')
    units.push(hasEol ? `${line}\n` : line)
  }

  const blocks = []
  let current = ''
  let inCode = false
  let codeLang = ''

  const fenceLang = (line) => {
    const m = /^```+\s*(.*)$/.exec(line.trim())
    return m ? m[1] : ''
  }
  const isFenceLine = (line) => /^```/.test(line.trim())

  for (const unit of units) {
    const linePart = unit.endsWith('\n') ? unit.slice(0, -1) : unit
    const isFence = isFenceLine(linePart)
    const candidate = current + unit
    if (current === '' || candidate.length <= max) {
      current = candidate
      if (isFence) {
        if (!inCode) codeLang = fenceLang(linePart)
        inCode = !inCode
      }
      continue
    }
    // 超界：收口 current（代码块内需补闭合围栏），起新块
    blocks.push(inCode ? `${current}\n${'```'}` : current)
    current = inCode ? `${'```'}${codeLang}\n${unit}` : unit
    if (isFence) {
      if (!inCode) codeLang = fenceLang(linePart)
      // 新块以围栏行开头，翻转状态
      inCode = !inCode
    }
  }
  if (current) blocks.push(inCode ? `${current}\n${'```'}` : current)

  // 兜底：任何残余超长块（单行硬超 max）按 max 硬切
  const out = []
  for (const b of blocks) {
    if (b.length <= max) { out.push(b); continue }
    for (let i = 0; i < b.length; i += max) out.push(b.slice(i, i + max))
  }
  return out
}
