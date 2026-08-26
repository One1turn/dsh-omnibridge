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

全 17 平台均有对应渠道并 `node --check` 通过 → 已达成。剩余可演进项：媒体收发 / 更多 iLink 消息类型 / 断网重连健壮性。
