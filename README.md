# 湖北技能高考 · 计算机类错题工作台

面向 **中职技能高考（计算机类）** 的师生两端练习系统，按 **湖北省 2026 年考纲** 搭建知识点体系。教师拍照或导入 PDF 试卷即可生成题库，一键按知识点组卷、打印、发链接给学生答题，提交后自动判分并汇总班级错题；操作题由教师人工批改，学生可在本机保留自己的错题本。内置**知识点依赖图谱**，可按学生作答沿前置关系回溯错因根源，而不只是统计"错了哪些题"。

零框架、零运行时依赖，只用 Node.js 内置模块，数据以 JSON 文件保存，适合在一台教师电脑或校内服务器上直接跑。

## 功能

**教师端**

- 题库管理：增删改查，按模块 / 题型 / 关键词筛选，支持按知识点筛选
- 批量录入
  - 图片：拍照或截图，走 DeepSeek 视觉识别
  - PDF：有文字层直接抽取文本；扫描件自动取页面图像走视觉识别，多页并发，单次最多 10 页
  - 文本：直接粘贴试卷文字
  - 识别结果先进入「预览」列表，人工确认后再入库，题干自动去掉原题号
- 组卷：按模块、知识点、题型数量抽题，生成练习卷快照；抽题按知识点轮转分配，一份卷内各知识点均匀覆盖，不会连续抽到同一个点
- 打印：服务端输出 A4 自包含 HTML，可直接「另存为 PDF」，含答案版与不含答案版
- 作业分发：生成学生链接与二维码，同一局域网内手机扫码即可作答
- 统计：提交人数、平均正确率、待批改数量、逐题错误率排行、提交明细
- 批改：点开任一答卷，对操作题给出 **正确 / 部分正确 / 错误** 与评语，正确率实时重算
- 知识图谱：62 个知识点按 9 个模块排布，65 条前置依赖边（模块内实线、跨模块虚线），点击节点查看直接前置 / 后继与依赖强度
- 错因诊断：按学生历史答卷算出每个知识点的掌握度，再沿依赖边**向上回溯**，指出"5.4 常用函数的薄弱其实源于 5.3 公式与引用只掌握了一半"；对于没有作答记录的上游知识点，明确提示"该点缺数据，建议补测"而不是猜
- AI 补全解析：为没有解析的题批量生成解题思路（会指出参考答案可能存在的问题）

**学生端**

- 手机优先的答题页，无需注册，填写姓名 / 班级即可开始
- 单选、判断、操作三类题型；底部实时显示已答进度
- 提交后立即出分：客观题自动判分，操作题标记待批改
- 结果页逐题展示对错、正确答案、解析、教师评语
- 我的错题本：本机记录最近 50 次作答，只列错题与部分正确题，可回看解析

## 技术栈

- Node.js 20+（使用全局 `fetch`、`AbortSignal.timeout`）
- 原生 `node:http` 服务，无 Express、无构建步骤
- 前端原生 HTML / CSS / JS，无框架
- 数据：`data/*.json`，写入采用「临时文件 + rename」的原子落盘
- AI：DeepSeek Chat Completions（文本解析、视觉识别、解析生成）

## 快速开始

```bash
git clone https://github.com/<your-name>/hubei-cs-exam-coach.git
cd hubei-cs-exam-coach
npm start
```

打开 <http://localhost:3100> 即为教师端。

首次启动时 `data/questions.json`、`data/papers.json`、`data/submissions.json` 不存在会自动创建，不需要手动准备。

题库已内置 **330 道题**（62 个知识点 × 5 题，覆盖全部 9 个模块），随仓库以 `data/questions.seed.json` 分发：若本机没有 `data/questions.json`，首次启动会从种子文件导入，之后读写的一直是本机文件，升级代码不会覆盖你的题库。

## 配置 DeepSeek Key

AI 相关的三个功能（图片/PDF 识别、文本批量解析、补全解析）需要 DeepSeek API Key，其余功能不依赖 AI。

**方式一：环境变量（推荐）**

```powershell
# PowerShell
$env:DEEPSEEK_KEY="sk-你的key"
npm start
```

```bash
# macOS / Linux
export DEEPSEEK_KEY="sk-你的key"
npm start
```

**方式二：项目根目录配置文件**

```bash
cp config.example.json config.json
```

然后把 `config.json` 里的占位值换成自己的 Key：

```json
{
  "deepseekKey": "sk-你的key"
}
```

**方式三：上级目录配置文件**

`config.json` 也可以放在项目上一级目录，服务会自动向上找一层。适合“同一台机器多个小工具共用一个 Key”。

