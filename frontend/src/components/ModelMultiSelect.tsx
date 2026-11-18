import { useEffect, useMemo, useRef, useState } from "react";

interface ModelMultiSelectProps {
  /** 供应商预置的模型，按从省到强排列；用户仍可直接输入库里的其它模型 id */
  options: string[];
  /** 已选模型；数组顺序是内部换档依据，界面上不展示，只按 options 的自然顺序维护 */
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  invalid?: boolean;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

/**
 * 模型多选下拉。
 *
 * 「哪几档、从省到强怎么排」属于服务端路由的内部口径，不往界面上抛：
 * 用户只管勾哪些模型，顺序在组件内按预置列表（从省到强）+ 自定义项自动维护。
 * 预置项只是常用值提示，供应商的模型 id 会变，自定义输入始终开着。
 */
export default function ModelMultiSelect({
  options,
  value,
  onChange,
  placeholder,
  invalid = false,
}: ModelMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  /** 自定义项要单独留一份：取消勾选后它不在 value 里了，但仍得能被重新选上 */
  const [extraOptions, setExtraOptions] = useState<string[]>(() =>
    value.filter((model) => !options.includes(model)),
  );
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const allOptions = useMemo(
    () => unique([...options, ...extraOptions, ...value]),
    [options, extraOptions, value],
  );

  const toggle = (model: string) => {
    if (value.includes(model)) {
      onChange(value.filter((item) => item !== model));
      return;
    }
    // 新勾选的项按 options 的自然顺序插入，而不是追加到末尾：
    // 预设本身就是从省到强，「先勾主力再勾便宜档」不该把便宜的那档排到后面。
    const rank = allOptions.indexOf(model);
    const next = [...value];
    const at = next.findIndex((item) => allOptions.indexOf(item) > rank);
    if (at === -1) {
      next.push(model);
    } else {
      next.splice(at, 0, model);
    }
    onChange(next);
  };

  const addCustom = () => {
    const model = custom.trim();
    if (!model) {
      return;
    }
    if (!options.includes(model) && !extraOptions.includes(model)) {
      setExtraOptions((prev) => [...prev, model]);
    }
    if (!value.includes(model)) {
      onChange([...value, model]);
    }
    setCustom("");
  };

  const summary =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? value[0]
        : `${value[0]} 等 ${value.length} 个`;

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`flex w-full items-center justify-between gap-2 rounded-xl border bg-white px-3 py-2 text-left text-sm outline-none transition ${
            invalid
              ? "border-red-300 focus:border-red-400 focus:ring-2 focus:ring-red-100"
              : "border-slate-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
          }`}
        >
          <span
            className={
              value.length === 0 ? "text-slate-400" : "truncate text-slate-800"
            }
          >
            {summary}
          </span>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open ? (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-2">
              <input
                type="text"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustom();
                  }
                }}
                placeholder="没有？直接输入模型 id"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
              <button
                type="button"
                onClick={addCustom}
                disabled={custom.trim().length === 0}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
              >
                添加
              </button>
            </div>
            <ul className="max-h-56 overflow-y-auto py-1">
              {allOptions.map((model) => {
                const checked = value.includes(model);
                return (
                  <li key={model}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(model)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-500 focus:ring-emerald-200"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">
                        {model}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>

      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((model) => (
            <li
              key={model}
              className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1"
            >
              <span className="font-mono text-xs text-slate-700">{model}</span>
              <button
                type="button"
                onClick={() => toggle(model)}
                aria-label={`移除 ${model}`}
                className="rounded px-1 text-xs text-red-500 transition hover:bg-red-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
