import { useCallback, useEffect, useRef, useState } from 'react'
import ApiConfigModal from './components/ApiConfigModal'
import AuthView from './components/AuthView'
import ChatInterface from './components/ChatInterface'
import type { ApiConfig, Conversation, Message, ProviderType, ToolStep } from './types'
import {
  UNAUTHORIZED_EVENT,
  ChatStreamError,
  activateConfig,
  clearConfig,
  createConversation,
  deleteConfig,
  deleteConversation as apiDeleteConversation,
  truncateConversation,
  fetchConfigs,
  fetchConversation,
  fetchConversations,
  fetchCurrentUser,
  fetchAuthMode,
  isAbortError,
  logoutUser,
  resumeChat,
  setAuthToken,
  saveConfig,
  streamChat,
} from './client'
import type { AuthSession, AuthUser, ConfigListResponse, ModelInfo } from './client'

const BACKEND_DOWN = '无法连接到后端服务，请确认已启动 npm run dev:api'

/** 配置列表的空态：切账号、后端不可用时都回到这里 */
const NO_CONFIG: ConfigListResponse = { configured: false, active: null, items: [] }

/**
 * 断线续传次数上限与退避基数（第 n 次等 n×1.2 秒）。
 * 3 次是权衡过的结果：再多通常意味着网络真的没了，与其让界面一直转圈，
 * 不如把「重新生成」这个明确出口交还给用户；也不至于在 10 次/60 秒的限流下自我封锁。
 */
const MAX_RESUME_ATTEMPTS = 3
const RESUME_BACKOFF_MS = 1200

/** 断网时等浏览器报 online 的上限，免得几次退避全烧在还没通的网络上 */
const ONLINE_WAIT_MS = 15000

