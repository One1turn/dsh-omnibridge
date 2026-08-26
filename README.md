# dsh-omnibridge

**综合消息桥**：一个插件把 DeepSeek Harness 接入 QQ / 微信 / 飞书 / Telegram / Discord / KOOK / LINE / Slack / 钉钉 / 企业微信 等 **19 个平台**，架构参考 [AstrBot](https://github.com/Soulter/AstrBot) 的多平台接入设计（Platform 抽象 + 统一消息模型 + 事件路由 + 白名单安全边界）。

**差异化**：DSH 生态里其他 IM 桥（telegram / dsh-weixin-bot / dsh-feishu-bot / dsh-im-bridge 等）都是单平台插件；这是唯一一个 AstrBot 式多平台综合桥。

## 平台覆盖矩阵（对标 AstrBot 19 平台）

| AstrBot 平台 | dsh-omnibridge channel | 方式 |
| --- | --- | --- |
| aiocqhttp（QQ） | `onebot` | OneBot v11 WS 客户端直连 NapCat/go-cqhttp ✓ |
| qqofficial（QQ 官方 bot） | `onebot` | NapCat 底层即 QQ 官方协议，同一 channel 覆盖 |
| qqofficial_webhook | `webhook` | format=`custom`，填官方回调 JSON 解析即可 |
| lark（飞书） | `webhook` | format=`feishu`，事件订阅 → DSH webServer ✓ |
| wecom（企业微信） | `webhook` | format=`wecom`，机器人 webhook ✓ |
| wecom_ai_bot（企微智能机器人） | `webhook` | format=`wecom_ai` ✓ |
| weixin_official_account（公众号） | `webhook` | format=`mp`，客服消息 API ✓ |
| weixin_oc（微信个人号） | `weixin_oc` | iLink 官方接口，自带扫码登录 ✓ |
| dingtalk（钉钉） | `webhook` | format=`dingtalk` ✓ |
| telegram | `telegram` | Bot API long polling ✓ |
| discord | `satori` | 经 Satori 网关（Chronocat 等）✓ |
| kook | `satori` | 经 Satori 网关 ✓ |
| line | `webhook` | format=`line`，Messaging API ✓ |
| slack | `satori` | 经 Satori 网关 ✓ |
| mattermost | `satori` | 经 Satori 网关 ✓ |
| misskey | `satori` | 经 Satori 网关 ✓ |
| satori | `satori` | Satori 协议直连 ✓ |
| webchat | `webchat` | HTTP 聊天端点（POST 入站 / GET 轮询出站）✓ |
| —— | `webchat` | 任意 HTTP 客户端接入（脚本/面板）|

> 备注：`webhook` channel 支持一个实例一个平台，可配置多个实例（`webhooks:` 数组）。

## 安装

```sh
dsh plugin --profile web add -w link:/path/to/dsh-omnibridge
```

要求 Node ≥ 22（WS 平台需要全局 WebSocket；Node 20 需 `--experimental-websocket`）。

## 配置（DSH_HOME/settings.yaml）

```yaml
dsh-omnibridge:
  enabled: true
  # ⚠️ 安全边界：空 = 拒绝所有入站；配置 QQ 号/Telegram id 白名单；'*' = 放行所有
  # 支持：'用户id'、'平台:id'（如 tg:12345）、'平台:*'（放行整个平台，如 onebot:*）；
  # senderId 形如 "平台:id" 时自动匹配对应 "平台:*" 通配
  allowFrom: []
  agentPreset: coding        # 新会话 preset
  agentProvider: ~           # 如 deepseek
  agentModel: ~              # 如 deepseek-chat
  cwd: ~                     # 新会话工作目录
  maxMessageChars: 2000      # 单条回复上限，超出自动分块

  # 速率限制（每个发送方滑动窗口）；maxPerMinute=0 = 不限速
  rateLimit:
    maxPerMinute: 0
    windowMs: 60000
    silent: false            # 命中限速时不回提示，仅记日志
  # 闲置路由自动清理分钟（>0 周期 GC 空闲会话）；0 = 仅手动 /gc
  sessionTtlMinutes: 0

  onebot:                    # QQ（NapCat 默认本机 3001 端口，token 为空格）
    enabled: true
    url: ws://127.0.0.1:3001?access_token=%20
    reconnectDelayMs: 5000

  telegram:
    enabled: false
    token: ''                # @BotFather 申请
    apiBase: ''              # 自定义 API 基址（留空=官方 api.telegram.org）
    pollIntervalMs: 1000

  satori:                    # Discord/KOOK/Slack/Mattermost/Misskey 等
    enabled: false
    baseUrl: http://127.0.0.1:5140
    token: ''
    reconnectDelayMs: 5000

  webchat:                   # HTTP 聊天端点
    enabled: false
    path: /dsh-omnibridge/webchat/webchat

  weixin_oc:                  # 个人微信（iLink 官方接口；自带扫码登录）
    enabled: false
    baseUrl: ''               # 留空=官方 https://ilinkai.weixin.qq.com
    token: ''                  # 留空=首次启动扫码，登录后自动写 weixin_oc.state.json

  webhooks:                  # 飞书/企微/钉钉/公众号/LINE，一个实例一平台
    - id: feishu
      enabled: false
      format: auto           # auto|feishu|wecom|wecom_ai|dingtalk|line|mp|custom
      path: /dsh-omnibridge/webhook/feishu
      outboundUrl: ''        # 机器人 webhook（wecom/dingtalk/feishu 机器人）
      channelAccessToken: '' # line 用
      mpAccessToken: ''      # 公众号用
```

改完 1-2 秒热重载自动生效（channel 重建）。

## 命令（平台内发送）

```
/new <提示词>  新建会话并开始
/sessions      列出会话
/switch <id>   切换会话
/status        当前会话
/gc [分钟]     清理闲置超时的会话（默认 30 分钟）
/help          帮助
```

## WebChat 用法

```bash
# 入站（wait=true 可同步等回复）
curl -X POST http://127.0.0.1:3080/dsh-omnibridge/webchat/webchat/send \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好","sender_id":"u1","wait":true}'
# 出站轮询
curl 'http://127.0.0.1:3080/dsh-omnibridge/webchat/webchat/poll?session_key=u1&since=0'
```

## 状态与开关

```
GET  /dsh-omnibridge/status     # channels 运行状态 + 路由数 + 白名单 + 速率限制/闲置摘要
GET/POST /dsh-omnibridge/settings
```

`/status` 的 `summary` 字段包含 `rateLimit`（限速窗口、是否静默、已跟踪发送方数）、`sessionTtlMinutes`、每条路由的 `lastActive`/`idleSeconds`，便于排查刷屏与僵尸会话。

## 安全

- `allowFrom` 默认空 = 全拒。**一个允许任何人驱动本地 agent 的桥就是提示注入前门**
- webhook/webchat 入站均为明文 HTTP，DSH 不内置签名校验：生产环境应在反向代理层做 token/签名验证（飞书 encrypt、企微/钉钉回调签名、LINE 通道签名头、自定义 header 校验），否则任何人都能 POST 驱动本机 agent
- 文件 `allowFrom` 条目只校验发送方，不校验平台真实性；`平台:*` 通配范围更大，生产慎用
- 速率限制（`rateLimit.maxPerMinute`）与请求体大小上限（webhook 1MB / 其它端点 256KB）是兜底，不能代替入口签名校验
- QQ/微信个人号桥接可能违反平台 ToS，风险自担
- 生产使用建议配合 Docker / 独立账号 / 权限受限 workspace

## 架构

```
index.mjs          入口：配置 schema、channel 装配、热重载、状态 API
bridge-core.mjs    Bridge：Channel 抽象（对标 AstrBot Platform）、统一消息模型、
                   会话路由（懒创建 agent）、命令、出站（session/event → 平台）
channels/onebot.mjs     QQ OneBot v11 WS 客户端（含回执匹配、断线重连）
channels/telegram.mjs   Telegram long polling（零依赖 fetch）
channels/satori.mjs     Satori 通用协议 WS 客户端
channels/webhook.mjs    通用 webhook：飞书/企微/钉钉/LINE/公众号/custom
channels/webchat.mjs    HTTP 聊天端点（入站 POST / 出站轮询）
channels/weixin_oc.mjs  个人微信 iLink 适配器（二维码登录 + getupdates 长轮询）
```
