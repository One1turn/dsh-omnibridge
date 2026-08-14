/**
 * dsh-omnibridge —— 综合消息桥（架构参考 AstrBot 多平台接入）。
 *
 * 一个插件把 DeepSeek Harness 接入多个聊天平台：
 *   - onebot    QQ（OneBot v11 WS 客户端，适配 NapCat / go-cqhttp / Lagrange）
 *   - telegram  Telegram（Bot API long polling）
 *   - webhook   通用 Webhook（飞书 / 企业微信 / 钉钉 / 自定义 JSON），
 *               入站走 DSH webServer，出站 POST 到机器人 webhook
 *
 * 配置（DSH_HOME/settings.yaml）：
 *   dsh-omnibridge:
 *     enabled: true
 *     allowFrom: []            # 必填安全意识：空=拒绝所有入站；'*'=放行所有
 *     agentPreset: coding      # 新会话 agent preset
 *     agentProvider: ~
 *     agentModel: ~
 *     cwd: ~
 *     maxMessageChars: 2000
 *     onebot:
 *       enabled: true
 *       url: ws://127.0.0.1:3001?access_token=%20
 *     telegram:
 *       enabled: false
 *       token: ''
 *     webhooks:
 *       - id: feishu
 *         enabled: false
 *         format: auto          # auto|feishu|wecom|dingtalk|custom
 *         path: /dsh-omnibridge/webhook/feishu
 *         outboundUrl: ''
 *
 * 状态/设置 API：
 *   GET  /dsh-omnibridge/status
 *   GET/POST /dsh-omnibridge/settings
 *
 * @module dsh-omnibridge
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { Bridge } from './bridge-core.mjs'
import { OneBotChannel } from './channels/onebot.mjs'
import { TelegramChannel } from './channels/telegram.mjs'
import { WebhookChannel } from './channels/webhook.mjs'
import { SatoriChannel } from './channels/satori.mjs'
import { WebchatChannel } from './channels/webchat.mjs'

const NAMESPACE = 'dsh-omnibridge'
const CONFIG_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'config.json')
const API_PREFIX = '/dsh-omnibridge'

export const name = 'dsh-omnibridge'
export const inject = ['settings', 'sessions', 'agents']

const webhookSchema = z.object({
  id: z.string().required(),
  enabled: z.boolean().default(true),
  format: z.enum(['auto', 'feishu', 'wecom', 'dingtalk', 'custom']).default('auto'),
  path: z.string().default(''),
  outboundUrl: z.string().default(''),
})

export const Config = z.object({
  enabled: z.boolean().default(true),
  allowFrom: z.array(z.string()).default([]),
  agentPreset: z.string().default(''),
  agentProvider: z.string().default(''),
  agentModel: z.string().default(''),
  cwd: z.string().default(''),
  maxMessageChars: z.number().default(2000),
  onebot: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default('ws://127.0.0.1:3001?access_token=%20'),
  }).default({}),
  telegram: z.object({
    enabled: z.boolean().default(false),
    token: z.string().default(''),
  }).default({}),
  webhooks: z.array(webhookSchema).default([]),
  satori: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default('http://127.0.0.1:5140'),
    token: z.string().default(''),
  }).default({}),
  webchat: z.object({
    enabled: z.boolean().default(false),
    path: z.string().default(''),
  }).default({}),
})

function readFileEnabled(fallback) {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof parsed.enabled === 'boolean') return parsed.enabled
  } catch {}
  return fallback
}
function writeFileEnabled(enabled) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ enabled }, null, 2), 'utf8')
}
function respondJson(response, status, value) {
  response.writeHead(status)
  response.end(JSON.stringify(value))
}
function requestJson(request) {
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

/** 实例化 channel 列表。 */
function buildChannels(config) {
  const channels = []
  channels.push(new OneBotChannel({
    ...(config.onebot || {}),
    name: 'QQ (OneBot v11)',
  }))
  channels.push(new TelegramChannel({
    ...(config.telegram || {}),
    name: 'Telegram',
  }))
  for (const wh of config.webhooks || []) {
    channels.push(new WebhookChannel(wh.id || 'webhook', {
      ...wh,
      name: `Webhook ${wh.id || ''}`.trim(),
    }))
  }
  channels.push(new SatoriChannel({
    ...(config.satori || {}),
    name: 'Satori (Discord/KOOK/Slack/Mattermost/Misskey...)',
  }))
  channels.push(new WebchatChannel('webchat', {
    ...(config.webchat || {}),
    name: 'WebChat (HTTP)',
  }))
  return channels
}

export function apply(ctx) {
  const scope = ctx.settings.register(NAMESPACE, Config, { applies: 'live' })
  let bridge = null

  const startBridge = () => {
    if (bridge) { void bridge.stop(); bridge = null }
    const cfg = scope.get()
    if (!readFileEnabled(cfg.enabled)) return
    bridge = new Bridge(ctx, cfg, buildChannels(cfg))
    void bridge.start()
  }

  // settings 变更时重建
  scope.on('update', () => startBridge())
  startBridge()

  ctx.inject(['webServer'], (routeCtx) => {
    // 状态
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
          const channels = bridge ? bridge.channels.map((c) => c.meta()) : []
          respondJson(response, 200, {
            enabled: readFileEnabled(scope.get().enabled),
            channels,
            routes: bridge ? bridge.routes.size : 0,
            allowFrom: bridge ? bridge.allowFrom() : [],
          })
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: status route')

    // 开关
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: async (request, response) => {
        try {
          const cfg = scope.get()
          if (request.method === 'GET' || request.method === 'HEAD') {
            respondJson(response, 200, { ...cfg, enabled: readFileEnabled(cfg.enabled) })
            return
          }
          if (request.method === 'POST') {
            const body = await requestJson(request)
            if (typeof body.enabled === 'boolean') {
              writeFileEnabled(body.enabled)
              startBridge()
            }
            respondJson(response, 200, { ...scope.get(), enabled: readFileEnabled(scope.get().enabled) })
            return
          }
          response.writeHead(405)
          response.end()
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: settings route')
  })
}

export { NAMESPACE, API_PREFIX }
