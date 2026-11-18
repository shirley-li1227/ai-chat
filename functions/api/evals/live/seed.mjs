/**
 * 给临时库播种：一个演示账号 + 两家配置。
 *
 * 为什么不走 HTTP 保存：`baseUrl` 必须 https 是**产品约束**，本地假上游是 http，
 * 为了演通去放宽校验就把要验的东西本身改掉了。所以这里直接调数据层写入
 * （校验只在 DTO 层，运行时不再复查），密文仍由同一把主密钥经 SecretCipher 产出。
 *
 * 智谱的 baseUrl 也指向假上游，只是换一条路径：这样「切家之后请求真的换了 Key、
 * 真的走了那家的路径」能在上游日志里看见，而不会打到真实网关。
 * 界面/HTTP 层的 https 拦截另有 check-config 的 400 断言负责。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAKE_KEYS, parseArgs } from './lib.mjs'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(here, '../..')

const args = parseArgs(process.argv.slice(2))
const dbLocation = args.db
const upstreamBase = args.upstream
const key = process.env.ENCRYPTION_KEY
if (!dbLocation || !upstreamBase || !key) {
  console.error('用法：node seed.mjs --db <临时库路径> --upstream http://127.0.0.1:<port>，且 ENCRYPTION_KEY 必须在环境里')
  process.exit(2)
}

require('reflect-metadata')
const { DataSource } = require(path.join(apiRoot, 'node_modules/typeorm'))
const { ApiConfigEntity } = require(path.join(apiRoot, 'dist/config/api-config.entity.js'))
const { User } = require(path.join(apiRoot, 'dist/auth/user.entity.js'))
const { Conversation } = require(path.join(apiRoot, 'dist/conversations/conversation.entity.js'))
const { Message } = require(path.join(apiRoot, 'dist/conversations/message.entity.js'))
const { Session } = require(path.join(apiRoot, 'dist/auth/session.entity.js'))
const { Task } = require(path.join(apiRoot, 'dist/tasks/task.entity.js'))
const { UserMemory } = require(path.join(apiRoot, 'dist/memory/memory.entity.js'))
const { SecretCipher } = require(path.join(apiRoot, 'dist/security/secret-cipher.js'))
const { hashPassword } = require(path.join(apiRoot, 'dist/auth/password-hasher.js'))

// 实体清单要和 app.module 保持一致，否则这边建不出的表到那边就是 missing
const dataSource = new DataSource({
  type: 'sqljs',
  location: dbLocation,
  autoSave: true,
  entities: [ApiConfigEntity, Conversation, Message, User, Session, Task, UserMemory],
  synchronize: true,
})

await dataSource.initialize()

const cipher = new SecretCipher(key)
if (!cipher.enabled) {
  console.error(`主密钥不可用：${cipher.disableReason}`)
  await dataSource.destroy()
  process.exit(2)
}

const users = dataSource.getRepository(User)
let user = await users.findOne({ where: { username: 'live-demo' } })
if (!user) {
  user = await users.save(
    users.create({ username: 'live-demo', passwordHash: await hashPassword('live-harness-not-a-secret') }),
  )
}

const configs = dataSource.getRepository(ApiConfigEntity)
await configs.delete({ userId: user.id })
await configs.save([
  configs.create({
    userId: user.id,
    provider: 'deepseek',
    apiKey: cipher.encrypt(FAKE_KEYS.deepseek),
    baseUrl: `${upstreamBase}/v1`,
    model: 'test-chat',
    routingCandidates: 'test-flash,test-pro',
    active: true,
  }),
  configs.create({
    userId: user.id,
    provider: 'zhipu',
    apiKey: cipher.encrypt(FAKE_KEYS.zhipu),
    baseUrl: `${upstreamBase}/api/paas/v4`,
    model: 'glm-live',
    routingCandidates: 'glm-air,glm-pro',
    active: false,
  }),
])

// 落盘：sqljs 只在 destroy 时写文件，没写完就起后端会得到一个空库
await dataSource.destroy()

console.log(JSON.stringify({ seeded: { userId: user.id, username: user.username, db: dbLocation } }))
