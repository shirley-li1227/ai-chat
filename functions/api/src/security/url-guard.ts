import { promises as dns } from 'node:dns'
import net from 'node:net'

/**
 * SSRF 防护：fetch_url 的目标地址由大模型生成，属于完全不可信输入。
 * 必须拦截云元数据端点（169.254.169.254）、回环、私网及各类保留段，
 * 否则同机部署时可被用来读取实例 IAM 凭证、打内部服务。
 */

export interface GuardedUrl {
  url: string
  hostname: string
  protocol: string
}

/** node:dns/promises 未导出 LookupAddress，这里按其 all:true 返回结构自行声明 */
interface LookupRecord {
  address: string
  family: number
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
])

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true // 格式异常一律拒绝
  }
  const [a, b] = parts
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // 回环
    (a === 169 && b === 254) || // 链路本地 + 云元数据
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 198 && (b === 18 || b === 19)) || // 基准测试
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // 组播与保留
  )
}

function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') {
    return true
  }
  // IPv4 映射地址：::ffff:127.0.0.1 这类必须按内层 IPv4 判断
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) {
    return ipv4IsPrivate(mapped[1])
  }
  return (
    lower.startsWith('fe80') || // 链路本地
    lower.startsWith('fc') || // 唯一本地 fc00/7
    lower.startsWith('fd') || // 唯一本地 fd00/7
    lower.startsWith('ff') // 组播
  )
}

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) return ipv4IsPrivate(ip)
  if (kind === 6) return ipv6IsPrivate(ip)
  return true // 无法识别的地址视为不可信
}

/**
 * 校验 URL 协议、域名白名单，并解析全部 A/AAAA 记录确保没有一个落在内网。
 * 调用方须在每次跟随重定向后重新执行，否则可用公网域名 302 跳转绕过。
 */
export async function assertUrlSafe(
  rawUrl: string,
  allowedHosts: string[] = [],
): Promise<GuardedUrl> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('url 不是合法的绝对地址')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅允许抓取 http/https 地址')
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!hostname) {
    throw new Error('url 缺少主机名')
  }
  if (parsed.username || parsed.password) {
    throw new Error('不允许在 url 中携带凭据')
  }
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('目标主机被拒绝访问')
  }

  if (allowedHosts.length > 0) {
    const matched = allowedHosts.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`),
    )
    if (!matched) {
      throw new Error('目标域名不在允许清单内')
    }
  }

  // 字面量 IP 直接判断；域名则解析全部记录，堵住 DNS 指向内网的情况
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('禁止访问内网地址')
    }
    return { url: parsed.toString(), hostname, protocol: parsed.protocol }
  }

  // dns/promises 未导出 LookupAddress 类型，使用本地声明的记录结构
  let records: LookupRecord[]
  try {
    records = (await dns.lookup(hostname, { all: true })) as LookupRecord[]
  } catch {
    throw new Error('目标域名无法解析')
  }
  if (records.length === 0) {
    throw new Error('目标域名无解析结果')
  }
  if (records.some((r) => isPrivateIp(r.address))) {
    throw new Error('禁止访问内网地址')
  }

  return { url: parsed.toString(), hostname, protocol: parsed.protocol }
}
