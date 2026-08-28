/**
 * dsh-omnibridge 平台扫码接入协议（对齐 AstrBot 各平台 app_registration）。
 *
 * 三套设备码/绑定流，统一归一化为 { ok, session } / { ok, result }：
 *  - feishu     accounts.feishu.cn /oauth/v1/app/registration（PersonalAgent）
 *  - dingtalk   oapi.dingtalk.com /app/registration/{init,begin,poll}（DING_DWS_CLAW）
 *  - qqofficial q.qq.com /lite/{create_bind_task,poll_bind_result}
 *               （bind_key = AES-256-GCM 密钥，AppSecret 加密回传，本端解密）
 *
 * 出于架构边界说明：以上是各平台"扫码创建应用/绑定"的真实授权流；
 * 用户身份 OAuth 扫码（飞书/钉钉/企微网页登录）与 bot 收发无关，不在范围内。
 *
 * @module dsh-omnibridge/channels/scan-registration
 */

import { createDecipheriv, randomBytes } from 'node:crypto'

const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn'
const FEISHU_OPEN = 'https://open.feishu.cn'
const LARK_ACCOUNTS = 'https://accounts.larksuite.com'
const LARK_OPEN = 'https://open.larksuite.com'
const DING_BASE = 'https://oapi.dingtalk.com'
const DING_SOURCE = 'DING_DWS_CLAW'
const QQ_HOST = 'https://q.qq.com'

const TIMEOUT_MS = 15000

async function postForm(url, form) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await resp.json().catch(() => ({}))
  return { status: resp.status, data: data && typeof data === 'object' ? data : {} }
}

