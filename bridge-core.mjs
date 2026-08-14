/**
 * dsh-omnibridge bridge-core：综合消息桥核心（架构参考 AstrBot Platform 抽象）。
 *
 * - Channel：平台适配器基类（对标 AstrBot 的 Platform）——实现 start() 监听
 *   平台消息、send() 出站发送、meta() 元信息。
 * - InboundMessage：统一入站消息模型（对标 AstrBotMessage 精简版）。
 * - Bridge：会话路由 + 白名单 + 命令 + DSH turn 桥接（agent.followup）+
 *   出站（session/event → channel.send）。
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
    '/help — 本帮助',
  ]
  if (config.allowedCommands?.length) {
    lines.push('自定义命令：' + config.allowedCommands.join(' '))
  }
  return lines.join('\n')
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
    /** sessionKey → { sessionId, target, channel } */
    this.routes = new Map()
    /** sessionId → route（反向） */
    this.routesBySession = new Map()
    this.disposers = []

    // 校验白名单
    const allow = this.allowFrom()
    if (allow.length === 0) {
      ctx.logger?.warn?.('[dsh-omnibridge] allowFrom 未配置——所有平台消息将被忽略。配置 allowFrom 才能驱动 agent（安全边界）。')
    }
  }

  allowFrom() {
    const raw = this.config.allowFrom
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
    if (typeof raw === 'string' && raw.trim()) return raw.split(/[,，;；\s]+/).filter(Boolean)
    return []
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
  }

  /** 停止所有 channel。 */
  async stop() {
    for (const d of this.disposers) { try { d() } catch {} }
    for (const ch of this.channels) { try { await ch.stop() } catch {} }
  }

  /** 入站统一入口（channel 调用）。 */
  async handleInbound(msg) {
    if (!(msg instanceof InboundMessage)) return
    const text = (msg.text || '').trim()
    if (!text) return

    // 白名单
    const allow = this.allowFrom()
    if (allow.length > 0 && !allow.includes(msg.senderId) && !allow.includes('*')) {
      this.ctx.logger?.info?.('[dsh-omnibridge] ignored message from %s (not allowlisted)', msg.senderId)
      return
    }

    // 命令
    if (text.startsWith('/')) {
      await this.handleCommand(msg, text)
      return
    }

    // 路由到 agent
    const route = this.routeFor(msg)
    const agent = this.ctx.agents.get(route.sessionId)
    if (!agent) {
      await this.reply(msg, '💤 会话不存在。发送 /new <提示词> 新建会话，或 /help 查看命令。')
      return
    }
    const userMsg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(userMsg)
  }

  /** 会话路由：懒创建。 */
  routeFor(msg) {
    let route = this.routes.get(msg.sessionKey)
    if (route) return route
    const sessionId = newSessionId(msg.platform)
    route = {
      sessionId,
      target: msg.raw?.target ?? msg.sessionKey,
      channelId: msg.platform,
      replyToken: msg.replyToken || msg.raw?.replyToken || null,
    }
    this.routes.set(msg.sessionKey, route)
    this.routesBySession.set(sessionId, route)
    // 预创建 session + agent（首次入站时建立）
    const meta = {}
    if (this.config.cwd) meta.cwd = this.config.cwd
    if (this.config.agentPreset) meta.agentPreset = this.config.agentPreset
    this.ctx.agents.create({
      sessionId,
      meta,
      agentOptions: {
        ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
        ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
      },
    }).catch((error) => {
      this.ctx.logger?.error?.('[dsh-omnibridge] create agent %s failed: %s', sessionId, error instanceof Error ? error.message : String(error))
      this.routes.delete(msg.sessionKey)
      this.routesBySession.delete(sessionId)
    })
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
        for (const [key, route] of this.routes) {
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
            this.routes.set(msg.sessionKey, { ...route, target: msg.raw?.target ?? msg.sessionKey })
            this.routesBySession.set(route.sessionId, this.routes.get(msg.sessionKey))
            await this.reply(msg, `✅ 已切换到 ${route.sessionId}`)
            return
          }
        }
        await this.reply(msg, `❌ 未找到会话 ${arg}`)
        return
      }
      case '/status': {
        const route = this.routes.get(msg.sessionKey)
        await this.reply(msg, route ? `当前会话：${route.sessionId}` : '当前无会话。发送 /new <提示词> 新建。')
        return
      }
      default:
        await this.reply(msg, `未知命令 ${cmd}。发送 /help 查看。`)
    }
  }

  /** 新建会话。 */
  async createSession(msg, prompt) {
    const route = this.routeFor(msg)
    try {
      const handle = await this.ctx.agents.create({
        sessionId: route.sessionId,
        meta: this.config.cwd ? { cwd: this.config.cwd } : undefined,
        agentOptions: {
          ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
          ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
        },
      })
      if (prompt) {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await this.reply(msg, `✅ 已创建会话 ${route.sessionId}，开始处理…`)
      } else {
        await this.reply(msg, `✅ 已创建会话 ${route.sessionId}（无初始提示词）`)
      }
    } catch (error) {
      await this.reply(msg, `❌ 创建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 出站：session/event → channel.send。 */
  attachOutbound() {
    const onEvent = (session, event) => {
      const route = this.routesBySession.get(String(session.id))
      if (!route) return
      const ch = this.channelOf(route.channelId)
      if (!ch) return
      if (event.type === 'turn/start') {
        void ch.send(route.replyToken ? `reply:${route.replyToken}` : route.target, '⏳ 收到，开始处理…')
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOfAssistantMessage(event.data?.message)
        if (text.trim()) {
          const sendTarget = route.replyToken ? `reply:${route.replyToken}` : route.target
          for (const chunk of splitForDelivery(text, this.config.maxMessageChars || 2000)) {
            void ch.send(sendTarget, chunk)
          }
        }
        return
      }
      if (event.type === 'turn/end') {
        const reason = event.data?.reason
        if (!reason) return
        const sendTarget = route.replyToken ? `reply:${route.replyToken}` : route.target
        if (reason.kind === 'error') {
          void ch.send(sendTarget, `❌ 处理出错：${summarizeError(reason.error)}`)
        } else if (reason.kind === 'aborted') {
          void ch.send(sendTarget, '⏹ 已停止')
        } else if (reason.kind === 'max-tokens') {
          void ch.send(sendTarget, '⚠️ 达到输出上限，本轮已截断')
        }
      }
    }
    this.disposers.push(this.ctx.on('session/event', onEvent))
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

/** 简单分块（保留代码块不拆，超长硬截断），供平台消息上限使用。 */
export function splitForDelivery(content, max) {
  if (content.length <= max) return [content]
  const blocks = []
  let current = ''
  let inCode = false
  for (const line of content.split('\n')) {
    const isFence = /^```/.test(line.trim())
    if (isFence) inCode = !inCode
    const candidate = current ? `${current}\n${line}` : line
    if (candidate.length <= max || (inCode && !isFence)) {
      current = candidate
      continue
    }
    if (current) blocks.push(current)
    current = line
  }
  if (current) blocks.push(current)
  const out = []
  for (const b of blocks) {
    if (b.length > max) {
      for (let i = 0; i < b.length; i += max) out.push(b.slice(i, i + max))
    } else {
      out.push(b)
    }
  }
  return out
}
