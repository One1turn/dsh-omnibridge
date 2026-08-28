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
  # 管理员名单（语法同 allowFrom）：/model /gc /sessions /switch 仅限名单成员；
  # 空 = 白名单全员视为管理员（兼容单人部署）
  admins: []
  # 唤醒前缀：配置后所有非 '/' 命令消息必须以任一前缀开头才触发；[] = 不启用
  wakePrefixes: []           # 如 ['!','小助手']
  # 入站图片抓取是否放行私网/本机地址（自托管 NapCat/缓存服务可能给局域网链接，开启=信任平台来源）
  mediaAllowPrivateHosts: false
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
    groupAtOnly: true        # 群聊默认仅响应 @机器人 / 回复机器人消息；false 恢复全量

  satori:                    # Discord/KOOK/Slack/Mattermost/Misskey 等
    enabled: false
    baseUrl: http://127.0.0.1:5140
    token: ''
    reconnectDelayMs: 5000   # 断线重连基间隔（自动指数退避 + 抖动，封顶 30s）
    groupAtOnly: true        # 群聊默认仅响应 @机器人 / 引用机器人消息（bot id 自动识别）；false 恢复全量

  webchat:                   # HTTP 聊天端点
    enabled: false
    path: /dsh-omnibridge/webchat/webchat
    retentionMinutes: 30     # 出站消息保留分钟数，超时自动淘汰

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
/reset         重置当前会话（清空上下文重新开始）
/status        当前会话
/help          帮助
/sessions      列出会话（管理员）
/switch <id>   切换会话（管理员）
/gc [分钟]     清理闲置超时的会话路由（管理员，默认 30 分钟）
/model [p/]m   查看/切换模型（管理员，如 /model ai/gpt-5.6-luna）
```

## 图片入站

四个结构化通道支持把入站图片随文本一起交给 agent：**onebot**（CQ 码 / 消息分段）、**telegram**（photo + caption）、**satori**（`<img src>`）、**webchat**（body.images）。图片经 DSH attachments 服务校验落库后作为 image 内容块进入会话上下文。

- 每张图片的字节数 / 张数上限跟随 attachments 服务的 `imageLimits`；单张失败自动跳过，全部失败且无文本时拒收并提示
- 默认拒绝抓取私网/本机地址的媒体 URL（SSRF 防护，仅 http(s)）；自托管 NapCat 等给出局域网链接时开启 `mediaAllowPrivateHosts`
- 其余平台（webhook 家族 / weixin_oc）暂维持纯文本；**出站仍为纯文本**（DSH 生产 adapter 仅声明文本输出）

WebChat 示例：

```bash
curl -X POST http://127.0.0.1:3080/dsh-omnibridge/webchat/webchat/send \
  -H 'Content-Type: application/json' \
  -d '{"text":"这张图里是什么","sender_id":"u1","images":["https://example.com/cat.png"]}'
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

出站消息按条数（每 key 200）与保留期（`retentionMinutes`，默认 30 分钟）双重淘汰，消费方请及时跟进 `since` 游标。

## DSH WebUI 内嵌面板（设置 → 消息桥）

插件自带 client bundle，注入 DSH 主界面（无独立端口/独立页面）：

- **运行状态**：总开关、渠道实时状态、allowFrom/限流摘要、路由明细（5s 自动刷新）
- **渠道配置**：AstrBot 配置页式分组表单（通用/安全与唤醒/六渠道/webhook 实例增删），暂存编辑、整组经 `POST /dsh-omnibridge/settings {patch}` 写回——后端 `scope.update` 落 `settings.yaml`（schema 校验、失败回 400）并自动热重载；secret 字段遮蔽显示（settings seam 对第三方 namespace 关闭 `settings-not-exposed`，故走插件自身端点）
- **内置指令**：`/help /status /sessions /new /reset /switch /gc /model` 指令卡一键执行（管理员命令由 admins 规则拦截），经 webchat 命令链路、回显成对输出
- **聊天测试**：webchat 会话（wait=true 回合整包返回）+ 图片 URL 入站落库
- **扫码登录**：个人微信（iLink）二维码呈现 / 手动刷新 / 4 秒状态轮询 / 退出并重新扫码（旧 token 备份至 state.previousToken）；**平台扫码接入**——飞书（PersonalAgent 设备码）/ 钉钉（DING_DWS_CLAW 设备码）/ QQ 官方（q.qq.com 绑定任务 + AES-GCM 解密）扫码自动创建应用并回传凭证；**微信客服（企业微信）**——填 corpId + 客服 secret 生成「联系客服」二维码；其余平台为 Token/AppId+Secret 鉴权无扫码环节，QQ 账号扫码在 NapCat WebUI（有直达按钮）

设置→插件 列表中的「消息桥」卡片为摘要与快捷开关。

## 状态与开关

```
GET  /dsh-omnibridge/status     # channels 运行状态 + 路由数 + 白名单 + 速率限制/闲置摘要
GET/POST /dsh-omnibridge/settings
```

`/status` 的 `summary` 字段包含 `rateLimit`（限速窗口、是否静默、已跟踪发送方数）、`sessionTtlMinutes`、每条路由的 `lastActive`/`idleSeconds`，便于排查刷屏与僵尸会话。

## 安全

- 群聊防刷屏（对齐 AstrBot waking check）：onebot / telegram / satori 默认仅响应 @机器人 或回复机器人消息；`groupAtOnly: false` 恢复全量响应，私聊不受影响
- 入站图片由 bot 服务端拉取媒体 URL（受白名单约束的发送者提供）：默认拒绝私网/非 http(s) 地址并限制大小与超时，但这是兜底而非入口鉴权
- `allowFrom` 默认空 = 全拒。**一个允许任何人驱动本地 agent 的桥就是提示注入前门**
- webhook/webchat 入站均为明文 HTTP，DSH 不内置签名校验：生产环境应在反向代理层做 token/签名验证（飞书 encrypt、企微/钉钉回调签名、LINE 通道签名头、自定义 header 校验），否则任何人都能 POST 驱动本机 agent
- 文件 `allowFrom` 条目只校验发送方，不校验平台真实性；`平台:*` 通配范围更大，生产慎用
- 速率限制（`rateLimit.maxPerMinute`）与请求体大小上限（webhook 1MB / 其它端点 256KB）是兜底，不能代替入口签名校验
- QQ/微信个人号桥接可能违反平台 ToS，风险自担
- 生产使用建议配合 Docker / 独立账号 / 权限受限 workspace

## 架构

```
index.mjs          入口：配置 schema、channel 装配、热重载（重建串行化防双 Bridge）、状态 API
bridge-core.mjs    Bridge：Channel 抽象（对标 AstrBot Platform）、统一消息模型、
                   会话路由（懒创建 agent）、命令、出站（session/event → 平台）
channels/retry.mjs 共享指数退避 + 重连调度器（onebot/satori/telegram/weixin_oc 通用）
channels/onebot.mjs     QQ OneBot v11 WS 客户端（含回执匹配、断线重连）
channels/telegram.mjs   Telegram long polling（零依赖 fetch）
channels/satori.mjs     Satori 通用协议 WS 客户端
channels/webhook.mjs    通用 webhook：飞书/企微/钉钉/LINE/公众号/custom（per-format 解析器映射）
channels/webchat.mjs    HTTP 聊天端点（入站 POST / 出站轮询，出站按保留期淘汰）
channels/weixin_oc.mjs  个人微信 iLink 适配器（二维码登录 + getupdates 长轮询 + 写盘去抖）
```
