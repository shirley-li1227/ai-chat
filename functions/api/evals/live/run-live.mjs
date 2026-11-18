/**
 * 一条命令起完整链路（假上游 + 临时库 + 真后端）并跑完所有 live 断言。
 *
 * 为什么要固化下来：这几套脚本原先每次验多供应商/续传/记忆都得临时手搓一遍，
 * 搓的过程本身比检查还费时间，还容易漏掉「不许碰 functions/api/data/app.db」这条。
 * 现在库、密钥、端口、进程生命周期都在这一个文件里，跑完自动清理，失败才留证据。
 *
 * 边界：全程只连 127.0.0.1，密钥是 lib.mjs 里的假串，主密钥每次随机生成。
 *
 *   node evals/live/run-live.mjs                 # 全部
 *   node evals/live/run-live.mjs --only=chat-core,config
 *   node evals/live/run-live.mjs --keep           # 跑完不删临时目录，便于翻日志
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, parseArgs, portIsFree, startChild, tail, waitForHealth } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(here, '../..')
const args = parseArgs(process.argv.slice(2))
const upstreamPort = Number(args['upstream-port'] ?? 4102)
const apiPort = Number(args['api-port'] ?? 4101)
const only = args.only ? String(args.only).split(',').map((item) => item.trim()) : null
const keep = Boolean(args.keep)
const startedAt = Date.now()

const ALL_SUITES = ['chat-core', 'chat-memory-off', 'chat-memory', 'config']
const suites = only ? ALL_SUITES.filter((name) => only.includes(name)) : ALL_SUITES

function fail(message) {
  console.error(`[live] ${message}`)
  process.exit(2)
}

/** 端口被占时只报属主，不动别人的进程 */
async function requireFreePort(port, label) {
  try {
    await portIsFree(port)
  } catch {
    let owner = '未知'
    try {
      const res = await api('GET', `http://127.0.0.1:${port}/api/health`)
      owner = `那里已经有一个后端在跑（health 回 ${res.status}）`
    } catch {
      owner = '被别的进程占着（可用 netstat -ano | findstr :' + port + ' 查 PID）'
    }
    fail(`${label} 端口 ${port} ${owner}。换端口：--api-port / --upstream-port`)
  }
}

const distEntry = path.join(apiRoot, 'dist', 'main.js')
if (!fs.existsSync(distEntry)) {
  fail('缺少 dist/main.js：先跑 npm run build:api（或直接用仓库根的 npm run verify:live）')
}

await requireFreePort(upstreamPort, '假上游')
await requireFreePort(apiPort, '后端')

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-live-'))
const dbPath = path.join(workspace, 'app.db')
const upstreamLog = path.join(workspace, 'upstream.jsonl')
const upstreamOut = path.join(workspace, 'upstream.out')
const apiOut = path.join(workspace, 'api.out')
// 主密钥随机生成：这条链路只要能加密即可，绝不该复用开发者本机那把真的
const encryptionKey = randomBytes(32).toString('hex')
const upstreamBase = `http://127.0.0.1:${upstreamPort}`
const base = `http://127.0.0.1:${apiPort}/api`

const children = []
let failures = 0

async function step(label, run) {
  const started = Date.now()
  try {
    await run()
    console.log(`[live] ${label} 完成（${((Date.now() - started) / 1000).toFixed(1)}s）`)
  } catch (error) {
    failures += 1
    console.error(`[live] ${label} 失败：${error?.message ?? error}`)
    throw error
  }
}

function startBackend(memoryEnabled) {
  const child = startChild(`api(memory=${memoryEnabled})`, process.execPath, ['dist/main.js'], {
    cwd: apiRoot,
    logPath: apiOut,
    env: {
      NODE_ENV: 'development',
      PORT: String(apiPort),
      DB_TYPE: 'sqljs',
      DB_LOCATION: dbPath,
      ENCRYPTION_KEY: encryptionKey,
      AUTH_ENABLED: 'false',
      MEMORY_ENABLED: memoryEnabled,
      BACKGROUND_TASKS_ENABLED: 'false',
      MODEL_ROUTING_ENABLED: 'true',
      CORS_ORIGINS: '',
    },
  })
  children.push(child)
  return child
}

async function stopBackend() {
  while (children.length > 1) {
    const child = children.pop()
    child.handle.kill()
    await new Promise((resolve) => child.handle.once('exit', resolve))
  }
}

async function runCheck(script, checkArgs) {
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(process.execPath, [path.join(here, script), ...checkArgs], {
    cwd: apiRoot,
    encoding: 'utf8',
  })
  process.stdout.write(res.stdout ?? '')
  if (res.stderr) {
    process.stderr.write(res.stderr)
  }
  return res.status ?? 1
}

