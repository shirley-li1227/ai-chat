/**
 * 配置接口的协议级断言：多供应商列表、生效指针、按家校验、掩码与静态加密。
 *
 * 这一层为什么不能只靠离线评测：DTO 校验、事务里挪指针、删除后自动顶上，
 * 都是「装配 + 校验 + 数据库」三者一起才成立的行为，纯函数测不到装配后的真实状态码与响应形状。
 *
 * 破坏性用例（删除、清空）一律排在最后，前面几组只读或只改可回滚的字段。
 * 库文件走 --db 参数：静态加密必须看落库后的原始字节，光读接口证明不了密文真的进了库。
 */
import fs from 'node:fs'
import { FAKE_KEYS, api, createSuite, parseArgs } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const base = String(args.base)
const dbPath = String(args.db ?? '')
if (!base) {
  console.error('用法：node check-config.mjs --base=http://127.0.0.1:4101/api --db=<临时库路径>')
  process.exit(2)
}

const suite = createSuite('live:config')

const ok = (status) => status >= 200 && status < 300
const errorMessage = (res) =>
  Array.isArray(res.json?.message)
    ? res.json.message.join('；')
    : String(res.json?.message ?? res.json?.error ?? res.text ?? '')

const list = async () => (await api('GET', `${base}/config`)).json
const activeOf = (body) => body.items.filter((item) => item.active)

function saveBody(provider, overrides = {}) {
  return {
    provider,
    apiKey: provider === 'deepseek' ? FAKE_KEYS.deepseek : FAKE_KEYS.zhipu,
    baseUrl: provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://open.bigmodel.cn/api/paas/v4',
    model: provider === 'deepseek' ? 'deepseek-chat' : 'glm-5.3',
    ...overrides,
  }
}

/** 被拒的请求：断言状态码 + 文案里必须点名是哪条规则，否则用户只看得到「保存失败」 */
async function rejected(title, body, expectIn) {
  await suite.check(title, async () => {
    const res = await api('POST', `${base}/config`, body)
    if (res.status !== 400) {
      return `HTTP ${res.status}（应为 400）：${res.text.slice(0, 120)}`
    }
    const message = errorMessage(res)
    const missing = expectIn.filter((token) => !message.includes(token))
    return missing.length === 0 ? true : `文案没点名 ${missing.join('/')}：${message}`
  })
}

await suite.check('GET /api/config 回列表 + 生效指针', async () => {
  const res = await api('GET', `${base}/config`)
  const body = res.json
  if (!ok(res.status)) {
    return `HTTP ${res.status}`
  }
  return body && 'configured' in body && 'active' in body && Array.isArray(body.items)
    ? true
    : `形状不对：${res.text.slice(0, 160)}`
})

await suite.check('两家并陈，且各自带着自己的档位候选', async () => {
  const body = await list()
  const ids = body.items.map((item) => item.provider).sort().join(',')
  if (ids !== 'deepseek,zhipu') {
    return `列表里是 ${ids}`
  }
  const zhipu = body.items.find((item) => item.provider === 'zhipu')
  return zhipu.routingCandidates === 'glm-air,glm-pro'
    ? true
    : `智谱候选是 ${zhipu.routingCandidates}，候选没落在配置上`
})

await suite.check('同时只有一份生效，且是播种时指定的 DeepSeek', async () => {
  const body = await list()
  const actives = activeOf(body)
  if (actives.length !== 1) {
    return `生效的有 ${actives.length} 份`
  }
  return actives[0].provider === 'deepseek' ? true : `生效的是 ${actives[0].provider}`
})

await suite.check('接口只回掩码，明文 Key 不出现在响应里', async () => {
  const res = await api('GET', `${base}/config`)
  for (const key of Object.values(FAKE_KEYS)) {
    if (res.text.includes(key)) {
      return `响应里出现了明文 ${key.slice(0, 6)}…`
    }
  }
  const leaked = res.json.items.filter((item) => 'apiKey' in item)
  return leaked.length === 0 ? true : 'items 里带了 apiKey 字段'
})

await suite.check('掩码是「前 4 + **** + 后 4」', async () => {
  const body = await list()
  const deepseek = body.items.find((item) => item.provider === 'deepseek')
  return deepseek.apiKeyMasked === `sk-l****${FAKE_KEYS.deepseek.slice(-4)}`
    ? true
    : `实际掩码 ${deepseek.apiKeyMasked}`
})

await rejected('未登记的供应商在 DTO 层就判死', saveBody('glm'), ['provider 目前支持'])
await rejected('DeepSeek 不接受智谱形态的 Key', saveBody('deepseek', { apiKey: FAKE_KEYS.zhipu }), ['sk-'])
await rejected('智谱不接受 sk- 形态的 Key', saveBody('zhipu', { apiKey: FAKE_KEYS.deepseek }), ['id.secret'])
await rejected(
  'baseUrl 强制 https（本地假上游是 http，也不为此放宽产品约束）',
  saveBody('deepseek', { baseUrl: 'http://127.0.0.1:4102/v1' }),
  ['https'],
)
await rejected(
  'baseUrl 不许带查询串',
  saveBody('deepseek', { baseUrl: 'https://api.deepseek.com/?next=1' }),
  ['https'],
)
await rejected(
  '跨家候选被拒并点名是哪一条',
  saveBody('zhipu', { apiKey: '', routingCandidates: 'glm-air,deepseek-chat' }),
  ['不属于 智谱 GLM', 'deepseek-chat'],
)
await rejected('未声明的字段被 whitelist 拦下', { ...saveBody('deepseek'), evil: 'x' }, ['evil'])

