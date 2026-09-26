# 辞之境 · Lexiscape

Lexiscape 是一个场景驱动的一词多义学习 Demo。用户提交一组英语单词或固定短语后，系统会在运行时获取常用义项，将它们编入同一篇英文故事，并通过独立语义校验确认每一次词语出现的实际含义。用户还可以在新情境中完成英文造句并获得分项反馈。

项目不包含内置词表、预置故事、练习题或任何可用的模型凭据。没有可用的数据或模型服务时，系统会明确提示失败，不使用静态内容冒充生成结果。

## 功能

- 3–20 个精确英语单词或固定短语批量输入
- 常用义项运行时获取与冷僻义过滤
- 单一连贯故事中的多词、多义项学习
- 按出现位置独立复核并纠正词义标注
- 已出现与未覆盖义项对照
- 新情境英文造句与题目要求、词义、语法、自然度反馈
- 本地学习历史、语境轨迹、进度导出与重置

## 本地启动

要求 Node.js 20 或更高版本，以及一个支持 OpenAI-compatible Chat Completions 接口的模型服务。

```powershell
git clone https://github.com/Katlzderson/lexiscape-demo.git
cd lexiscape-demo
npm install
Copy-Item .env.example .env
```

编辑 `.env`，填写自己的模型配置：

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_MODEL=your-model-name
LLM_API_KEY=your-api-key
LLM_MAX_TOKENS=16384
LLM_THINKING=false
PORT=4173
```

然后启动：

```powershell
npm start
```

访问 <http://localhost:4173>。

`.env` 已被 Git 忽略。请勿将真实密钥写入源码、`.env.example`、README、Issue、提交记录或前端代码。

## 接入自己的模型

模型服务必须提供：

- `POST {LLM_BASE_URL}/chat/completions`
- Bearer Token 鉴权
- OpenAI-compatible 的 `messages` 请求与 `choices[0].message.content` 响应
- `response_format: { "type": "json_object" }`，并能稳定返回严格 JSON
- 足够的上下文和输出长度，以处理场景生成及批量语义校验

环境变量说明：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `LLM_BASE_URL` | 是 | API 根地址，不包含 `/chat/completions` |
| `LLM_MODEL` | 是 | 服务商提供的模型标识 |
| `LLM_API_KEY` | 是 | 仅由 Node 服务读取的访问密钥 |
| `LLM_MAX_TOKENS` | 否 | 最大输出 token，默认 `16384` |
| `LLM_THINKING` | 否 | 是否请求 thinking 模式，默认 `false` |
| `SENSITIVE_WORDS_URL` | 否 | 返回字符串数组或 `{ "words": [] }` 的运行时词表地址 |
| `PORT` | 否 | Web 服务端口，默认 `4173` |

如果服务商不接受 `thinking` 字段，可保持 `LLM_THINKING=false`；若其接口仍拒绝未知字段，需要在 [src/llm.ts](src/llm.ts) 中按服务商文档移除或转换该字段。

建议先执行一次小词批生成，确认模型能够稳定返回 JSON，再开放公网访问。不同模型的指令遵循和结构化输出能力会直接影响词义标注与练习质量。

## 常用命令

```powershell
npm run dev    # 本地监听模式
npm run check  # TypeScript 类型检查
npm test       # 单元测试
```

## 数据与隐私

- 学习历史保存在当前浏览器的 `localStorage` 中，没有账号或云同步。
- 用户提交的词条和造句会发送到部署者配置的模型服务。
- 服务端不会通过状态接口返回模型名、端点或密钥。
- 公开部署时应额外配置限流、人机验证、调用预算和 HTTPS。

## 项目结构

- [src/core.ts](src/core.ts)：输入规范化、容量与确定性位置校验
- [src/providers.ts](src/providers.ts)：词条验证与义项提供方
- [src/pipeline.ts](src/pipeline.ts)：生成、语义复核、篇章审校与练习
- [src/server.ts](src/server.ts)：Web 服务和 API
- [public](public)：浏览器界面与本地状态
- [prompts](prompts)：外置 Prompt 模板
- [tests](tests)：核心逻辑测试

## 发布提醒

本项目允许用户无需账号直接使用，因此公开部署前至少应增加 IP 限流、并发限制和每日调用预算，防止模型额度被滥用。部署平台中的环境变量应设为私密变量，不能提交到 GitHub。