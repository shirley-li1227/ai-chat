import { randomBytes, scrypt, timingSafeEqual } from 'crypto'

interface ScryptCost {
  N: number
  r: number
  p: number
}

/** scrypt 有多个重载，promisify 推不出带 options 的那个，这里显式包一层 */
function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: ScryptCost,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, cost, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

// N=16384/r=8/p=1 约占 16MB 内存，落在 Node 默认 maxmem(32MB) 内，
// 不必为每次登录调大进程内存上限
const CRYPT_PARAMS: ScryptCost = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const PREFIX = 'scrypt'

/** 输出格式：scrypt$N$r$p$salt$hash，参数随散列一起存，日后调参不影响老口令校验 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await deriveKey(normalize(plain), salt, KEY_LENGTH, CRYPT_PARAMS)
  return [
    PREFIX,
    CRYPT_PARAMS.N,
    CRYPT_PARAMS.r,
    CRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * 校验口令。存储值格式不合法时按失败处理，绝不因为解析异常把用户挡在门外报 500。
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    return false
  }

  const [, nText, rText, pText, saltText, hashText] = parts
  const cost = { N: Number(nText), r: Number(rText), p: Number(pText) }
  const expected = Buffer.from(hashText, 'base64')
  if (
    !Number.isInteger(cost.N) ||
    !Number.isInteger(cost.r) ||
    !Number.isInteger(cost.p)
  ) {
    return false
  }

  let actual: Buffer
  try {
    actual = await deriveKey(
      normalize(plain),
      Buffer.from(saltText, 'base64'),
      expected.length,
      cost,
    )
  } catch {
    return false
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** 登录时统一做 NFKC 归一，避免同形字符造成「密码看起来一样却登不进去」 */
function normalize(plain: string): string {
  return plain.normalize('NFKC')
}