await suite.check('密钥框留空＝沿用库里那把（改模型名不必重贴密钥）', async () => {
  const before = await list()
  const beforeMask = before.items.find((item) => item.provider === 'deepseek').apiKeyMasked
  const res = await api('POST', `${base}/config`, saveBody('deepseek', { apiKey: '', model: 'deepseek-chat-2' }))
  if (!ok(res.status)) {
    return `HTTP ${res.status}：${errorMessage(res)}`
  }
  const after = await list()
  const item = after.items.find((row) => row.provider === 'deepseek')
  if (item.apiKeyMasked !== beforeMask) {
    return `掩码从 ${beforeMask} 变成 ${item.apiKeyMasked}`
  }
  return item.model === 'deepseek-chat-2' ? true : `模型没改成：${item.model}`
})

await suite.check('apply=false 只存不切', async () => {
  const res = await api('POST', `${base}/config`, saveBody('zhipu', { apiKey: '', apply: false }))
  if (!ok(res.status)) {
    return `HTTP ${res.status}：${errorMessage(res)}`
  }
  const actives = activeOf(await list())
  return actives.length === 1 && actives[0].provider === 'deepseek'
    ? true
    : `生效变成了 ${actives.map((item) => item.provider).join(',')}`
})

await suite.check('设为使用：指针挪过去，原来那份自动失效', async () => {
  const res = await api('POST', `${base}/config/zhipu/activate`)
  if (!ok(res.status)) {
    return `HTTP ${res.status}：${errorMessage(res)}`
  }
  const body = await list()
  const actives = activeOf(body)
  return actives.length === 1 && actives[0].provider === 'zhipu'
    ? true
    : `生效的是 ${actives.map((item) => item.provider).join(',')}`
})

await suite.check('切回 DeepSeek 后列表顺序也跟着变（生效那份排最前）', async () => {
  await api('POST', `${base}/config/deepseek/activate`)
  const body = await list()
  return body.items[0].provider === 'deepseek' ? true : `首位是 ${body.items[0].provider}`
})

if (dbPath) {
  await suite.check('落库的是 AES-256-GCM 密文，明文 Key 不在库文件里', async () => {
    const raw = fs.readFileSync(dbPath, 'latin1')
    if (!raw.includes('gcm1:')) {
      return '库里找不到 gcm1: 密文前缀'
    }
    const leaked = Object.values(FAKE_KEYS).filter((key) => raw.includes(key))
    return leaked.length === 0 ? true : `明文 ${leaked[0].slice(0, 6)}… 直接躺在库里`
  })
}

await suite.check('健康检查列出线上接了哪几家', async () => {
  const health = (await api('GET', `${base}/health`)).json
  return JSON.stringify(health.providers) === JSON.stringify(['deepseek', 'zhipu'])
    ? true
    : `providers=${JSON.stringify(health.providers)}`
})

// —— 以下是破坏性用例，必须排在最后 ——

await suite.check('删掉非生效那份：生效指针不动', async () => {
  const res = await api('DELETE', `${base}/config/zhipu`)
  if (!ok(res.status)) {
    return `HTTP ${res.status}：${errorMessage(res)}`
  }
  const body = await list()
  const actives = activeOf(body)
  return body.items.length === 1 && actives[0]?.provider === 'deepseek'
    ? true
    : `列表 ${body.items.length} 份、生效 ${actives.map((item) => item.provider).join(',')}`
})

await suite.check('删掉生效那份：剩下最近更新的自动顶上，不留空档', async () => {
  await api('POST', `${base}/config`, saveBody('zhipu', { apply: false }))
  const res = await api('DELETE', `${base}/config/deepseek`)
  if (!ok(res.status)) {
    return `HTTP ${res.status}：${errorMessage(res)}`
  }
  const actives = activeOf(await list())
  return actives.length === 1 && actives[0].provider === 'zhipu'
    ? true
    : `生效的是 ${actives.map((item) => item.provider).join(',') || '（没有）'}`
})

await suite.check('清空后 configured=false 且没有生效项', async () => {
  await api('DELETE', `${base}/config`)
  const body = await list()
  return body.configured === false && body.items.length === 0 && body.active === null
    ? true
    : JSON.stringify(body).slice(0, 160)
})

await rejected(
  '空库首次保存不留空 Key（否则上游只会 401 而界面看不出原因）',
  saveBody('deepseek', { apiKey: '' }),
  ['首次保存'],
)

await suite.check('清空后重新保存第一份自动生效', async () => {
  const res = await api('POST', `${base}/config`, saveBody('deepseek'))
  if (!ok(res.status)) {
    return `HTTP ${res.status}：${errorMessage(res)}`
  }
  const actives = activeOf(await list())
  return actives.length === 1 && actives[0].provider === 'deepseek'
    ? true
    : `生效的是 ${actives.map((item) => item.provider).join(',') || '（没有）'}`
})

await suite.check('同一家二次保存是覆盖而不是新增（复合唯一的实际效果）', async () => {
  await api('POST', `${base}/config`, saveBody('deepseek', { model: 'deepseek-chat-3' }))
  const body = await list()
  return body.items.length === 1 ? true : `列表里有 ${body.items.length} 份`
})

const summary = suite.report()
process.exit(summary.failed > 0 ? 1 : 0)