async function postJson(url, payload, timeoutMs = TIMEOUT_MS) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`)
  const data = await resp.json()
  if (!data || typeof data !== 'object') throw new Error('响应格式异常')
  if (data.retcode !== undefined && Number(data.retcode) !== 0) {
    throw new Error(data.msg || data.message || `retcode=${data.retcode}`)
  }
  return data
}

const str = (d, k) => { const v = d ? d[k] : null; return typeof v === 'string' ? v.trim() : '' }
const num = (d, k, def) => (typeof (d ? d[k] : null) === 'number' ? d[k] : def)
const unwrap = (raw) => (raw && raw.data && typeof raw.data === 'object' ? raw.data : (raw || {}))

// ——————————————————————— 飞书 ———————————————————————

async function beginFeishu() {
  const { status, data } = await postForm(FEISHU_ACCOUNTS + '/oauth/v1/app/registration', {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  })
  const d = unwrap(data)
  const err = (status < 400 && !data.error && !d.error) ? null
    : (data.error_description || d.error_description || data.error || d.error || '发起扫码创建失败')
  if (err) throw new Error(err)
  const userCode = str(d, 'user_code')
  let verificationUriComplete = str(d, 'verification_uri_complete')
  if (!verificationUriComplete && userCode) {
    verificationUriComplete = FEISHU_OPEN + '/page/cli?user_code=' + encodeURIComponent(userCode)
  }
  return {
    deviceCode: str(d, 'device_code'),
    userCode,
    qrSrc: verificationUriComplete,
    verificationUri: str(d, 'verification_uri'),
    verificationUriComplete,
    domain: 'feishu',
    expiresIn: num(d, 'expires_in', 300),
    interval: num(d, 'interval', 5),
  }
}

async function pollFeishu(session) {
  const accounts = session.domain === 'lark' ? LARK_ACCOUNTS : FEISHU_ACCOUNTS
  const { status, data } = await postForm(accounts + '/oauth/v1/app/registration', {
    action: 'poll',
    device_code: str(session, 'deviceCode') || str(session, 'device_code'),
  })
  const d = unwrap(data)
  const error = typeof data.error === 'string' ? data.error : (typeof d.error === 'string' ? d.error : '')
  const clientId = str(d, 'client_id')
  let clientSecret = str(d, 'client_secret')
  const brand = str(d, 'tenant_brand')
  if (status < 400 && !error && clientId) {
    if (!clientSecret && brand === 'lark') {
      const s2 = await postForm(LARK_ACCOUNTS + '/oauth/v1/app/registration', {
        action: 'poll',
        device_code: str(session, 'deviceCode') || str(session, 'device_code'),
      })
      clientSecret = str(unwrap(s2.data), 'client_secret')
    }
    if (!clientSecret) return { status: 'error', message: '应用创建成功但未获取到凭证' }
    return { status: 'created', appId: clientId, appSecret: clientSecret, tenantBrand: brand }
  }
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') return { status: 'pending', message: '（飞书限速，已自动放缓）' }
  if (error === 'access_denied') return { status: 'denied', message: '用户取消了扫码创建' }
  if (error === 'expired_token' || error === 'invalid_grant') return { status: 'expired', message: '扫码已过期，请重新发起' }
  return { status: 'error', message: data.error_description || d.error_description || error || '获取扫码创建状态失败' }
}

// ——————————————————————— 钉钉 ———————————————————————

async function dingPost(path, payload) {
  const { status, data } = await postJson(DING_BASE + path, payload)
  const errcode = Number((data && data.errcode) || 0)
  if (status >= 400 || errcode !== 0) {
    throw new Error(`[${path}] ${(data && data.errmsg) || 'unknown error'} (errcode=${errcode})`)
  }
  return data
}

async function beginDingtalk() {
  // init 与 begin 用同构的 inline fetch（显式 text→JSON，错误信息自带响应体）
  const initResp = await fetch(DING_BASE + '/app/registration/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: DING_SOURCE }),
    signal: AbortSignal.timeout(15000),
  })
  const initText = await initResp.text()
  if (!initResp.ok) throw new Error(`[init] -> ${initResp.status}: ${initText.slice(0, 120)}`)
  const init = JSON.parse(initText)
  const nonce = str(init, 'nonce')
  if (!nonce) throw new Error('[init] missing nonce: raw=' + initText.slice(0, 200))
  const beginResp = await fetch(DING_BASE + '/app/registration/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: nonce }),
    signal: AbortSignal.timeout(15000),
  })
  const beginText = await beginResp.text()
  if (!beginResp.ok) throw new Error(`[begin] -> ${beginResp.status}: ${beginText.slice(0, 120)}`)
  const begin = JSON.parse(beginText)
  const deviceCode = str(begin, 'device_code')
  const verificationUriComplete = str(begin, 'verification_uri_complete')
  if (!deviceCode) throw new Error('[begin] missing device_code')
  if (!verificationUriComplete) throw new Error('[begin] missing verification_uri_complete')
  return {
    deviceCode,
    userCode: str(begin, 'user_code'),
    qrSrc: verificationUriComplete,
    verificationUri: str(begin, 'verification_uri'),
    verificationUriComplete,
    domain: 'dingtalk',
    expiresIn: Math.max(num(begin, 'expires_in', 7200), 60),
    interval: Math.max(num(begin, 'interval', 3), 1),
  }
}

async function pollDingtalk(session) {
  const raw = await dingPost('/app/registration/poll', {
    device_code: str(session, 'deviceCode') || str(session, 'device_code'),
  })
  const statusRaw = str(raw, 'status').toUpperCase()
  if (statusRaw === 'WAITING') return { status: 'pending' }
  if (statusRaw === 'SUCCESS') {
    const appId = str(raw, 'client_id')
    const appSecret = str(raw, 'client_secret')
    if (!appId || !appSecret) return { status: 'error', message: '扫码成功但未获取到钉钉应用凭证' }
    return { status: 'created', appId, appSecret }
  }
  if (statusRaw === 'FAIL') return { status: 'error', message: str(raw, 'fail_reason') || '钉钉扫码创建失败' }
  if (statusRaw === 'EXPIRED') return { status: 'expired', message: '钉钉扫码已过期，请重新创建' }
  return { status: 'error', message: `钉钉扫码创建返回未知状态: ${statusRaw || 'UNKNOWN'}` }
}

// ——————————————————————— QQ 官方 ———————————————————————

function decryptQqSecret(encrypted, bindKey) {
  const key = Buffer.from(bindKey, 'base64')
  const raw = Buffer.from(encrypted, 'base64')
  if (key.length !== 32 || raw.length <= 28) throw new Error('QQ 机器人凭证密文格式异常')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
}

async function beginQqOfficial() {
  const bindKey = randomBytes(32).toString('base64')
  const data = await postJson(QQ_HOST + '/lite/create_bind_task', { key: bindKey }, 10000)
  const payload = unwrap(data)
  const taskId = str(payload, 'task_id')
  if (!taskId) throw new Error('QQ 机器人绑定任务响应缺少 task_id')
  return {
    taskId,
    bindKey,
    qrSrc: `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`,
    domain: 'qqofficial',
    expiresIn: 0,
    interval: 2,
  }
}

async function pollQqOfficial(session) {
  const taskId = str(session, 'taskId') || str(session, 'task_id')
  const bindKey = str(session, 'bindKey') || str(session, 'bind_key')
  if (!taskId) throw new Error('Missing task_id')
  if (!bindKey) throw new Error('Missing bind_key')
  const data = await postJson(QQ_HOST + '/lite/poll_bind_result', { task_id: taskId }, 10000)
  const payload = unwrap(data)
  const rawStatus = Number(payload.status || 0)
  if (rawStatus === 2) {
    const appId = str(payload, 'bot_appid')
    const encrypted = str(payload, 'bot_encrypt_secret')
    if (!appId || !encrypted) return { status: 'error', message: '扫码成功但未返回完整 QQ 机器人凭证' }
    const appSecret = decryptQqSecret(encrypted, bindKey)
    return { status: 'created', appId, appSecret }
  }
  if (rawStatus === 3) return { status: 'expired', message: '二维码已过期' }
  return { status: 'pending' }
}

// ——————————————————————— 微信客服（企业微信） ———————————————————————

/** 生成「联系客服」二维码链接：corpId + 微信客服 secret → 选客服账号 → add_contact_way。 */
async function wecomKfQr(body) {
  const corpId = str(body, 'corpId')
  const secret = str(body, 'secret')
  if (!corpId || !secret) return { ok: false, error: '需要 corpId 与微信客服 secret' }
  const tokResp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`,
    { signal: AbortSignal.timeout(10000) },
  )
  const tok = await tokResp.json()
  if (Number(tok.errcode) !== 0 || !tok.access_token) {
    return { ok: false, error: '获取 access_token 失败: ' + (tok.errmsg || 'unknown') }
  }
  const at = tok.access_token
  const listResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token=${encodeURIComponent(at)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  })
  const list = await listResp.json()
  if (Number(list.errcode) !== 0) return { ok: false, error: '获取客服列表失败: ' + (list.errmsg || 'unknown') }
  const accountList = Array.isArray(list.account_list) ? list.account_list : []
  if (!accountList.length) return { ok: false, error: '企业微信下没有微信客服账号（先在企业微信后台创建）' }
  const kfName = str(body, 'kfName')
  const acc = (kfName ? accountList.find(function (a) { return a.name === kfName }) : null) || accountList[0]
  const openKfid = acc && acc.open_kfid
  if (!openKfid) return { ok: false, error: 'open_kfid 为空' }
  const addResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/add_contact_way?access_token=${encodeURIComponent(at)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ open_kfid: openKfid, scene: 'dsh-omnibridge' }),
    signal: AbortSignal.timeout(10000),
  })
  const add = await addResp.json()
  if (Number(add.errcode) !== 0 || !add.url) return { ok: false, error: '生成联系我二维码失败: ' + (add.errmsg || 'unknown') }
  return { ok: true, url: add.url, kfName: acc.name || openKfid }
}