Key 的读取顺序为 `DEEPSEEK_KEY` 环境变量 → `./config.json` → `../config.json`。

> `config.json` 已写入 `.gitignore`，不会被提交。请不要把 Key 直接写进源码或提交到仓库。
> 获取 Key：<https://platform.deepseek.com/api_keys>

## 使用流程

1. **建题库**：顶栏「AI 批量导入」→ 选择图片 / PDF / 粘贴文本 → 核对预览 → 全部入库
2. **出卷**：顶栏「生成练习卷」→ 选模块、知识点、各题型数量 → 生成
3. **打印**：卷子卡片里点「打印试卷」或「打印含答案」，浏览器里 `Ctrl+P` 另存为 PDF
4. **发作业**：复制学生链接，或让学生扫二维码
5. **看结果**：左侧「已生成练习卷」点卷名 → 看统计、错题排行、提交明细
6. **批改**：统计表格里点某个学生 → 给操作题打「正确 / 部分正确 / 错误」+ 评语 → 保存
7. **补解析**：顶栏「补全解析」，为没有解析的题批量生成讲解
8. **看诊断**：顶栏「知识图谱」→「错因诊断」→ 输入学生姓名（可留空看全班）→ 看薄弱知识点、根源知识点与待补测点

## 局域网使用（学生手机作答）

服务默认监听 `0.0.0.0`，启动时会打印内网地址，例如：

```
教师端 → http://localhost:3100
局域网 → http://192.168.1.7:3100（手机连同一个 WiFi 即可打开）
```

学生链接与二维码会自动使用这个内网地址。

如果手机打不开：

1. 确认手机和电脑连的是同一个 WiFi / 局域网
2. Windows 首次运行 Node 时会弹防火墙提示，需要允许 **专用网络** 访问
3. 手动放行端口（管理员 PowerShell）：
   ```powershell
   New-NetFirewallRule -DisplayName "ExamCoach 3100" -Direction Inbound -LocalPort 3100 -Protocol TCP -Action Allow
   ```
4. 学校网络若开启了「AP 隔离 / 客户端隔离」，设备之间无法互访，需要联系网络管理员

> 本系统没有登录与权限控制，请只在可信的局域网内使用，不要把端口直接映射到公网。

## 数据与备份

| 文件 | 内容 |
| --- | --- |
| `data/knowledge.json` | 考纲知识点树（随仓库提供） |
| `data/graph.json` | 知识点前置依赖边与强度（随仓库提供） |
| `data/questions.seed.json` | 种子题库 330 题（随仓库提供，仅首次启动时导入） |
| `data/questions.json` | 题库（本机数据） |
| `data/papers.json` | 练习卷快照 |
| `data/submissions.json` | 答卷与批改结果 |

- 直接复制整个 `data/` 目录即可完成备份；换机器时把 `data/` 放回项目根目录就能继续用。
- 练习卷是**快照**：出卷后修改题库不会影响已生成的卷子。
- 删除练习卷会级联删除该卷的答卷，删除前请确认统计已经导出或截图。
- 答卷最多保留 5000 条。

## 目录结构

```
hubei-cs-exam-coach/
├─ server.js            # HTTP 服务、路由、判分、出卷与打印、AI 调用
├─ pdf-extract.js       # 零依赖 PDF 解析：文字层抽取 + 扫描页图像提取（按页序）
├─ package.json
├─ config.example.json  # Key 配置模板
├─ data/
│  ├─ knowledge.json    # 湖北 2026 考纲：9 个模块、62 个知识点、分值
│  ├─ graph.json        # 知识点前置依赖边：65 条，带强度与理由
│  └─ questions.seed.json # 种子题库 330 题，首次启动导入为 questions.json
└─ public/
   ├─ index.html        # 教师端
   ├─ app.js
   ├─ style.css
   ├─ graph.html        # 知识图谱 / 错因诊断
   ├─ graph.js
   ├─ student.html      # 学生答题页
   ├─ student.js
   ├─ student.css
   ├─ wrong.html        # 学生错题本
   └─ qrcode.js         # 二维码生成（本地引入，不依赖外网）
```

## 数据模型

