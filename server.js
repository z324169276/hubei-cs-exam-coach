import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdf } from './pdf-extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'questions.json');
const SEED_FILE = path.join(DATA_DIR, 'questions.seed.json');
const PAPER_FILE = path.join(DATA_DIR, 'papers.json');
const SUBMISSION_FILE = path.join(DATA_DIR, 'submissions.json');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
const GRAPH_FILE = path.join(DATA_DIR, 'graph.json');
const PORT = Number(process.env.PORT) || 3100;

/** 局域网 IPv4：跳过虚拟机、容器等虚拟网卡，返回网卡名方便前端挑主网卡 */
const VIRTUAL_ADAPTER = /(vmware|virtualbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tap|tun)/i;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const TYPES = new Set(['single', 'judge', 'operation']);
const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
const MODULE_IDS = new Set(knowledge.modules.map((m) => m.id));
const POINT_IDS = new Set(knowledge.modules.flatMap((m) => m.points.map((p) => p.id)));

/** 知识点依赖图：读不到或损坏时退化成空边集，保证服务与诊断接口仍可用 */
let graph = { version: 1, updatedAt: null, edges: [] };
if (fs.existsSync(GRAPH_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    if (Array.isArray(parsed.edges)) graph = parsed;
  } catch (err) {
    console.warn('[store] 知识图谱文件损坏，已忽略:', err.message);
  }
}

let db = { version: 1, items: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.items)) db.items = [];
  } catch (err) {
    console.warn('[store] 题库文件损坏，已重置:', err.message);
  }
} else if (fs.existsSync(SEED_FILE)) {
  // 首次运行：用随仓库分发的种子题库初始化，之后读写的是本机 questions.json
  try {
    db = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    if (!Array.isArray(db.items)) db.items = [];
    console.log(`[store] 已从种子题库导入 ${db.items.length} 道题`);
  } catch (err) {
    console.warn('[store] 种子题库读取失败:', err.message);
    db = { version: 1, items: [] };
  }
}

function persist() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

let papers = { version: 1, items: [] };
if (fs.existsSync(PAPER_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
    if (Array.isArray(parsed.items)) papers = parsed;
  } catch (err) {
    console.warn('[store] 练习卷文件损坏，已重置:', err.message);
  }
}