try {
  await step('启动假上游', async () => {
    const child = startChild('fake-upstream', process.execPath, [path.join(here, 'fake-upstream.mjs')], {
      cwd: apiRoot,
      logPath: upstreamOut,
      env: { UPSTREAM_PORT: String(upstreamPort), UPSTREAM_LOG: upstreamLog },
    })
    children.push(child)
    child.handle.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[live] 假上游提前退出：${tail(fs.readFileSync(upstreamOut, 'utf8'))}`)
      }
    })
    await waitForHealth(`http://127.0.0.1:${upstreamPort}/health`, 10000)
  })

  await step('播种临时库', async () => {
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync(
      process.execPath,
      [path.join(here, 'seed.mjs'), `--db=${dbPath}`, `--upstream=${upstreamBase}`],
      { cwd: apiRoot, encoding: 'utf8', env: { ...process.env, ENCRYPTION_KEY: encryptionKey } },
    )
    process.stdout.write(res.stdout ?? '')
    if (res.status !== 0) {
      throw new Error(`播种失败：${res.stderr?.slice(0, 400)}`)
    }
  })

  let backendMemoryMode = 'true'
  await step('启动后端（MEMORY_ENABLED=true）', async () => {
    startBackend(backendMemoryMode)
    await waitForHealth(`${base}/health`, 30000)
  })

  await step('核对健康检查口径', async () => {
    const health = (await api('GET', `${base}/health`)).json
    const expected = {
      database: 'up',
      encryption: 'enabled',
      auth: 'disabled',
      memory: 'enabled',
      memoryTable: 'up',
    }
    for (const [key, value] of Object.entries(expected)) {
      if (health?.[key] !== value) {
        throw new Error(`${key} 应为 ${value}，实得 ${JSON.stringify(health?.[key])}`)
      }
    }
    if (!health.promptVersion) {
      throw new Error('health 里没有 promptVersion')
    }
    const mode = (await api('GET', `${base}/auth/mode`)).json
    if (mode?.user?.username !== 'live-demo') {
      throw new Error(`免登录身份应是播种账号 live-demo，实得 ${JSON.stringify(mode?.user)}`)
    }
  })

  for (const suite of suites) {
    if (suite === 'chat-memory-off' && backendMemoryMode !== 'false') {
      await step('重启后端（MEMORY_ENABLED=false）', async () => {
        await stopBackendKeepUpstream()
        backendMemoryMode = 'false'
        startBackend(backendMemoryMode)
        await waitForHealth(`${base}/health`, 30000)
      })
    }
    if (suite === 'chat-memory' && backendMemoryMode !== 'true') {
      await step('重启后端（MEMORY_ENABLED=true）', async () => {
        await stopBackendKeepUpstream()
        backendMemoryMode = 'true'
        startBackend(backendMemoryMode)
        await waitForHealth(`${base}/health`, 30000)
      })
    }

    const label = { 'chat-core': '对话链路', 'chat-memory': '长期记忆', 'chat-memory-off': '长期记忆关闭态', config: '配置接口' }[suite]
    const script = suite === 'config' ? 'check-config.mjs' : 'check-chat.mjs'
    const checkArgs =
      suite === 'config'
        ? [`--base=${base}`, `--db=${dbPath}`]
        : [`--base=${base}`, `--log=${upstreamLog}`, `--suite=${suite.replace('chat-', '')}`]
    const status = await runCheck(script, checkArgs)
    if (status !== 0) {
      failures += 1
      console.error(`[live] ${label} 有断言未通过`)
    } else {
      console.log(`[live] ${label} 全部通过`)
    }
  }
} catch (error) {
  failures += 1
  console.error(`[live] 链路没跑起来：${error?.message ?? error}`)
  for (const file of [upstreamOut, apiOut]) {
    if (fs.existsSync(file)) {
      console.error(`[live] ${path.basename(file)} 末尾：\n${tail(fs.readFileSync(file, 'utf8'), 25)}`)
    }
  }
} finally {
  for (const child of children) {
    try {
      child.handle.kill()
    } catch {
      // 进程已经退了
    }
  }
  if (keep || failures > 0) {
    console.log(`[live] 现场留在 ${workspace}（upstream.jsonl 是每条上游请求的证据）`)
  } else {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

/** 只停后端，假上游留着：续传与工具轮都靠它的日志，重启它会把证据清零 */
async function stopBackendKeepUpstream() {
  const backend = children.pop()
  if (!backend || backend.label.startsWith('fake')) {
    return
  }
  backend.handle.kill()
  await new Promise((resolve) => backend.handle.once('exit', resolve))
}

console.log(
  `[live] 结束：${failures === 0 ? '全绿' : `${failures} 个环节有问题`}，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
)
process.exit(failures === 0 ? 0 : 1)
