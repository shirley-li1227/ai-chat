# AI 聊天助手

基于 React + NestJS 的全栈 AI 聊天应用，支持流式输出、多轮对话、Markdown 渲染和代码高亮。

## 功能特性

- 流式输出：AI 回答逐字显示（SSE）
- 多轮对话：自动携带历史消息上下文
- 多会话管理：创建、切换、删除对话
- Markdown 渲染：支持 GFM 表格、任务列表、代码高亮
- API 配置弹窗：运行时填写 DeepSeek API Key，无需重启
- 后端持久化：对话历史和 API Key 存储在 SQLite 数据库中
- 安全设计：API Key 仅存后端，前端不接触明文密钥

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4 |
| 后端 | NestJS 11 + TypeORM + sql.js (SQLite) |
| 大模型 | DeepSeek（兼容 OpenAI Chat Completions 协议） |
| Markdown | react-markdown + remark-gfm + react-syntax-highlighter |

## 快速开始

### 环境要求

- Node.js >= 20
- npm >= 10

### 安装与启动

```bash
# 1. 一次安装前后端依赖（在仓库根目录执行）
npm run install:all

# 2. 启动后端（终端 1）
npm run dev:api

# 3. 启动前端（终端 2）
npm run dev
```

打开浏览器访问 `http://localhost:5173`。

### 首次配置

1. 页面会提示"未配置 API"，点击右上角徽章或"立即配置"按钮
2. 在弹窗中填入 DeepSeek API Key（从 https://platform.deepseek.com 获取）
3. 点击"保存并应用"，配置写入后端 SQLite 数据库
4. 即可开始对话

## 项目结构

```
ai-chat/
├── frontend/                   # 前端（Vite + React）
│   ├── src/                    # 前端源码
│   │   ├── client.ts           # 后端 API 调用层
│   │   ├── apiConfig.ts        # 供应商预设 & 表单校验
│   │   ├── types.ts            # TypeScript 类型定义
│   │   ├── App.tsx             # 根组件（状态管理）
│   │   └── components/
│   │       ├── ChatInterface.tsx    # 聊天主界面
│   │       └── ApiConfigModal.tsx   # API 配置弹窗
│   ├── dist/                   # 构建产物（npm run build:frontend）
│   ├── vite.config.ts          # /api proxy → :3001
│   └── package.json
├── functions/                  # 后端云函数目录
│   └── api/                    # 接口云函数（函数名：api，type: HTTP）
│       ├── src/
│       │   ├── main.ts         # 启动入口（本地 :3001）
│       │   ├── app.module.ts   # 根模块（TypeORM 配置）
│       │   ├── config/         # API 配置 CRUD
│       │   ├── conversations/  # 对话 & 消息实体/服务
│       │   └── chat/           # SSE 代理转发大模型
│       ├── dist/               # 构建产物，云函数实际执行的代码
│       ├── data/               # SQLite 数据库文件（仅本地，自动创建）
│       ├── scf_bootstrap       # HTTP 云函数启动入口（LF，监听 9000）
│       └── package.json
├── cloudbaserc.json            # CloudBase 部署配置（functionRoot: ./functions）
├── package.json                # 仓库根编排脚本（install:all / dev / build）
└── AGENTS.md                   # AI 辅助开发指令
```

> 关于入口文件：CloudBase 官方示例常用 `functions/api/index.js`（事件函数）。本项目需要 SSE 逐字流式输出，事件函数无法流式回包，因此 `api` 声明为 `type: HTTP` 自定义运行时，入口改为 `scf_bootstrap`（导出 `PORT=9000` 后执行 `node dist/main`）。

## 数据流

```
浏览器 (localhost:5173)
  │
  ├─ GET/POST /api/config         → NestJS (:3001) → SQLite
  ├─ GET/POST /api/conversations  → NestJS (:3001) → SQLite
  └─ POST /api/chat (SSE)         → NestJS (:3001)
                                      ├─ 存 user message → SQLite
                                      ├─ 读取历史 + 注入 system prompt
                                      ├─ fetch → DeepSeek API
                                      ├─ SSE 透传 chunk → 浏览器
                                      └─ 存 assistant message → SQLite
```

## 构建生产包

```bash
# 前后端一起构建
npm run build

# 或单独构建
npm run build:frontend   # → frontend/dist
npm run build:api        # → functions/api/dist
```

## 云端部署（腾讯云 CloudBase）

架构：前端静态托管 + 后端 HTTP 云函数，同域路径转发（`/api` → 云函数），前端零改动。

### 前置条件

- `npm i -g @cloudbase/cli` 并执行 `tcb login`
- 开通 CloudBase 环境；自定义域名需 ICP 备案（约 7–20 天），默认域名有限流仅适合验证
- 准备 PostgreSQL：可用环境内置 PostgreSQL，或创建 TencentDB for PostgreSQL；云函数访问数据库需开启 VPC，与数据库同 VPC/子网

### 部署配置

1. 仓库根创建 `.env.local`（已被 .gitignore 忽略），写入：
   ```bash
   DB_PASSWORD=<数据库密码>
   ENCRYPTION_KEY=<主密钥，用于加密落库的 API Key>
   ```
2. `cloudbaserc.json` 已按 v2.1 schema 填好 `envId`、`functionRoot: "./functions"` 与 `vpc` 段；函数不写 `dir`，由 `functionRoot/name` 推导为 `functions/api`（v2.1 中 `dir` 是相对项目根目录而非 functionRoot）；若改用其他环境或子网，同步修改这几处，并将 `DB_HOST`、`DB_USERNAME` 替换为实际的 PostgreSQL 内网连接信息
   - `{{env.DB_PASSWORD}}` 由 CLI 部署时从根目录 `.env.local` 插值
3. 云函数默认 5 秒超时会砍断 SSE，配置中已设为 300 秒；注意一次 SSE 连接占用一个函数实例

### 部署命令

```bash
npm run build                              # 必须先构建：ignore 排除了 src，包内需要 dist/
tcb fn deploy api                          # 部署 HTTP 云函数（读 cloudbaserc.json，scf_bootstrap 监听 9000）
tcb hosting deploy frontend/dist -e <envId>  # 前端产物上传到静态托管根路径
```

### 控制台关键配置

- 静态托管：错误页面设为 `index.html`（SPA 回退，深链接刷新不 404）；`index.html` 缓存约 1 小时、带 hash 的 CSS/JS 约 7 天
- 触发路径：`/api` 指向云函数并开启路径透传（后端路由自带 `/api` 前缀，不能被剥掉）
- 云函数环境变量：`CORS_ORIGINS` 填前端域名（留空视为同源）

### 上线验收

- `GET /api/health` 返回 `database: up` 且 `encryption: enabled`（若为 `disabled` 说明 ENCRYPTION_KEY 注入失败，保存 API Key 会返回 400）
- 任意页面深链接按 F5 不 404；一轮对话完整流式输出不断流

## 开发说明

- 后端使用 `nest start --watch` 热重载，修改 functions/api/src 下文件自动重启
- 前端 Vite HMR 即时更新；修改 `frontend/vite.config.ts` 需重启前端
- SQLite 数据库文件位于 `functions/api/data/app.db`，首次启动自动创建表结构（synchronize: true）
- API Key 脱敏返回（`apiKeyMasked`），明文仅存后端