function persistPapers() {
  const tmp = `${PAPER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(papers, null, 2), 'utf8');
  fs.renameSync(tmp, PAPER_FILE);
}

let submissions = { version: 1, items: [] };
if (fs.existsSync(SUBMISSION_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUBMISSION_FILE, 'utf8'));
    if (Array.isArray(parsed.items)) submissions = parsed;
  } catch (err) {
    console.warn('[store] 答卷文件损坏，已重置:', err.message);
  }
}

function persistSubmissions() {
  const tmp = `${SUBMISSION_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(submissions, null, 2), 'utf8');
  fs.renameSync(tmp, SUBMISSION_FILE);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function serveFile(res, rel) {
  const filePath = path.join(PUBLIC_DIR, rel);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function newId() {
  return 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** 统一清洗前端或 AI 传来的题目结构，避免脏数据入库 */
function normalize(input, existing = null) {
  const moduleId = Number(input.module);
  if (!MODULE_IDS.has(moduleId)) throw badRequest('知识模块必须是 1–9');

  const type = TYPES.has(input.type) ? input.type : 'single';
  const stem = String(input.stem || '').trim();
  if (!stem) throw badRequest('题干不能为空');

  let options = Array.isArray(input.options) ? input.options : [];
  options = options
    .map((o) => ({ key: String(o.key || '').trim().slice(0, 2), text: String(o.text || '').trim() }))
    .filter((o) => o.key && o.text);

  if (type === 'single' && options.length < 2) throw badRequest('选择题至少需要 2 个选项');

  const points = (Array.isArray(input.points) ? input.points : [])
    .map((p) => (String(p).match(/\d+\.\d+/) || [''])[0])
    .filter((p) => POINT_IDS.has(p));

  const now = Date.now();
  return {
    id: existing?.id || newId(),
    module: moduleId,
    type,
    stem,
    options: type === 'single' ? options : [],
    answer: String(input.answer || '').trim(),
    analysis: String(input.analysis || '').trim(),
    points,
    difficulty: Math.min(Math.max(Number(input.difficulty) || 3, 1), 5),
    source: String(input.source || '').trim(),
    tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8),
    wrongReasons: (Array.isArray(input.wrongReasons) ? input.wrongReasons : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 6),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function queryQuestions({ module, type, q, point, page = 1, pageSize = 20 }) {
  let items = db.items.slice();

  if (module) items = items.filter((it) => it.module === Number(module));
  if (type) items = items.filter((it) => it.type === type);
  if (point) items = items.filter((it) => (it.points || []).includes(point));
  if (q) {
    const needle = String(q).trim().toLowerCase();
    items = items.filter(
      (it) =>
        it.stem.toLowerCase().includes(needle) ||
        (it.analysis || '').toLowerCase().includes(needle) ||
        (it.source || '').toLowerCase().includes(needle),
    );
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const total = items.length;
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const offset = (current - 1) * size;

  return { items: items.slice(offset, offset + size), total, page: current, pageSize: size };
}

function stats() {
  const byModule = knowledge.modules.map((m) => ({
    id: m.id,
    name: m.name,
    score: m.score,
    count: db.items.filter((it) => it.module === m.id).length,
  }));
  const byType = { single: 0, judge: 0, operation: 0 };
  for (const it of db.items) byType[it.type] = (byType[it.type] || 0) + 1;
  return { total: db.items.length, byModule, byType };
}

function loadDeepSeekKey() {
  if (process.env.DEEPSEEK_KEY) return process.env.DEEPSEEK_KEY;
  for (const file of [path.join(__dirname, 'config.json'), path.join(__dirname, '..', 'config.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg.deepseekKey) return cfg.deepseekKey;
    } catch {
      /* 忽略不存在的配置文件 */
    }
  }
  return null;
}

const POINT_CATALOG = knowledge.modules
  .map((m) => `模块${m.id} ${m.name}：` + m.points.map((p) => `${p.id} ${p.name}`).join('；'))
  .join('\n');

const PARSE_PROMPT = `你是中职计算机类技能高考的题库整理助手。把老师提供的题目文本拆成结构化 JSON。

考试共 9 个知识模块，module 只能填编号：
1 计算机基础知识（选择题）
2 操作系统的使用（Windows 10）
3 计算机网络应用
4 文字处理（WPS）
5 电子表格处理（WPS）
6 演示文稿制作（WPS）
7 程序设计（C99）
8 数据库应用（MySQL）
9 图像处理（Photoshop CS6）

知识点编号表（points 只能从这里选，可多选）：
${POINT_CATALOG}

输出格式：
{"questions":[{"module":1,"type":"single|judge|operation","stem":"题干","options":[{"key":"A","text":"..."}],"answer":"A","analysis":"解析","points":["1.2"],"difficulty":3,"source":"来源","wrongReasons":["概念混淆"]}]}

要求：
- 只输出 JSON，不要解释。
- type：选择题填 single，判断题填 judge，操作题填 operation。
- 判断题的 answer 填“对”或“错”，options 留空。
- 操作题的 answer 写关键操作步骤，可用“1. ... 2. ...”分行。
- points 用模块下的知识点编号，例如“1.2”“7.4”；不确定就留空数组。
- 题干不要带题号，去掉“1.”“第3题”“(2)”这类编号，系统会自动编号。
- 保留原始数字、公式和代码，不要改写题干。
- 拆不出答案或解析就留空字符串，不要编造。`;

async function callDeepSeek(messages, temperature = 0.1) {
  const key = loadDeepSeekKey();
  if (!key) {
    const err = new Error('未配置 DeepSeek Key：请在项目目录放 config.json 并写入 {"deepseekKey":"sk-..."}');
    err.status = 400;
    throw err;
  }

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      response_format: { type: 'json_object' },
      temperature,
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) throw new Error(`DeepSeek 返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '{}';
}

/** 模型有时会把题号一起识别进题干，入库前去掉开头的编号 */
function stripQuestionNumber(stem) {
  return String(stem || '')
    .trim()
    .replace(/^第\s*\d{1,3}\s*题[\s.．、:：]*/, '')
    .replace(/^[（(]\s*\d{1,3}\s*[)）]\s*/, '')
    .replace(/^\d{1,3}\s*[.．、)）]\s*(?=\D)/, '')
    .trim();
}

/** 把 AI 返回的 JSON 文本清洗成可入库的草稿，逐条容错 */
function toDrafts(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI 返回的不是合法 JSON');
  }

  const list = Array.isArray(parsed.questions) ? parsed.questions : [];
  const drafts = [];
  const skipped = [];

  for (const item of list) {
    try {
      const normalized = normalize({ ...item, stem: stripQuestionNumber(item.stem) });
      delete normalized.id;
      delete normalized.createdAt;
      delete normalized.updatedAt;
      drafts.push(normalized);
    } catch (err) {
      skipped.push({ stem: String(item.stem || '').slice(0, 40), reason: err.message });
    }
  }

  return { drafts, skipped };
}

const EXPLAIN_PROMPT = `你是中职计算机类技能高考的资深教师，正在给学生写错题解析。
要求：
- 120~200 字，中文，直接讲原因，不要客套和重复题干。
- 先说明正确答案为什么对，再点出最容易错的地方。
- 操作题按关键步骤说明，写清菜单路径或快捷键。
- 只输出 JSON：{"analysis":"解析正文"}`;

/** 给单道题生成解析，返回纯文本 */
async function explainQuestion(q) {
  const TYPE_TEXT = { single: '单项选择题', judge: '判断题', operation: '操作题' };
  const lines = [
    `题型：${TYPE_TEXT[q.type] || q.type}`,
    `知识模块：${q.module}`,
    `题干：${q.stem}`,
  ];
  if (Array.isArray(q.options) && q.options.length) {
    lines.push(`选项：${q.options.map((o) => `${o.key}. ${o.text}`).join('；')}`);
  }
  lines.push(`参考答案：${q.answer || '（未填写）'}`);

  const raw = await callDeepSeek(
    [
      { role: 'system', content: EXPLAIN_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
    0.3,
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI 返回的不是合法 JSON');
  }

  const analysis = String(parsed.analysis || '').trim();
  if (!analysis) throw new Error('AI 没有返回解析内容');
  return analysis;
}

async function parseWithAI(text) {
  const raw = await callDeepSeek([
    { role: 'system', content: PARSE_PROMPT },
    { role: 'user', content: text },
  ]);
  return toDrafts(raw);
}

/** 图片/扫描页走视觉接口，prompt 与文本解析保持一致 */
async function parseImageWithAI(base64, mime) {
  const raw = await callDeepSeek([
    { role: 'system', content: PARSE_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是一页试卷的照片或扫描件。请识别其中的题目并按要求输出 JSON。看不清的字词标注为「?」，不要猜测。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    },
  ]);
  return toDrafts(raw);
}

const PDF_MAX_PAGES = 10;
const PDF_CONCURRENCY = 3;

/** 多页扫描件并发识别：按页序合并结果，单页失败不影响其他页 */
async function parsePdfPages(pages) {
  const targets = pages.slice(0, PDF_MAX_PAGES);
  const results = new Array(targets.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const i = cursor;
      cursor += 1;
      try {
        const r = await parseImageWithAI(targets[i].data.toString('base64'), 'image/jpeg');
        results[i] = { ok: true, ...r };
      } catch (err) {
        results[i] = { ok: false, page: targets[i].index, reason: err.message };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PDF_CONCURRENCY, targets.length) }, worker));

  const drafts = [];
  const skipped = [];
  const failed = [];
  const seenStems = new Set();

  for (const r of results) {
    if (!r) continue;
    if (!r.ok) {
      failed.push({ page: r.page, reason: r.reason });
      continue;
    }
    for (const draft of r.drafts) {
      const key = draft.stem.replace(/\s+/g, '');
      if (seenStems.has(key)) continue;
      seenStems.add(key);
      drafts.push(draft);
    }
    skipped.push(...r.skipped);
  }

  return { drafts, skipped, failed, total: pages.length, processed: targets.length };
}

const TYPE_LABEL = { single: '选择题', judge: '判断题', operation: '操作题' };
const TYPE_SECTIONS = [
  { type: 'single', label: '一、选择题' },
  { type: 'judge', label: '二、判断题' },
  { type: 'operation', label: '三、操作题' },
];

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** 按模块/知识点从题库抽题，同一份卷子不重复 */
function pickQuestions({ modules, points, counts }) {
  const pool = db.items.filter((it) => {
    if (modules.length && !modules.includes(it.module)) return false;
    if (points.length && !(it.points || []).some((p) => points.includes(p))) return false;
    return true;
  });

  const picked = [];
  const shortage = [];

  for (const { type } of TYPE_SECTIONS) {
    const want = Number(counts[type]) || 0;
    if (!want) continue;
    const list = pool.filter((it) => it.type === type);
    if (list.length < want) {
      shortage.push(`${TYPE_LABEL[type]}需要 ${want} 道，题库中符合条件的只有 ${list.length} 道`);
    }

    // 按知识点分桶后轮转抽取：每一轮每个知识点最多出 1 题，
    // 避免一份卷子扎堆在同一个知识点上（否则该卷未覆盖的知识点会一直「未测」）。
    const buckets = new Map();
    for (const it of shuffle(list)) {
      const hit = (it.points || []).filter((p) => !points.length || points.includes(p));
      const key = hit[0] || (it.points || [])[0] || '_untagged';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(it);
    }

    const queues = shuffle([...buckets.values()]);
    const chosen = [];
    while (chosen.length < want && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (chosen.length >= want) break;
        if (q.length) chosen.push(q.shift());
      }
    }
    picked.push(...chosen);
  }

  return { picked, shortage };
}

function buildPaperHtml(paper, withAnswers) {
  const d = new Date(paper.createdAt);
  const dateText = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const modules = [...new Set(paper.items.map((it) => it.module))].sort();
  const moduleText = modules
    .map((id) => knowledge.modules.find((m) => m.id === id)?.name)
    .filter(Boolean)
    .join('、');

  let n = 0;
  const sections = TYPE_SECTIONS.map(({ type, label }) => {
    const list = paper.items.filter((it) => it.type === type);
    if (!list.length) return '';

    const body = list
      .map((q) => {
        n += 1;
        const options = (q.options || []).length
          ? `<div class="opts">${q.options.map((o) => `<span>${esc(o.key)}. ${esc(o.text)}</span>`).join('')}</div>`
          : '';
        const blank =
          type === 'operation'
            ? '<div class="space"></div>'
            : type === 'judge'
              ? '<span class="inline-blank">（　　）</span>'
              : '';
        return `<div class="q"><div class="stem">${n}. ${esc(q.stem)}${blank}</div>${options}</div>`;
      })
      .join('');

    return `<h2>${label}（共 ${list.length} 题）</h2>${body}`;
  }).join('');

  const answers = paper.items
    .map((q, i) => {
      const ans = q.answer || '（未填）';
      const isLong = q.type === 'operation' || ans.length > 24;
      return `<div class="a-item"><span class="a-no">${i + 1}.</span><span class="${isLong ? 'a-long' : ''}">${esc(ans)}</span></div>`;
    })
    .join('');

  const answersBlock = withAnswers
    ? `<div class="answers"><h2>参考答案</h2>${answers || '<p>无</p>'}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(paper.title)}${withAnswers ? ' - 含答案' : ''}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "SimSun", "宋体", serif; font-size: 14px; line-height: 1.9; color: #000; }
  .toolbar { text-align: right; padding: 10px 0; font-family: "Microsoft YaHei", sans-serif; font-size: 13px; }
  .toolbar button, .toolbar a { font-size: 13px; padding: 6px 14px; margin-left: 8px; border: 1px solid #333; background: #fff; color: #000; text-decoration: none; border-radius: 4px; cursor: pointer; }
  h1 { font-size: 20px; text-align: center; margin: 6px 0 4px; letter-spacing: 2px; }
  .cn { text-align: center; font-size: 12px; margin: 0 0 12px; color: #333; }
  .meta { display: flex; justify-content: space-between; border-bottom: 1px solid #000; padding-bottom: 6px; font-size: 13px; }
  .note { font-size: 12px; color: #333; margin: 10px 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  .q { margin-bottom: 10px; break-inside: avoid; }
  .stem { white-space: pre-wrap; }
  .opts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; margin-top: 2px; }
  .inline-blank { margin-left: 4px; }
  .space { height: 56px; border-bottom: 1px dashed #999; margin-top: 4px; }
  .answers { page-break-before: always; }
  .a-item { display: flex; gap: 6px; margin-bottom: 6px; break-inside: avoid; }
  .a-no { flex: none; width: 26px; text-align: right; }
  .a-long { white-space: pre-wrap; }
  @media print { .toolbar { display: none; } }
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">打印 / 另存为 PDF</button>
    ${withAnswers ? '<a href="?">只看试卷</a>' : '<a href="?answers=1">查看答案页</a>'}
  </div>
  <h1>${esc(paper.title)}</h1>
  <p class="cn">2026 湖北省技能高考计算机类 · 知识点专项练习 · ${dateText}</p>
  <div class="meta"><span>班级：____________</span><span>姓名：____________</span><span>得分：________</span></div>
  <p class="note">涉及模块：${esc(moduleText || '综合')}　｜　共 ${paper.items.length} 题</p>
  ${sections || '<p>这份卷子没有抽到题目，请先在题库中录入。</p>'}
  ${answersBlock}
</body>
</html>`;
}

/** 判断题统一成“对/错”，选择题统一成大写字母 */
function normalizeJudge(v) {
  const s = String(v ?? '').trim();
  if (/^(对|正确|√|t|true|y|yes)$/i.test(s)) return '对';
  if (/^(错|错误|×|x|f|false|n|no)$/i.test(s)) return '错';
  return s;
}

function normalizeChoice(v) {
  return String(v ?? '').trim().toUpperCase();
}

/** 操作题不自动判分，返回 null 交给老师或学生自查 */
function gradeOne(question, userAnswer) {
  if (question.type === 'operation') return null;
  const user = question.type === 'judge' ? normalizeJudge(userAnswer) : normalizeChoice(userAnswer);
  const right = question.type === 'judge' ? normalizeJudge(question.answer) : normalizeChoice(question.answer);
  if (!user) return false;
  return user === right;
}

/**
 * 汇总一份答卷：客观题自动判分，操作题按人工批改的 score（1 / 0.5 / 0）计入。
 * 正确率 = (客观题答对 + 操作题得分) / (客观题数 + 已批改操作题数)
 */
function summarizeSubmission(sub, paper) {
  let autoTotal = 0;
  let correct = 0;
  let manualTotal = 0;
  let manualScore = 0;
  let pending = 0;

  for (const q of paper.items) {
    const auto = gradeOne(q, sub.answers?.[q.id]);
    if (auto === null) {
      const manual = sub.manual?.[q.id];
      if (manual) {
        manualTotal += 1;
        manualScore += Number(manual.score) || 0;
      } else {
        pending += 1;
      }
      continue;
    }
    autoTotal += 1;
    if (auto) correct += 1;
  }

  const total = autoTotal + manualTotal;
  return {
    autoTotal,
    correct,
    manualTotal,
    manualScore,
    pending,
    rate: total ? Math.round(((correct + manualScore) / total) * 1000) / 10 : 0,
  };
}

/** 逐题展开一份答卷，供教师批改和学生回顾 */
function buildSubmissionDetail(sub, paper) {
  return paper.items.map((q, i) => {
    const your = String(sub.answers?.[q.id] ?? '');
    const auto = gradeOne(q, your);
    const manual = sub.manual?.[q.id] || null;
    return {
      index: i + 1,
      id: q.id,
      type: q.type,
      stem: q.stem,
      options: q.options || [],
      your,
      answer: q.answer || '',
      analysis: q.analysis || '',
      ok: auto,
      score: manual ? manual.score : auto === null ? null : auto ? 1 : 0,
      comment: manual?.comment || '',
    };
  });
}

/** 知识图谱：把 knowledge.json 摊平成节点，边直接透传 graph.json */
function graphPayload() {
  const nodes = knowledge.modules.flatMap((m) =>
    m.points.map((p) => ({ id: p.id, name: p.name, module: m.id, moduleName: m.name, type: m.type })),
  );
  const modules = knowledge.modules.map((m) => ({
    id: m.id,
    name: m.name,
    count: m.count,
    score: m.score,
    pointCount: m.points.length,
  }));
  return { nodes, edges: graph.edges, modules };
}

function masteryLevel(attempts, mastery) {
  if (!attempts) return '未测';
  if (mastery >= 0.8) return '掌握';
  if (mastery >= 0.6) return '待巩固';
  return '薄弱';
}

/**
 * 按知识点聚合历史答卷，并对薄弱点回溯上游根因。
 * 操作题只算老师批改过（manual.score）的，没批改就跳过、不计入分母。
 */
function diagnose({ name, className, paperId }) {
  const trim = (v) => String(v || '').trim();
  const scope = { name: trim(name), className: trim(className), paperId: trim(paperId) };

  let subs = submissions.items.slice();
  if (scope.name) subs = subs.filter((s) => s.name === scope.name);
  if (scope.className) subs = subs.filter((s) => s.className === scope.className);
  if (scope.paperId) subs = subs.filter((s) => s.paperId === scope.paperId);

  const cellMap = new Map();
  for (const m of knowledge.modules) {
    for (const p of m.points) {
      cellMap.set(p.id, {
        id: p.id,
        name: p.name,
        module: m.id,
        moduleName: m.name,
        attempts: 0,
        score: 0,
      });
    }
  }

  const paperMap = new Map(papers.items.map((p) => [p.id, p]));
  let submissionCount = 0;

  for (const sub of subs) {
    const paper = paperMap.get(sub.paperId);
    if (!paper) continue;
    submissionCount += 1;

    for (const q of paper.items) {
      let value;
      if (q.type === 'operation') {
        const manual = sub.manual?.[q.id];
        if (!manual) continue;
        value = Number(manual.score) || 0;
      } else {
        value = gradeOne(q, sub.answers?.[q.id]) ? 1 : 0;
      }
      for (const pid of q.points || []) {
        const cell = cellMap.get(pid);
        if (!cell) continue;
        cell.attempts += 1;
        cell.score += value;
      }
    }
  }

  const points = [...cellMap.values()].map((cell) => {
    const mastery = cell.attempts ? Math.round((cell.score / cell.attempts) * 100) / 100 : null;
    return { ...cell, mastery, level: masteryLevel(cell.attempts, mastery) };
  });
  const pointMap = new Map(points.map((p) => [p.id, p]));

  const causeMap = new Map();
  const needsMap = new Map();

  for (const weak of points) {
    if (weak.level !== '薄弱') continue;
    for (const edge of graph.edges) {
      if (edge.to !== weak.id) continue;
      const from = pointMap.get(edge.from);
      if (!from) continue;

      if (!from.attempts) {
        const item = needsMap.get(from.id) || { id: from.id, name: from.name, reasons: new Set() };
        item.reasons.add(`${weak.id} ${weak.name}`);
        needsMap.set(from.id, item);
        continue;
      }

      if (!(from.mastery < 0.8)) continue;
      const contrib = (0.8 - from.mastery) * (Number(edge.strength) || 0);
      const cause = causeMap.get(from.id) || {
        id: from.id,
        name: from.name,
        mastery: from.mastery,
        contrib: 0,
        forPoints: new Set(),
        notes: new Set(),
      };
      cause.contrib += contrib;
      cause.forPoints.add(weak.id);
      if (edge.note) cause.notes.add(edge.note);
      causeMap.set(from.id, cause);
    }
  }

  const rootCauses = [...causeMap.values()]
    .map((c) => ({
      id: c.id,
      name: c.name,
      mastery: c.mastery,
      contrib: Math.round(c.contrib * 1000) / 1000,
      forPoints: [...c.forPoints],
      note: [...c.notes].join('；'),
    }))
    .sort((a, b) => b.contrib - a.contrib)
    .slice(0, 5);

  const needsTesting = [...needsMap.values()].map((n) => ({
    id: n.id,
    name: n.name,
    reason: `「${[...n.reasons].join('」「')}」的薄弱可能源于它，但这个知识点还没有作答记录`,
  }));

  const testedPoints = points.filter((p) => p.attempts > 0);
  const averageMastery = testedPoints.length
    ? Math.round((testedPoints.reduce((sum, p) => sum + p.mastery, 0) / testedPoints.length) * 100) / 100
    : 0;

  return {
    scope: { ...scope, submissionCount },
    summary: {
      pointTotal: points.length,
      tested: testedPoints.length,
      weak: points.filter((p) => p.level === '薄弱').length,
      solid: points.filter((p) => p.level === '掌握').length,
      untested: points.filter((p) => p.level === '未测').length,
      averageMastery,
    },
    points,
    rootCauses,
    needsTesting,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/knowledge') {
      return sendJson(res, 200, knowledge);
    }

    if (pathname === '/api/network') {
      return sendJson(res, 200, { port: PORT, addresses: lanAddresses() });
    }

    if (pathname === '/api/stats') {
      return sendJson(res, 200, { ...stats(), paperCount: papers.items.length });
    }

    if (pathname === '/api/graph') {
      return sendJson(res, 200, graphPayload());
    }

    if (pathname === '/api/diagnose') {
      return sendJson(res, 200, diagnose({
        name: url.searchParams.get('name'),
        className: url.searchParams.get('className'),
        paperId: url.searchParams.get('paperId'),
      }));
    }

    if (pathname === '/api/papers' && req.method === 'GET') {
      return sendJson(res, 200, {
        items: papers.items.map((p) => ({
          id: p.id,
          title: p.title,
          createdAt: p.createdAt,
          count: p.items.length,
          submissions: submissions.items.filter((s) => s.paperId === p.id).length,
        })),
      });
    }

    if (pathname === '/api/papers' && req.method === 'POST') {
      const body = await readBody(req);
      const modules = (Array.isArray(body.modules) ? body.modules : [])
        .map(Number)
        .filter((id) => MODULE_IDS.has(id));
      const points = (Array.isArray(body.points) ? body.points : [])
        .map(String)
        .filter((p) => POINT_IDS.has(p));

      const clampCount = (v) => Math.min(Math.max(Number(v) || 0, 0), 100);
      const counts = {
        single: clampCount(body.counts?.single),
        judge: clampCount(body.counts?.judge),
        operation: clampCount(body.counts?.operation),
      };

      if (counts.single + counts.judge + counts.operation === 0) {
        return sendJson(res, 400, { error: '请至少设置一种题型的数量' });
      }

      const { picked, shortage } = pickQuestions({ modules, points, counts });
      if (!picked.length) {
        return sendJson(res, 400, { error: '题库中没有符合条件的题目，先导入或新增几道' });
      }

      const now = Date.now();
      const d = new Date(now);
      const dateText = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const paper = {
        id: 'p_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        title: String(body.title || '').trim() || `计算机类练习卷 · ${dateText}`,
        createdAt: now,
        config: { modules, points, counts },
        items: picked,
        shortage,
      };

      papers.items.unshift(paper);
      persistPapers();
      return sendJson(res, 201, paper);
    }

    const printMatch = pathname.match(/^\/api\/papers\/([\w-]+)\/print$/);
    if (printMatch && req.method === 'GET') {
      const paper = papers.items.find((p) => p.id === printMatch[1]);
      if (!paper) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('练习卷不存在');
        return;
      }
      const html = buildPaperHtml(paper, url.searchParams.get('answers') === '1');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (pathname.startsWith('/api/papers/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/papers/'.length));
      const before = papers.items.length;
      papers.items = papers.items.filter((p) => p.id !== id);
      if (papers.items.length === before) return sendJson(res, 404, { error: '练习卷不存在' });
      submissions.items = submissions.items.filter((s) => s.paperId !== id);
      persistPapers();
      persistSubmissions();
      return sendJson(res, 200, { ok: true });
    }

    const statsMatch = pathname.match(/^\/api\/papers\/([\w-]+)\/stats$/);
    if (statsMatch && req.method === 'GET') {
      const paper = papers.items.find((p) => p.id === statsMatch[1]);
      if (!paper) return sendJson(res, 404, { error: '练习卷不存在' });

      const subs = submissions.items.filter((s) => s.paperId === paper.id);

      const questions = paper.items
        .map((q, i) => {
          let attempts = 0;
          let wrong = 0;
          let pending = 0;
          for (const s of subs) {
            const auto = gradeOne(q, s.answers?.[q.id]);
            if (auto === null) {
              const manual = s.manual?.[q.id];
              if (!manual) {
                pending += 1;
                continue;
              }
              attempts += 1;
              if (manual.score < 1) wrong += 1;
              continue;
            }
            attempts += 1;
            if (!auto) wrong += 1;
          }
          return {
            index: i + 1,
            id: q.id,
            module: q.module,
            type: q.type,
            stem: q.stem,
            attempts,
            wrong,
            pending,
            rate: attempts ? Math.round((wrong / attempts) * 1000) / 10 : 0,
          };
        })
        .sort((a, b) => b.rate - a.rate || b.wrong - a.wrong);

      const rows = subs.map((s) => ({
        id: s.id,
        name: s.name,
        className: s.className,
        createdAt: s.createdAt,
        ...summarizeSubmission(s, paper),
      }));

      const avgRate = rows.length
        ? Math.round((rows.reduce((sum, r) => sum + r.rate, 0) / rows.length) * 10) / 10
        : 0;

      return sendJson(res, 200, {
        paper: { id: paper.id, title: paper.title, count: paper.items.length },
        summary: {
          submissions: subs.length,
          avgRate,
          pending: rows.reduce((sum, r) => sum + r.pending, 0),
        },
        submissions: rows,
        questions,
      });
    }

    const detailMatch = pathname.match(/^\/api\/papers\/([\w-]+)\/submissions\/([\w-]+)$/);
    if (detailMatch && req.method === 'GET') {
      const paper = papers.items.find((p) => p.id === detailMatch[1]);
      const sub = paper && submissions.items.find((s) => s.id === detailMatch[2]);
      if (!paper || !sub) return sendJson(res, 404, { error: '答卷不存在' });
      return sendJson(res, 200, {
        id: sub.id,
        name: sub.name,
        className: sub.className,
        createdAt: sub.createdAt,
        summary: summarizeSubmission(sub, paper),
        items: buildSubmissionDetail(sub, paper),
      });
    }

    const gradeMatch = pathname.match(/^\/api\/papers\/([\w-]+)\/submissions\/([\w-]+)\/grade$/);
    if (gradeMatch && req.method === 'POST') {
      const paper = papers.items.find((p) => p.id === gradeMatch[1]);
      const sub = paper && submissions.items.find((s) => s.id === gradeMatch[2]);
      if (!paper || !sub) return sendJson(res, 404, { error: '答卷不存在' });

      const body = await readBody(req);
      const list = Array.isArray(body.items) ? body.items : [];
      sub.manual = sub.manual || {};
      let saved = 0;

      for (const row of list) {
        const q = paper.items.find((x) => x.id === String(row.id || ''));
        if (!q || q.type !== 'operation') continue;

        const score = Number(row.score);
        if (![0, 0.5, 1].includes(score)) continue;

        sub.manual[q.id] = {
          score,
          comment: String(row.comment || '').trim().slice(0, 300),
          at: Date.now(),
        };
        saved += 1;
      }

      if (saved) persistSubmissions();
      return sendJson(res, 200, { saved, ...summarizeSubmission(sub, paper) });
    }

    const quizMatch = pathname.match(/^\/api\/quiz\/([\w-]+)$/);
    if (quizMatch && req.method === 'GET') {
      const paper = papers.items.find((p) => p.id === quizMatch[1]);
      if (!paper) return sendJson(res, 404, { error: '练习卷不存在或已删除' });
      return sendJson(res, 200, {
        id: paper.id,
        title: paper.title,
        createdAt: paper.createdAt,
        items: paper.items.map((q, i) => ({
          index: i + 1,
          id: q.id,
          module: q.module,
          type: q.type,
          stem: q.stem,
          options: q.options || [],
          points: q.points || [],
        })),
      });
    }

    const submitMatch = pathname.match(/^\/api\/quiz\/([\w-]+)\/submit$/);
    if (submitMatch && req.method === 'POST') {
      const paper = papers.items.find((p) => p.id === submitMatch[1]);
      if (!paper) return sendJson(res, 404, { error: '练习卷不存在或已删除' });

      const body = await readBody(req);
      const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
      const details = [];
      let autoTotal = 0;
      let correct = 0;

      paper.items.forEach((q, i) => {
        const user = String(answers[q.id] ?? '').trim().slice(0, 2000);
        const ok = gradeOne(q, user);
        if (ok !== null) {
          autoTotal += 1;
          if (ok) correct += 1;
        }
        details.push({
          index: i + 1,
          id: q.id,
          type: q.type,
          stem: q.stem,
          your: user,
          answer: q.answer || '',
          analysis: q.analysis || '',
          ok,
        });
      });

      const record = {
        id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        paperId: paper.id,
        name: String(body.name || '').trim().slice(0, 20),
        className: String(body.className || '').trim().slice(0, 20),
        answers,
        autoTotal,
        correct,
        rate: autoTotal ? Math.round((correct / autoTotal) * 1000) / 10 : 0,
        createdAt: Date.now(),
      };

      submissions.items.unshift(record);
      if (submissions.items.length > 5000) submissions.items = submissions.items.slice(0, 5000);
      persistSubmissions();

      return sendJson(res, 200, {
        id: record.id,
        title: paper.title,
        autoTotal,
        correct,
        rate: record.rate,
        details,
      });
    }

    if (/^\/s\/[\w-]+$/.test(pathname)) {
      return serveFile(res, 'student.html');
    }

    if (pathname === '/wrong') {
      return serveFile(res, 'wrong.html');
    }

    if (pathname === '/graph') {
      return serveFile(res, 'graph.html');
    }

    if (pathname === '/api/questions' && req.method === 'GET') {
      return sendJson(res, 200, queryQuestions({
        module: url.searchParams.get('module'),
        type: url.searchParams.get('type'),
        point: url.searchParams.get('point'),
        q: url.searchParams.get('q'),
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
      }));
    }

    if (pathname === '/api/questions' && req.method === 'POST') {
      const record = normalize(await readBody(req));
      db.items.push(record);
      persist();
      return sendJson(res, 201, record);
    }

    if (pathname === '/api/questions/bulk' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.items) ? body.items : [];
      const saved = [];
      const failed = [];
      for (const item of list) {
        try {
          saved.push(normalize(item));
        } catch (err) {
          failed.push({ stem: String(item.stem || '').slice(0, 40), reason: err.message });
        }
      }
      db.items.push(...saved);
      if (saved.length) persist();
      return sendJson(res, 200, { saved: saved.length, failed });
    }

    if (pathname === '/api/questions/missing-analysis' && req.method === 'GET') {
      const items = db.items
        .filter((q) => !String(q.analysis || '').trim())
        .map((q) => ({ id: q.id, stem: q.stem.slice(0, 40), type: q.type }));
      return sendJson(res, 200, { total: items.length, items });
    }

    if (pathname.startsWith('/api/questions/')) {
      const rest = decodeURIComponent(pathname.slice('/api/questions/'.length));

      if (rest.endsWith('/explain') && req.method === 'POST') {
        const item = db.items.find((q) => q.id === rest.replace(/\/explain$/, ''));
        if (!item) return sendJson(res, 404, { error: '题目不存在' });
        const analysis = await explainQuestion(item);
        item.analysis = analysis;
        item.updatedAt = Date.now();
        persist();
        return sendJson(res, 200, { id: item.id, analysis });
      }

      const idx = db.items.findIndex((it) => it.id === rest);
      if (idx === -1) return sendJson(res, 404, { error: '题目不存在' });

      if (req.method === 'PUT') {
        const updated = normalize(await readBody(req), db.items[idx]);
        db.items[idx] = updated;
        persist();
        return sendJson(res, 200, updated);
      }

      if (req.method === 'DELETE') {
        db.items.splice(idx, 1);
        persist();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/parse' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (text.length < 10) return sendJson(res, 400, { error: '请贴入至少 10 个字符的题目文本' });
      if (text.length > 20000) return sendJson(res, 400, { error: '单次解析不要超过 2 万字' });
      const result = await parseWithAI(text);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/parse/file' && req.method === 'POST') {
      const body = await readBody(req, 32 * 1024 * 1024);
      const name = String(body.name || '未命名文件').slice(0, 80);
      const b64 = String(body.data || '').replace(/^data:[^,]+,/, '');
      const mime = String(body.mime || '').toLowerCase();
      if (!b64) return sendJson(res, 400, { error: '没有收到文件内容' });

      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return sendJson(res, 400, { error: '文件内容为空或不是合法的 base64' });

      if (/^image\//.test(mime)) {
        if (!/^image\/(png|jpe?g|webp)$/.test(mime)) {
          return sendJson(res, 400, { error: '图片只支持 JPG / PNG / WEBP' });
        }
        if (buf.length > 8 * 1024 * 1024) return sendJson(res, 400, { error: '单张图片不要超过 8MB' });
        const result = await parseImageWithAI(b64, mime === 'image/jpg' ? 'image/jpeg' : mime);
        return sendJson(res, 200, { ...result, kind: 'image', note: `${name} · 视觉识别` });
      }

      if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
        const { text, pages, images } = extractPdf(buf);

        if (text.length >= 60) {
          const result = await parseWithAI(text.slice(0, 20000));
          return sendJson(res, 200, {
            ...result,
            kind: 'pdf-text',
            note: `${name} · 提取到 ${text.length} 字文字层`,
          });
        }

        // 优先按页序取图；页结构解析不出来时退回“按对象顺序”
        const pageList = pages.length ? pages : images.map((data, i) => ({ index: i + 1, data }));
        if (!pageList.length) {
          return sendJson(res, 400, {
            error: `${name} 没有文字层也没找到内嵌图片，读不出来。请把页面截图或拍照后按图片上传。`,
          });
        }

        const { drafts, skipped, failed, total, processed } = await parsePdfPages(pageList);

        if (!drafts.length && failed.length) {
          return sendJson(res, 502, { error: `${name} 的扫描页识别失败：${failed[0].reason}` });
        }

        const notes = [`${name} · 共 ${total} 页`];
        if (processed < total) notes.push(`本次识别前 ${processed} 页`);
        else notes.push(`识别 ${processed} 页`);
        if (failed.length) notes.push(`${failed.length} 页失败`);

        return sendJson(res, 200, {
          drafts,
          skipped,
          failed,
          kind: 'pdf-scan',
          note: notes.join(' · '),
        });
      }

      return sendJson(res, 400, { error: '只支持图片（JPG/PNG/WEBP）和 PDF 文件' });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: '未知接口' });
    }

    serveStatic(res, pathname);
  } catch (err) {
    console.error('[server]', err.message);
    sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  湖北技能高考 · 计算机类错题工作台`);
  console.log(`  教师端 → http://localhost:${PORT}`);
  for (const nic of lanAddresses()) {
    console.log(`  局域网 → http://${nic.address}:${PORT}（手机连同一个 WiFi 即可打开）`);
  }
  console.log(`  题库现有 ${db.items.length} 道题\n`);
});