/** 可被 abort 提前结束的等待：用户点停止或离开页面时不该继续傻等 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function waitForOnline(signal?: AbortSignal): Promise<void> {
  if (navigator.onLine) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      window.removeEventListener('online', finish)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ONLINE_WAIT_MS)
    window.addEventListener('online', finish, { once: true })
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')
  const [isSending, setIsSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [configList, setConfigList] = useState<ConfigListResponse>({
    configured: false,
    active: null,
    items: [],
  })
  // 有生效那份才有 Key 可用：没有就既不能发问题，也不该让用户以为界面坏了
  const hasConfig = configList.active !== null
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  // 免登录模式（后端 AUTH_ENABLED != true）：不渲染登录页，也不给「退出登录」入口
  const [demoMode, setDemoMode] = useState(false)
  // 首屏要先拿 token 换登录态，其间既不该闪登录页也不该闪聊天页
  const [booting, setBooting] = useState(true)
  // 模型自己调 remember/forget 会改动记忆清单，清单不在这个状态里就没人知道要重取
  const [memoryRevision, setMemoryRevision] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  /** 拉会话列表，没有就建一个；返回当前应使用的会话。 */
  const loadConversations = useCallback(async (): Promise<Conversation> => {
    const list = await fetchConversations()
    if (list.length > 0) {
      setConversations(list)
      setActiveConversationId(list[0].id)
      return list[0]
    }

    const conv = await createConversation()
    setConversations([conv])
    setActiveConversationId(conv.id)
    return conv
  }, [])

  /** 清掉当前账号的一切界面状态，切账号/掉登录态都走这里，避免残留上一个账号的数据 */
  const resetWorkspace = useCallback(() => {
    setConversations([])
    setActiveConversationId('')
    setConfigList(NO_CONFIG)
    setConfigModalOpen(false)
    setErrorMessage(null)
  }, [])

  // 登录后拉取该账号的配置与会话
  const loadWorkspace = useCallback(async (): Promise<void> => {
    resetWorkspace()
    try {
      const cfg = await fetchConfigs()
      setConfigList(cfg)
      // 没配 Key 就直接把弹窗摆出来：登录后要做的第一件事只有这一件
      setConfigModalOpen(cfg.active === null)
      await loadConversations()
    } catch {
      // Backend not available yet
      setErrorMessage(BACKEND_DOWN)
    }
  }, [loadConversations, resetWorkspace])

  // 首屏先确认鉴权模式：免登录时身份由后端给出；真实登录才用本地 token 换回登录态
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      const mode = await fetchAuthMode().catch(() => null)
      const demo = mode && !mode.authEnabled ? mode.user : null
      if (cancelled) {
        return
      }
      setBooting(false)
      setDemoMode(!!demo)
      if (demo) {
        setUser(demo)
        await loadWorkspace()
        return
      }
      const me = await fetchCurrentUser().catch(() => null)
      if (cancelled) {
        return
      }
      setUser(me)
      if (me) {
        await loadWorkspace()
      }
    }
    boot()
    return () => {
      cancelled = true
    }
  }, [loadWorkspace])

  // 任一接口返回 401（token 过期或已在别处登出）：收回登录态，回登录页
  useEffect(() => {
    const onUnauthorized = () => {
      setAuthToken(null)
      setUser(null)
      setDemoMode(false)
      resetWorkspace()
      abortRef.current?.abort()
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [resetWorkspace])

  const handleSession = useCallback(
    async (session: AuthSession) => {
      setAuthToken(session.token)
      setUser(session.user)
      await loadWorkspace()
    },
    [loadWorkspace],
  )

  const handleLogout = useCallback(async () => {
    abortRef.current?.abort()
    await logoutUser()
    setUser(null)
    resetWorkspace()
  }, [resetWorkspace])

  // Load messages when switching conversation
  useEffect(() => {
    if (!activeConversationId) return
    const loadMessages = async () => {
      try {
        const conv = await fetchConversation(activeConversationId)
        setConversations((prev) =>
          prev.map((c) => (c.id === conv.id ? conv : c)),
        )
      } catch {
        // ignore
      }
    }
    loadMessages()
  }, [activeConversationId])

  // 离开页面 / 组件卸载时主动断开在途的 SSE 流：
  // 浏览器虽会在整页卸载时自动断连，但 CloudBase 网关对 SSE 的 close 透传不保证实时，
  // 主动 abort 可及时停掉后端对上游大模型的请求，避免继续消耗额度、落库半截回答。
  useEffect(() => {
    const onLeave = () => abortRef.current?.abort()
    window.addEventListener('pagehide', onLeave)
    return () => {
      window.removeEventListener('pagehide', onLeave)
      abortRef.current?.abort()
    }
  }, [])

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const activeMessages = activeConversation?.messages ?? []
  const hasEmptyConversation = conversations.some((conversation) => conversation.messages.length === 0)

  const handleSend = async (content: string) => {
    // 首屏加载撞上后端重启时会话列表会停在空态，这里补拉一次而不是无声失败
    const target =
      activeConversation ?? (await loadConversations().catch(() => null))
    if (!target) {
      setErrorMessage(BACKEND_DOWN)
      return
    }

    if (!hasConfig) {
      setErrorMessage('尚未配置大模型 API，请先完成配置。')
      setConfigModalOpen(true)
      return
    }

    setErrorMessage(null)

    // Optimistically add user message + empty assistant message to UI
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    const assistantTimestamp = Date.now() + 1
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      timestamp: assistantTimestamp,
      steps: [],
    }

    setConversations((prev) =>
      prev.map((conversation) => {
        if (conversation.id !== target.id) {
          return conversation
        }
        const nextMessages = [...conversation.messages, userMessage, assistantMessage]
        return {
          ...conversation,
          messages: nextMessages,
          title: conversation.messages.filter((m) => m.role === 'user').length === 0
            ? content.slice(0, 24) || '新对话'
            : conversation.title,
          updatedAt: Date.now(),
        }
      }),
    )
    setIsSending(true)

    const controller = new AbortController()
    abortRef.current = controller

    // 局部累加，避免每个 chunk 都发 DB 请求
    const liveSteps: ToolStep[] = []
    // 已经渲染出来的正文：既是续传要带回服务端的进度，也是重连失败后界面上留下的内容
    let generated = ''

    const updateAssistant = (patch: (message: Message) => Message) => {
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id !== target.id
            ? conversation
            : {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.timestamp === assistantTimestamp ? patch(message) : message,
                ),
                updatedAt: Date.now(),
              },
        ),
      )
    }

    const appendChunk = (chunk: string) => {
      generated += chunk
      updateAssistant((message) => ({ ...message, content: message.content + chunk }))
    }

    const onStep = (step: ToolStep) => {
      // calling 追加新条目；streaming 累加增量；done/error 回填同 id 步骤，
      // 续传后的新步骤 id 不会与旧的相撞
      const terminal = step.status === 'done' || step.status === 'error'
      if (step.status === 'calling') {
        liveSteps.push(step)
      } else {
        const matchIndex = step.id
          ? liveSteps.findIndex((s) => s.id === step.id)
          : liveSteps.findLastIndex((s) => s.name === step.name && s.result === undefined)
        if (matchIndex >= 0) {
          const prev = liveSteps[matchIndex]
          liveSteps[matchIndex] = {
            ...prev,
            ...step,
            // 增量只在执行期间有意义：终态的 result 就是全文，留着 delta 会显示两遍
            delta: terminal ? undefined : (prev.delta ?? '') + (step.delta ?? ''),
            progress: terminal ? undefined : step.progress ?? prev.progress,
          }
        } else {
          liveSteps.push(step)
        }
      }
      // 清单是模型改的，界面只能从工具终态得知；不重取的话面板会一直停在旧内容，
      // 用户看不到「它到底记了什么」，也就没机会纠正
      if (terminal && (step.name === 'remember' || step.name === 'forget')) {
        setMemoryRevision((n) => n + 1)
      }
      updateAssistant((message) => ({ ...message, steps: [...liveSteps] }))
    }

    const onNotice = (text: string) => {
      // 流内非致命提示（如回答被长度上限截断）：复用顶部警告横幅，保留已生成内容
      setErrorMessage(text)
    }

    /**
     * 服务端按场景挑好的模型，写进气泡：一次会话里不同问题的档位可以不同，
     * 「刚才是谁答的」要能对应到具体那条回答。
     */
    const onModel = (info: ModelInfo) => {
      updateAssistant((message) => ({
        ...message,
        model: info.id,
        modelReason: info.reason,
      }))
    }

    /**
     * 放弃续传。一条字都没生成才替换气泡内容；已经有半截就只挂横幅——
     * 覆盖掉用户已经看到的文字，比报个错更让人恼火。
     */
    const giveUp = (error: unknown) => {
      const msg = error instanceof Error ? error.message : '请求失败，请稍后重试。'
      if (generated) {
        setErrorMessage(`回答没能续写完成，已保留前面生成的内容。${msg}`)
      } else {
        setErrorMessage(`请求失败：${msg}`)
        updateAssistant((message) => ({
          ...message,
          content: `抱歉，暂时无法回答。\n\n${msg}`,
        }))
      }
    }

    // 一条字都没有时无从「续」；后端标了不可重试的错误（密钥失效、额度不足）重试只是再烧一次额度
    const canResume = (error: unknown) =>
      error instanceof ChatStreamError && error.retryable && generated.length > 0

    /** 回到断点接着写：每次把当前已生成文本重新交出去，服务端只回后半段增量 */
    const resumeFromBreak = async (firstError: unknown): Promise<boolean> => {
      let lastError = firstError
      for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt++) {
        await waitForOnline(controller.signal)
        await sleep(RESUME_BACKOFF_MS * attempt, controller.signal)
        if (controller.signal.aborted) {
          return false
        }

        setErrorMessage(`连接中断，正在第 ${attempt}/${MAX_RESUME_ATTEMPTS} 次自动续传…`)
        try {
          await resumeChat(target.id, content, generated, {
            onChunk: appendChunk,
            onStep,
            onNotice,
            onModel,
            signal: controller.signal,
          })
          setErrorMessage('网络曾中断，回答已从断点续写完成。')
          return true
        } catch (error) {
          // 等待或续传途中用户点了停止：半截内容照旧保留，不报错
          if (isAbortError(error) || controller.signal.aborted) {
            return false
          }
          lastError = error
          if (!canResume(error)) {
            giveUp(error)
            return false
          }
        }
      }

      giveUp(lastError)
      return false
    }

    try {
      let completed = true
      try {
        await streamChat(target.id, content, {
          onChunk: appendChunk,
          onStep,
          onNotice,
          onModel,
          signal: controller.signal,
        })
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          // 用户主动停止：后端已把半截回答落库，界面原样保留，这不算失败
          completed = false
        } else if (canResume(error)) {
          completed = await resumeFromBreak(error)
        } else {
          giveUp(error)
          completed = false
        }
      }

      if (completed) {
        // 流结束后从 DB 重载，确保 steps 轨迹与持久化结果一致；
        // 重载失败不影响界面上已经看到的回答，下次进入会话会再拉一次
        const refreshed = await fetchConversation(target.id).catch(() => null)
        if (refreshed) {
          setConversations((prev) =>
            prev.map((conversation) =>
              conversation.id === target.id ? refreshed : conversation,
            ),
          )
        }
      }
    } finally {
      abortRef.current = null
      setIsSending(false)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
  }

  /**
   * 把会话回退到某条消息之前：先改后端，再同步本地状态。
   * 顺序不能反——本地先删、后端失败，会留下“界面没了、库里还在”的不一致，
   * 刷新后消息复活，比什么都不做更让人困惑。
   */
  const rewindTo = async (conversationId: string, messageTimestamp: number) => {
    await truncateConversation(conversationId, messageTimestamp)
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: conversation.messages.filter(
                (message) => message.timestamp < messageTimestamp,
              ),
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    )
  }

  /**
   * 重新生成：连同上一条用户消息一起回退再原样重发。
   * 若只删 assistant 回答、保留 user 消息，重发会让同一句话在库里出现两遍，
   * 下一轮上下文因此多出一条重复提问。
   */
  const handleRegenerate = async () => {
    if (!activeConversation || isSending || !hasConfig) {
      return
    }

    const lastUserMessage = [...activeConversation.messages]
      .reverse()
      .find((message) => message.role === 'user')
    if (!lastUserMessage) {
      return
    }

    setErrorMessage(null)
    try {
      await rewindTo(activeConversation.id, lastUserMessage.timestamp)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '回退对话失败')
      return
    }

    // 截断后走正常发送流程：用户消息会重新落库，回答也是全新一条
    await handleSend(lastUserMessage.content)
  }

  /**
   * 编辑重发：回退到该条用户消息之前，把原文交回输入框由用户改。
   * 这里只返回内容、不直接操作输入框，是为了让 input 状态继续由 ChatInterface 持有。
   */
  const handleEditMessage = async (message: Message): Promise<string | null> => {
    if (isSending || message.role !== 'user' || !activeConversationId) {
      return null
    }

    setErrorMessage(null)
    try {
      await rewindTo(activeConversationId, message.timestamp)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '回退对话失败')
      return null
    }

    return message.content
  }

  const handleNewChat = async () => {
    if (hasEmptyConversation) {
      const emptyConversation = conversations.find((conversation) => conversation.messages.length === 0)
      if (emptyConversation) {
        setActiveConversationId(emptyConversation.id)
      }
      setErrorMessage(null)
      return
    }

    const conv = await createConversation()
    setConversations((prev) => [conv, ...prev])
    setActiveConversationId(conv.id)
    setErrorMessage(null)
  }

  const handleSelectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId)
    setErrorMessage(null)
  }

  const handleDeleteConversation = async (conversationId: string) => {
    await apiDeleteConversation(conversationId)
    setConversations((prev) => {
      const filtered = prev.filter((conversation) => conversation.id !== conversationId)
      if (filtered.length === 0) {
        const fallback = {
          id: crypto.randomUUID(),
          title: '新对话',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        setActiveConversationId(fallback.id)
        return [fallback]
      }

      if (activeConversationId === conversationId) {
        setActiveConversationId(filtered[0].id)
      }
      return filtered
    })
    setErrorMessage(null)
  }

  /** 保存/切换/删除都重新取一次列表：生效指针由后端决定，前端不自己推断「哪份该显示成当前使用」 */
  const refreshConfigs = useCallback(async () => {
    setConfigList(await fetchConfigs())
  }, [])

  const handleSaveConfig = async (
    config: ApiConfig & { routingCandidates: string },
    options: { apply: boolean },
  ) => {
    const { routingCandidates, ...rest } = config
    await saveConfig(rest, { routingCandidates, apply: options.apply })
    await refreshConfigs()
    setErrorMessage(null)
    // 登录时因为「一家都没配」自动弹出的那个窗，配好就该收了；主动打开的留着方便切
    if (configList.active === null) {
      setConfigModalOpen(false)
    }
  }

  const handleActivateConfig = async (provider: ProviderType) => {
    await activateConfig(provider)
    await refreshConfigs()
    setErrorMessage(null)
  }

  const handleDeleteConfig = async (provider: ProviderType) => {
    await deleteConfig(provider)
    await refreshConfigs()
    setErrorMessage(null)
  }

  const handleClearConfig = async () => {
    await clearConfig()
    setConfigList(NO_CONFIG)
  }

  const handleOpenConfig = useCallback(() => {
    setConfigModalOpen(true)
  }, [])

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-gradient-to-br from-slate-50 via-white to-emerald-50/70 text-sm text-slate-500">
        <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
        </svg>
        正在恢复登录状态…
      </div>
    )
  }

  // 未登录时连聊天界面都不渲染，API Key 弹窗自然也只在登录之后才可能出现
  if (!user) {
    return <AuthView onSession={handleSession} />
  }

  return (
    <>
      <ChatInterface
        user={user}
        demoMode={demoMode}
        conversations={conversations}
        activeConversationId={activeConversationId}
        hasEmptyConversation={hasEmptyConversation}
        messages={activeMessages}
        isSending={isSending}
        errorMessage={errorMessage}
        apiConfig={configList.active}
        hasConfig={hasConfig}
        memoryRevision={memoryRevision}
        onOpenConfig={handleOpenConfig}
        onStop={handleStop}
        onSend={handleSend}
        onRegenerate={handleRegenerate}
        onEditMessage={handleEditMessage}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onLogout={handleLogout}
      />
      {/* 只在使用时挂载：弹窗的表单初值取的是挂载那一刻的配置，常驻会留着上次编辑的残值 */}
      {configModalOpen ? (
        <ApiConfigModal
          active={configList.active}
          items={configList.items}
          onClose={() => setConfigModalOpen(false)}
          onSave={handleSaveConfig}
          onActivate={handleActivateConfig}
          onDelete={handleDeleteConfig}
          onClear={handleClearConfig}
        />
      ) : null}
    </>
  )
}

export default App
