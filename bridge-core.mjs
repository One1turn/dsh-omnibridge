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
  constructor({ platform, sessionKey, senderId, senderName, text, raw, replyToken }) {
    this.platform = platform
    this.sessionKey = sessionKey
    this.senderId = senderId
    this.senderName = senderName || senderId
    this.text = text || ''
    this.raw = raw
    this.replyToken = replyToken || null
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
    '/sessions — 列出当前桥的会话',
    '/switch <id> — 切换活动会话',
    '/status — 当前活动会话',
    '/gc [分钟] — 清理闲置超时的会话（默认 30 分钟）',
    '/model [provider/]model — 查看/切换模型（如 /model ai/gpt-5.6-luna）',
    '/help — 本帮助',
  ]
  if (config.allowedCommands?.length) {
    lines.push('自定义命令：' + config.allowedCommands.join(' '))
  }
  return lines.join('\n')
}

/** 解析 allowFrom 为规范化数组（保留条目原值，便于平台级匹配）。 */
function parseAllowList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) return raw.split(/[,，;；\s]+/).filter(Boolean)
  return []
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
   * 白名单判定。支持：
   *  - '*'：放行所有
   *  - '<senderId>'：精确匹配发送者（平台原始 id）
   *  - '<platform>:*'：放行整个平台（如 onebot:*）
   *  - '<platform>:<id>'：平台 + 平台内 id 精确匹配（如 tg:12345）
   *  支持转发等带前缀的 senderId：若 senderId 形如 'onebot:12345'，则同时匹配 'onebot:*' 精确段。
   * 空表 = 拒绝一切（安全边界）。
   */
  isAllowed(msg) {
    const allow = this.allowFrom()
    if (allow.length === 0) return false
    if (allow.includes('*')) return true
    if (allow.includes(msg.senderId)) return true
    // 平台级匹配：用消息平台的 id（this 是 channel 维度，msg.platform 即 channelId）
    if (allow.includes(`${msg.platform}:*`)) return true
    // 兼容 senderId 形如 "platform:id" 的情况
    if (msg.senderId && msg.senderId.includes(':')) {
      const [plat] = msg.senderId.split(':')
      if (plat && allow.includes(`${plat}:*`)) return true
    }
    if (allow.includes(`${msg.platform}:${msg.senderId}`)) return true
    return false
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
    const text = (msg.text || '').trim()
    if (!text) return

    // 白名单
    if (!this.isAllowed(msg)) {
      this.ctx.logger?.debug?.('[dsh-omnibridge] 拒绝未加白发送方 %s', msg.senderId)
      return
    }

    // 速率限制（命令也限，防止刷屏注入）
    if (!this.limiter.allow(msg.senderId)) {
      if (this.config.rateLimit?.silent !== true) {
        await this.reply(msg, '⏳ 请求过于频繁，请稍后再试。').catch(() => {})
      }
      return
    }

    // 命令
    if (text.startsWith('/')) {
      await this.handleCommand(msg, text)
      return
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
    const userMsg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(userMsg)
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
      switch (cmd) {
        case '/help': {
          await this.reply(msg, helpText(this.config))
          return
        }
        case '/new': {
          await this.createSession(msg, arg)
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
