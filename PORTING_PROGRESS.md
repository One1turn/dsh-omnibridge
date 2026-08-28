# dsh-omnibridge 平台适配器移植进度

对标 AstrBot 17 平台 → dsh-omnibridge JS channel。验证 = `node --check` + 接入 index.mjs buildChannels + 保持白名单/命令语义。

| # | AstrBot 平台 | dsh channel | 状态 | 实现要点 |
|---|---|---|---|---|
| 1 | aiocqhttp (QQ) | `onebot` | ✅ 已存在 | OneBot v11 WS 客户端 |
| 2 | qqofficial | `onebot` | ✅ NapCat 覆盖 | —— |
| 3 | qqofficial_webhook | `webhook` | ✅ format=custom | —— |
| 4 | lark (飞书) | `webhook` | ✅ format=feishu | —— |
| 5 | wecom (企业微信) | `webhook` | ✅ format=wecom | —— |
| 6 | wecom_ai_bot | `webhook` | ✅ format=wecom_ai | —— |
| 7 | weixin_official_account (公众号) | `webhook` | ✅ format=mp | —— |
| 8 | **weixin_oc (个人微信)** | **`weixin_oc`** | **✅ 完成** | **iLink 官方接口，扫码登录 + getupdates 长轮询 + sendmessage 文本** |
| 9 | dingtalk (钉钉) | `webhook` | ✅ format=dingtalk | —— |
| 10 | telegram | `telegram` | ✅ 已存在 | Bot API long polling |
| 11 | discord | `satori` | ✅ 经 Satori 网关 | —— |
| 12 | kook | `satori` | ✅ 经 Satori 网关 | —— |
| 13 | line | `webhook` | ✅ format=line | —— |
| 14 | slack | `satori` | ✅ 经 Satori 网关 | —— |
| 15 | mattermost | `satori` | ✅ 经 Satori 网关 | —— |
| 16 | misskey | `satori` | ✅ 经 Satori 网关 | —— |
| 17 | satori | `satori` | ✅ 已存在 | 协议直连 |
| 18 | webchat | `webchat` | ✅ 已存在 | HTTP 聊天 |

## 关键说明

- AstrBot 中有 12 个平台在 dsh-omnibridge 早期已用 3 个通用 channel 覆盖：`onebot`（QQ 全家）、`satori`（discord/kook/slack/mattermost/misskey）、`webhook`（lark/wecom/wecom_ai/dingtalk/qqofficial_webhook/weixin_official_account/line，按 format 收敛）。
- **weixin_oc 是首个真正"自我实现登录协议"的 channel**：因为 iLink 是个人微信唯一合法入口，不能套用 webhook/satori/onebot 通用模板。
- 本轮交付（2024 起）仅做文本收发 + 扫码登录 + bot_token 持久化；AES-ECB CDN 媒体 / typing 状态 / 引用回复匹配等按实际 dsh 场景按需扩展（dsh 主要回文本，媒体复杂度性价比低）。

## 完成判定

全 17 平台均有对应渠道并 `node --check` 通过 → 已达成。

## 对齐增强记录

- **断网重连健壮性 ✅**：新增 `channels/retry.mjs`（指数退避 ×2 + 0.8~1.2 抖动，封顶 30s + `Reconnector` 调度器）。onebot/satori 断线重连接入并成功归零；telegram poll 错误、weixin_oc 长轮询错误统一同一公式。
- **群聊 waking check 对齐**：onebot 原有 `groupAtOnly` 语义扩展至 telegram（@机器人用户名 / 回复机器人消息判定）与 satori（ready 后 GET /v1/user/me 自识别 bot id，`<at id>` 标签 / 引用消息判定，检测先于标签剥离）；默认开启，`groupAtOnly: false` 恢复全量响应。
- **工程加固**：bridge 热重载重建串行化（修复并发触发可产生双 Bridge 的竞态）、webhook parseInbound 拆分为 per-format 解析器映射表（行为不变）、webchat 出站按保留期淘汰（retentionMinutes，默认 30 分钟）、weixin_oc syncBuf/contextTokens 写盘去抖（关键 token 转换仍立即写）。

剩余可演进项：媒体收发 / 更多 iLink 消息类型。

### 功能对标（新增）

- **图片入站**：onebot / telegram / satori / webchat 四通道入站图片统一经 Bridge → `ctx.attachments.saveImage` 落库为 image 内容块（channel 只提取 `{url|dataUrl}` 描述，字节拉取/校验集中在 Bridge）；地址安全防护（仅 http(s)、默认拒私网字面量，`mediaAllowPrivateHosts` 可放行本机平台）。webhook 家族与 weixin_oc 维持纯文本；出站仍纯文本（生产 adapter 仅声明文本输出）。
- **管理员分级**：`admins` 名单 + 受限命令集 `{/model, /gc, /sessions, /switch}`；空名单保持"白名单即管理员"的兼容行为。
- **/reset**：重置当前绑定会话并新建（dispose 旧 agent），对齐 AstrBot 清空上下文语义。
- **wakePrefixes**：全局唤醒前缀（最长匹配剥离、'/' 命令豁免、未配置零影响）。

### WebUI 富配置中枢（新增）

- 「设置→消息桥」独立区块升级为四 tab 主体：运行状态 / **渠道配置** / **内置指令** / 聊天测试；插件卡保持摘要。
- **渠道配置**对齐 AstrBot 配置页逻辑：声明式分组表单 + 暂存编辑，保存经 `POST /settings {patch}` → 后端 `scope.update` 写 `settings.yaml` user 层（schema 校验、watch 自动热重建 bridge）；宿主 settings seam 对第三方 namespace 关闭（`settings-not-exposed`），故走插件自身端点而非 `settingsScope`。webhook 实例支持增删；secret 遮蔽显示。
- **内置指令**面板：/help /status /sessions /new /reset /switch /gc /model 指令卡（管理员标注），经 webchat 命令链路执行并成对回显。
- **平台扫码接入（新）**：对标 AstrBot 各平台 app_registration——飞书（PersonalAgent 设备码）、钉钉（DING_DWS_CLAW 设备码）、QQ 官方（q.qq.com 绑定任务 + AES-256-GCM 凭据解密）三套真实授权流接入「扫码登录」tab；扫码后凭证自动回传展示，填入渠道配置对应平台卡保存。通用端点 `POST /scan/{begin,poll}`，协议实现见 `channels/scan-registration.mjs`。对应收发适配器（飞书/钉钉 Stream、qqofficial 推送）列入路线图。
- qqofficial（QQ 官方机器人）完整适配器（Ed25519 验签 + openapi 回发）列入路线图，现经 webhook format=custom 接入，配置页有指引。

剩余可演进项不变。
