import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ApiConfig, ApiConfigView, ProviderType } from "../types";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESETS,
  buildChatCompletionsUrl,
  isHttpsBaseUrl,
} from "../apiConfig";
import ModelMultiSelect from "./ModelMultiSelect";

/** 表单在内存里的形态：模型是一个有序清单，保存时才摊成 model + routingCandidates */
interface Draft {
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  /** 已选模型，顺序即档位从低到高；最后一档同时作为主力模型 */
  models: string[];
}

interface ApiConfigModalProps {
  /** 当前生效那份，列表为空时说明这个账号还没配过任何一家 */
  active: ApiConfigView | null;
  /** 这个账号保存过的全部配置，每家最多一份 */
  items: ApiConfigView[];
  onClose: () => void;
  onSave: (
    draft: ApiConfig & { routingCandidates: string },
    options: { apply: boolean },
  ) => Promise<void>;
  onActivate: (provider: ProviderType) => Promise<void>;
  onDelete: (provider: ProviderType) => Promise<void>;
  onClear: () => Promise<void>;
}

function parseModels(raw: string | null | undefined): string[] {
  const items = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

/**
 * 库里的 model 与 routingCandidates 是两个字段，多选下拉只有一个有序清单，
 * 所以展开时把主力模型并进来：它不在候选里就被排到最后一档（路由关闭时用它作答）。
 */
function draftFrom(
  provider: ProviderType,
  saved: ApiConfigView | undefined,
): Draft {
  const preset = PROVIDER_PRESETS[provider];
  if (!saved) {
    return {
      provider,
      apiKey: "",
      baseUrl: preset.defaultBaseUrl,
      models: [preset.defaultModel],
    };
  }
  const models = parseModels(saved.routingCandidates);
  if (saved.model && !models.includes(saved.model)) {
    models.push(saved.model);
  }
  return {
    provider,
    apiKey: "",
    baseUrl: saved.baseUrl,
    models: models.length > 0 ? models : [preset.defaultModel],
  };
}

/** 保存载荷：前端多选清单 → 后端两个字段 */
function payloadOf(draft: Draft): ApiConfig & { routingCandidates: string } {
  const models = draft.models;
  return {
    provider: draft.provider,
    apiKey: draft.apiKey.trim(),
    baseUrl: draft.baseUrl.trim(),
    // 候选为空时路由器恒用主力模型，所以最后一档（最强那档）就是主力
    model: models[models.length - 1] ?? "",
    routingCandidates: models.length > 1 ? models.join(",") : "",
  };
}

export default function ApiConfigModal({
  active,
  items,
  onClose,
  onSave,
  onActivate,
  onDelete,
  onClear,
}: ApiConfigModalProps) {
  /**
   * 表单初值在挂载时从 props 取一次快照（父组件只在打开时挂载本组件）：
   * 挂在 effect 里重置会在每次列表刷新时把用户正在编辑的内容一起覆盖掉。
   */
  const [provider, setProvider] = useState<ProviderType>(
    () =>
      active?.provider ??
      items.find((item) => item.active)?.provider ??
      PROVIDER_ORDER[0],
  );
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(
      provider,
      items.find((i) => i.provider === provider),
    ),
  );
  const [apply, setApply] = useState(true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const savedOf = useCallback(
    (target: ProviderType) => items.find((item) => item.provider === target),
    [items],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const preset = PROVIDER_PRESETS[provider];
  const savedHere = savedOf(provider);
  const trimmedKey = draft.apiKey.trim();
  const errors = {
    /** 留空 = 沿用库里那把 Key，只有这家从没存过时才拦下来 */
    apiKey: trimmedKey.length === 0 && !savedHere ? "请填写 API Key" : null,
    baseUrl: draft.baseUrl.trim()
      ? isHttpsBaseUrl(draft.baseUrl)
        ? null
        : "Base URL 必须是 https 协议，可以带路径（如 https://open.bigmodel.cn/api/paas/v4）"
      : "请填写 Base URL",
    model: draft.models.length === 0 ? "请至少选择一个模型" : null,
  };
  const canSubmit = !errors.apiKey && !errors.baseUrl && !errors.model;

  // 已保存列表排在编辑区之前，切换生效供应商是「列表里点一下」而不是「重新填一遍 Key」
  const savedProviders = useMemo(
    () =>
      PROVIDER_ORDER.map((type) => ({ type, view: savedOf(type) })).filter(
        (row): row is { type: ProviderType; view: ApiConfigView } =>
          Boolean(row.view),
      ),
    [savedOf],
  );

  const handleProviderChange = (next: ProviderType) => {
    setProvider(next);
    setDraft(draftFrom(next, savedOf(next)));
    setTouched(false);
    setFeedback(null);
  };

  /** 保存/切换/删除共用一个 busy：连点两次「设为生效」会把指针翻回前一份 */
  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setFeedback(null);
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "操作失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) {
      return;
    }
    void runAction(async () => {
      await onSave(payloadOf(draft), { apply });
      setDraft((prev) => ({ ...prev, apiKey: "" }));
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-config-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        <form onSubmit={handleSubmit}>
          <header className="flex items-start justify-between border-b border-slate-100 px-6 py-4">
            <div>
              <h2
                id="api-config-title"
                className="text-lg font-semibold text-slate-800"
              >
                大模型 API 设置
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                每家供应商各存一份 Key，同时只有一份在用
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12" />
                <path d="M18 6 6 18" />
              </svg>
            </button>
          </header>

          <div className="max-h-[70vh] space-y-5 overflow-y-auto px-6 py-5">
            {savedProviders.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium text-slate-700">
                  已保存的配置
                </h3>
                <ul className="space-y-2">
                  {savedProviders.map(({ type, view }) => (
                    <li
                      key={type}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${
                        view.active
                          ? "border-emerald-200 bg-emerald-50/70"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-slate-700">
                          {view.label}
                          {view.active ? (
                            <span className="ml-2 rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-medium text-white">
                              当前使用
                            </span>
                          ) : null}
                        </span>
                        <p className="mt-0.5 truncate font-mono text-xs text-slate-500">
                          {view.routingCandidates
                            ? view.routingCandidates.split(",").join("、")
                            : view.model}{" "}
                          · {view.apiKeyMasked}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {provider === type ? (
                          <span className="text-xs text-emerald-600">
                            正在编辑
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleProviderChange(type)}
                            className="text-xs text-slate-500 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            编辑
                          </button>
                        )}
                        {!view.active ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction(() => onActivate(type))
                            }
                            className="text-xs text-emerald-600 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            设为使用
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void runAction(() => onDelete(type))}
                          className="text-xs text-red-500 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                服务供应商
              </label>
              <div className="grid grid-cols-2 gap-3">
                {PROVIDER_ORDER.map((type) => {
                  const item = PROVIDER_PRESETS[type];
                  const selected = provider === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleProviderChange(type)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition ${
                        selected
                          ? "border-emerald-400 bg-emerald-50/80 shadow-sm ring-1 ring-emerald-200"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className={`block text-sm font-semibold ${
                          selected ? "text-emerald-700" : "text-slate-700"
                        }`}
                      >
                        {item.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {item.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="api-key"
                className="text-sm font-medium text-slate-700"
              >
                API Key
              </label>
              <input
                id="api-key"
                type="password"
                value={draft.apiKey}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, apiKey: event.target.value }))
                }
                placeholder={
                  savedHere
                    ? "留空表示沿用已保存的 Key"
                    : preset.apiKeyPlaceholder
                }
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
              {touched && errors.apiKey ? (
                <p className="text-xs text-red-500">{errors.apiKey}</p>
              ) : (
                <p className="text-xs text-slate-400">
                  {savedHere
                    ? `当前已保存：${savedHere.apiKeyMasked}。${preset.apiKeyHint}`
                    : preset.apiKeyHint}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                模型（可多选）
              </label>
              <ModelMultiSelect
                key={provider}
                options={preset.modelOptions}
                value={draft.models}
                onChange={(models) => setDraft((prev) => ({ ...prev, models }))}
                placeholder={preset.modelPlaceholder}
                invalid={touched && Boolean(errors.model)}
              />
              <p className="text-xs text-slate-400">{preset.modelHint}</p>
              <p className="text-xs text-slate-400">
                可多选：服务端会按问题复杂度在勾选的模型里自动挑一个；只选一个就固定用它。
              </p>
              {touched && errors.model ? (
                <p className="text-xs text-red-500">{errors.model}</p>
              ) : null}
            </div>

            <details className="group rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
              <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">
                高级选项：Base URL
              </summary>
              <div className="mt-3 space-y-1.5">
                <input
                  type="text"
                  value={draft.baseUrl}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder={preset.defaultBaseUrl}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                />
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    后端将请求：
                    <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px] text-slate-600">
                      {buildChatCompletionsUrl(
                        draft.baseUrl || preset.defaultBaseUrl,
                      )}
                    </code>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        baseUrl: preset.defaultBaseUrl,
                      }))
                    }
                    className="text-emerald-600 hover:underline"
                  >
                    恢复默认
                  </button>
                </div>
                {touched && errors.baseUrl ? (
                  <p className="text-xs text-red-500">{errors.baseUrl}</p>
                ) : null}
              </div>
            </details>

            <p className="text-xs text-slate-500">
              获取 Key：
              <a
                href={preset.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 text-emerald-600 underline-offset-2 hover:underline"
              >
                {preset.label} 开放平台文档
              </a>
            </p>

            {feedback ? (
              <p
                role="alert"
                className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600"
              >
                {feedback}
              </p>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-6 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={apply}
                  onChange={(event) => setApply(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-500 focus:ring-emerald-200"
                />
                保存后设为当前使用
              </label>
              {items.length > 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      await onClear();
                      setDraft(draftFrom(provider, undefined));
                    })
                  }
                  className="text-xs text-red-500 underline-offset-2 hover:underline disabled:opacity-50"
                >
                  清除全部配置
                </button>
              ) : (
                <span className="text-xs text-slate-400">尚未保存任何配置</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
              >
                关闭
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
              >
                {busy ? "处理中..." : `保存 ${preset.label}`}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}
