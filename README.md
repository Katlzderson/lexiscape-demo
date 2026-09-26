# 辞之境 · Lexiscape

**在线体验：[辞之境 · Lexiscape](https://lexiscape-demo-production.up.railway.app/)**

Lexiscape 是一个场景驱动的一词多义学习 Demo。用户提交一组英语单词或固定短语后，系统会在运行时获取常用义项，将它们编入同一篇英文故事，并通过独立语义校验确认每一次词语出现的实际含义。用户还可以在新情境中完成英文造句并获得分项反馈。

项目不包含内置词表、预置故事、练习题或任何可用的模型凭据。没有可用的数据或模型服务时，系统会明确提示失败，不使用静态内容冒充生成结果。

## 功能

- 3–20 个精确英语单词或固定短语批量输入
- 常用义项运行时获取与冷僻义过滤
- 故事规划、初稿与三轮定向文段升级
- 最终词形位置由程序重建，不采信模型生成的字符坐标
- 单一连贯故事中的多词、多义项学习
- 按出现位置独立复核并纠正词义标注
- 已出现与未覆盖义项对照
- 新情境英文造句与题目要求、词义、语法、自然度反馈
- 本地学习历史、语境轨迹、进度导出与重置

## 本地启动

要求 Node.js 20 或更高版本。用户在页面中提供自己的模型 API Key，部署者无需配置或承担模型额度。

```powershell
git clone https://github.com/Katlzderson/lexiscape-demo.git
cd lexiscape-demo
npm install
npm run build
npm start
```

访问 <http://localhost:4173>，在弹窗中选择供应商并填写模型名称和 API Key。

`.env` 已被 Git 忽略，但不再用于保存模型凭据。请勿将真实密钥写入源码、环境变量、README、Issue 或提交记录。

## 接入自己的模型

页面当前支持以下 OpenAI-compatible 供应商：

- DeepSeek
- OpenAI
- OpenRouter
- 硅基流动
- Moonshot
- 智谱 AI
- 通义千问

用户只需在页面中填写：

1. 模型供应商
2. 供应商控制台提供的模型名称
3. API Key

供应商 API 地址由服务端白名单确定，用户不能填写任意 URL，以防止服务器端请求伪造。模型接口需要支持 Bearer Token、OpenAI-compatible Chat Completions 和 JSON object 输出。

建议先执行一次小词批生成，确认模型能够稳定返回 JSON，再开放公网访问。不同模型的指令遵循和结构化输出能力会直接影响词义标注与练习质量。

## 生成流程

系统先获取并归并每个精确词条的常用义项，再让模型规划一条可容纳这些义项的单一故事主线。模型随后生成初稿，并连续进行三轮只返回完整正文的定向升级；每轮都会重新收到完整词义清单，不输出审查意见或字符坐标。最终正文完成后，程序确定性重建全部词形位置，再并行执行一次语义分类和篇章语言校验。

公共 `dictionaryapi.dev` 适配器仍保留在代码中，但默认不启用。该服务只能提供英文原始释义，仍需模型完成中文释义、常用义归并和搭配结构化；在部署环境中出现 522 时只会增加等待时间。当前默认直接使用用户选择的模型获取义项。

## API Key 安全边界

- API Key 只保存在当前页面的 JavaScript 内存变量中。
- Key 不写入 `localStorage`、`sessionStorage`、Cookie、学习记录、导出文件或服务器数据库。
- 保存配置后密码输入框会立即清空；刷新或关闭页面后必须重新填写。
- 每次模型请求会临时携带 Key，服务端通过请求级异步上下文使用，请求完成后不再保留引用。
- 不同供应商和模型的义项缓存互相隔离，用户之间不会共享凭据上下文。
- 服务端不安装请求日志中间件，错误响应也不会回显上游响应正文或 Key。
- 页面运行的图标脚本由本站提供，内容安全策略禁止第三方 JavaScript。

由于模型调用由 Lexiscape 服务端代理，Key 在调用期间仍会短暂经过服务端内存。部署者不能宣称“服务器从未接触 Key”。用户应只在可信的 HTTPS 部署中使用，并为 Demo 创建具有额度限制、可随时撤销的专用 Key。

如需增加供应商，应在 [src/llm.ts](src/llm.ts) 的注册表中加入固定 HTTPS 端点；不要开放任意 URL 输入。

## 常用命令

```powershell
npm run dev    # 本地监听模式
npm run build  # 编译生产版本到 dist
npm run check  # TypeScript 类型检查
npm test       # 单元测试
```

## 数据与隐私

- 学习历史保存在当前浏览器的 `localStorage` 中，没有账号或云同步。
- 模型供应商、模型名称和 API Key 不属于学习状态，不会持久化或导出。
- 用户提交的词条和造句会发送到用户选择的模型服务。
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

本项目允许用户无需账号直接使用。虽然模型费用由用户自己的 Key 承担，公开部署前仍应增加 IP 限流和并发限制，防止无效请求占用服务器资源。

## Railway 部署

当前生产环境部署在 Railway：

- 访问地址：[https://lexiscape-demo-production.up.railway.app/](https://lexiscape-demo-production.up.railway.app/)
- 部署分支：`main`
- 构建命令：`npm run build`
- 启动命令：`npm start`
- 服务端监听 Railway 提供的 `PORT` 环境变量

Railway 服务已连接本 GitHub 仓库。代码推送到 `main` 后，Railway 会自动拉取最新提交、重新构建并发布。可在 Railway 项目的 `Deployments` 页面核对当前部署提交和构建日志。

Railway 无需配置任何模型 API Key。模型凭据由每位用户在页面中临时填写，不应添加到 Railway Variables、源码或提交记录中。