// ——————————————————————— 统一入口 ———————————————————————

const PLATFORMS = { feishu: true, dingtalk: true, qqofficial: true }

/** 发起扫码接入。返回 { ok, session } 或 { ok: false, error }。 */
export async function beginScan(platform) {
  try {
    if (!PLATFORMS[platform]) return { ok: false, error: '未知平台: ' + platform }
    if (platform === 'feishu') return { ok: true, session: await beginFeishu() }
    if (platform === 'dingtalk') return { ok: true, session: await beginDingtalk() }
    return { ok: true, session: await beginQqOfficial() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 微信客服二维码（企微凭据按需传入，无设备码轮询）。 */
export async function wecomKfScan(body) {
  try {
    return await wecomKfQr(body && typeof body === 'object' ? body : {})
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 轮询一次扫码状态。返回 { ok, result } 或 { ok: false, error }。 */
export async function pollScan(platform, session) {
  try {
    if (!PLATFORMS[platform]) return { ok: false, error: '未知平台: ' + platform }
    const s = session && typeof session === 'object' ? session : {}
    if (platform === 'feishu') return { ok: true, result: await pollFeishu(s) }
    if (platform === 'dingtalk') return { ok: true, result: await pollDingtalk(s) }
    return { ok: true, result: await pollQqOfficial(s) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
