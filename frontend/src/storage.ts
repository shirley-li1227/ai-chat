import type { Conversation } from './types'

/**
 * 会话本地存储：整段对话（含工具轨迹）存在浏览器 IndexedDB 里，后端不留副本。
 *
 * 为什么不用 localStorage：工具抓取结果单条就有几 KB，几条对话就能顶到 ~5MB 配额，
 * 而且它是同步 API，写入会卡住流式渲染。
 */
const DB_NAME = 'ai-chat-demo'
const STORE = 'conversations'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const request = action(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error)
  })
}

export async function loadConversations(): Promise<Conversation[]> {
  const list = await run<Conversation[]>('readonly', (store) => store.getAll())
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveConversation(conversation: Conversation): Promise<unknown> {
  return run('readwrite', (store) => store.put(conversation))
}

export function removeConversation(id: string): Promise<unknown> {
  return run('readwrite', (store) => store.delete(id))
}
