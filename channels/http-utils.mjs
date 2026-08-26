/**
 * dsh-omnibridge 共享 HTTP 工具：请求体 JSON 读取（限流+超时）与 JSON 应答。
 *
 * 之前 webhook / webchat / index 三处各复制一份，统一收敛到这里。
 *
 * @module dsh-omnibridge/channels/http-utils
 */

/** 读请求体并解析 JSON。超时 / 超限时 reject 并销毁连接（防恶意大包撑爆内存）。 */
export function readJsonBody(request, opts = {}) {
  const maxBytes = opts.maxBytes || 256 * 1024
  const timeoutMs = opts.timeoutMs || 15000
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { request.destroy() } catch {}
      reject(new Error('请求体读取超时'))
    }, timeoutMs)
    request.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error('请求读取错误'))
    })
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        clearTimeout(timer)
        try { request.destroy() } catch {}
        reject(new Error(`请求体超过 ${maxBytes} 字节上限`))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('请求体不是合法 JSON'))
      }
    })
  })
}

/** JSON 应答（统一 Content-Type）。 */
export function respondJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
