/**
 * 是否启用真实登录。关掉时后端不再要求 token，所有请求以「演示身份」执行，
 * 前端因此可以跳过登录页直接看到既有数据。
 *
 * 缺省即关闭，所以发布上去不用配任何东西——代价是这个开关只会失效到「不鉴权」那一侧：
 * 域名公开时 /api/chat 与 /api/config 对所有访问者可用，大模型配额和 API Key 由大家共用，
 * 只剩 IP 限流兜底。对外收紧只需把 AUTH_ENABLED 设为 true，注册/登录链路一直保留着。
 * 线上实际处于哪一侧不用猜，/api/health 的 auth 字段直接写着。
 * 判定与 BACKGROUND_TASKS_ENABLED 一致——只认字面 'true'，TRUE/1 都不算开启。
 */
export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === 'true'
}

/** 空库兜底账号名。已有账号时不会用到它——演示身份优先复用既有数据的主人 */
export const DEMO_USERNAME = 'demo'