```jsonc
// 题目
{
  "id": "q_xxx",
  "module": 5,                 // 1–9，对应考纲模块
  "type": "single",            // single | judge | operation
  "stem": "题干（不含题号）",
  "options": [{ "key": "A", "text": "选项内容" }],
  "answer": "B",               // 判断题用「对 / 错」
  "analysis": "解析，可为空",
  "points": ["5.4"],           // 知识点编号
  "difficulty": 3,             // 1–5
  "source": "AI 生成（待教师校对）", // 来源标记，便于筛出待复核的题
  "tags": ["常用函数"],
  "wrongReasons": ["参数错误"], // 八类错因标签，供诊断聚合
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/knowledge` | 考纲知识点树 |
| GET | `/api/stats` | 题库总量、按模块 / 题型统计 |
| GET | `/api/network` | 局域网地址与端口 |
| GET | `/api/questions` | 题目列表（分页、模块、题型、关键词、知识点） |
| POST | `/api/questions` | 新增题目 |
| PUT / DELETE | `/api/questions/:id` | 修改 / 删除题目 |
| POST | `/api/questions/bulk` | 批量入库 |
| POST | `/api/questions/:id/explain` | 生成单题解析 |
| GET | `/api/questions/missing-analysis` | 缺少解析的题目 |
| POST | `/api/parse` | 文本解析成草稿 |
| POST | `/api/parse/file` | 图片 / PDF 解析成草稿 |
| GET | `/api/papers` | 练习卷列表 |
| POST | `/api/papers` | 按条件出卷 |
| DELETE | `/api/papers/:id` | 删除练习卷（级联删除答卷） |
| GET | `/api/papers/:id/print?answers=1` | 打印页（含答案） |
| GET | `/api/papers/:id/stats` | 答卷统计与错题排行 |
| GET | `/api/papers/:id/submissions/:sid` | 单份答卷明细 |
| POST | `/api/papers/:id/submissions/:sid/grade` | 操作题批改 |
| GET | `/api/quiz/:id` | 学生取卷（不含答案） |
| POST | `/api/quiz/:id/submit` | 提交答卷并判分 |
| GET | `/api/graph` | 知识点节点 + 依赖边（供图谱渲染） |
| GET | `/api/diagnose?name=&className=` | 错因诊断：掌握度、根源知识点、待补测点 |

页面路由：`/` 教师端，`/s/:paperId` 学生答题页，`/wrong` 我的错题本。

## 考纲覆盖

按湖北省 2026 年技能高考计算机类考试大纲整理，共 **9 个模块、490 分、120 分钟**，涵盖计算机基础、Windows 10 操作系统、WPS 办公软件、MySQL 数据库、C 语言（C99）、Photoshop CS6 等。知识点见 `data/knowledge.json`，可按实际教学进度自行增删。

内置题库按 **每个知识点 5 题** 生成（模块 1 为单选，模块 2–9 为操作题），逐题带知识点编号、难度、答案要点、解析与错因标签。这些题目由 AI 批量生成，`source` 字段统一标记为「AI 生成（待教师校对）」——**正式发给学生前请抽样人工复核**，尤其是操作题的答案步骤与 SQL / C 代码。教师端可按该标记筛出待复核题目。

知识点依赖边（`data/graph.json`）同样需要教学一线校验：边写错会导致诊断把根源指错方向。修改后无需重启逻辑，刷新图谱页即可生效。

题目内容与解析由使用者自行录入或由 AI 生成，**AI 生成内容需要人工复核**，请勿直接当作标准答案发放。

## 常见问题

**Q：没有 DeepSeek Key 能用吗？**
能。题库 CRUD、手动出卷、打印、答题、判分、统计、批改全部不依赖 AI，只是无法使用图片/PDF 识别和补解析。

**Q：扫描版 PDF 只能识别前几页？**
单次最多 10 页，按页序识别并跨页去重。页数更多时建议拆成多个文件分批导入。

**Q：识别结果不准怎么办？**
识别结果只进入预览，不会直接入库。可以先入库，再点题目编辑修正；手写体、阴影、倾斜的拍照件识别率会明显下降，建议正面拍摄、光线均匀。

**Q：学生换手机后错题本空了？**
错题本保存在学生浏览器本地（localStorage），换设备或清理浏览器数据后不会同步。教师端的答卷数据不受影响。

**Q：端口被占用？**
用环境变量换端口：`PORT=3200 npm start`（PowerShell：`$env:PORT=3200; npm start`）。

## 免责声明

本项目为教学辅助工具，题目、解析与判分规则由使用者维护；AI 生成内容可能存在错误，正式考试请以官方考纲与教材为准。

## 第三方资源

- [`public/qrcode.js`](./public/qrcode.js) —— QR Code Generator for JavaScript，作者 Kazuhiko Arase，MIT License，已保留原始版权声明，用于本地生成学生答题二维码（不依赖外部服务）。

## License

[MIT](./LICENSE)
