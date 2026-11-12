const state = {
  knowledge: null,
  stats: null,
  filters: { module: '', type: '', q: '', page: 1 },
  items: [],
  papers: [],
  editingId: null,
  drafts: [],
  files: [],
  currentPaper: null,
  grade: null,
  network: null,
};

const $ = (s) => document.querySelector(s);

const TYPE_LABEL = { single: '选择题', judge: '判断题', operation: '操作题' };

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function moduleOf(id) {
  return state.knowledge.modules.find((m) => m.id === Number(id));
}

function pointName(pid) {
  for (const m of state.knowledge.modules) {
    const p = m.points.find((x) => x.id === pid);
    if (p) return p.name;
  }
  return pid;
}

/* ---------- 侧栏 ---------- */

function renderModules() {
  const list = $('#moduleList');
  const rows = state.stats.byModule;
  const all = state.stats.total;

  list.innerHTML =
    `<li class="${state.filters.module === '' ? 'active' : ''}" data-module="">
       <span>全部题目</span><span class="count">${all}</span>
     </li>` +
    rows
      .map(
        (m) => `<li class="${String(m.id) === String(state.filters.module) ? 'active' : ''}" data-module="${m.id}">
          <span>${m.id}. ${escapeHtml(m.name)}</span>
          <span><span class="count">${m.count}</span><span class="score">/${m.score}分</span></span>
        </li>`,
      )
      .join('');

  $('#totalBadge').textContent = `题库 ${all} 题`;
}

/* ---------- 列表 ---------- */

function renderList(data) {
  state.items = data.items;

  if (!data.items.length) {
    $('#list').innerHTML = `<div class="empty">
      <strong>还没有题目</strong>
      点右上角「新增题目」，或用「AI 批量导入」把整份试卷粘进来
    </div>`;
    $('#resultInfo').textContent = '';
    return;
  }

  $('#list').innerHTML = data.items
    .map((q, i) => {
      const m = moduleOf(q.module);
      const no = (data.page - 1) * data.pageSize + i + 1;
      const opts = (q.options || [])
        .map((o) => `<span>${escapeHtml(o.key)}. ${escapeHtml(o.text)}</span>`)
        .join('');
      const points = (q.points || []).map((p) => `<span class="tag">${escapeHtml(pointName(p))}</span>`).join('');
      return `<article class="q-item" data-id="${q.id}">
        <div class="q-head">
          <span class="q-no">${no}</span>
          <span class="tag mod">${q.module}. ${escapeHtml(m ? m.name : '未分类')}</span>
          <span class="tag type ${q.type === 'operation' ? 'op' : ''}">${TYPE_LABEL[q.type] || q.type}</span>
          ${points}
        </div>
        <div class="q-stem">${escapeHtml(q.stem)}</div>
        ${opts ? `<div class="q-options">${opts}</div>` : ''}
        <div class="q-meta">
          ${q.answer ? `<span class="q-answer">答案：${escapeHtml(q.answer)}</span>` : '<span>未填答案</span>'}
          ${q.source ? `<span>来源：${escapeHtml(q.source)}</span>` : ''}
          <span>难度 ${q.difficulty}</span>
        </div>
      </article>`;
    })
    .join('');

  $('#resultInfo').textContent = `共 ${data.total} 题 · 第 ${data.page} 页`;
}

function renderPager(data) {
  const pages = Math.ceil(data.total / data.pageSize);
  const pager = $('#pager');
  if (pages <= 1) {
    pager.innerHTML = '';
    return;
  }

  const current = data.page;
  const nums = [];
  const start = Math.max(1, Math.min(current - 2, pages - 4));
  for (let i = start; i < start + 5 && i <= pages; i += 1) nums.push(i);

  pager.innerHTML =
    `<button data-page="${Math.max(1, current - 1)}" ${current === 1 ? 'disabled' : ''}>上一页</button>` +
    nums.map((n) => `<button data-page="${n}" class="${n === current ? 'active' : ''}">${n}</button>`).join('') +
    `<button data-page="${Math.min(pages, current + 1)}" ${current === pages ? 'disabled' : ''}>下一页</button>`;
}

async function loadList() {
  const params = new URLSearchParams();
  if (state.filters.module !== '') params.set('module', state.filters.module);
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.q) params.set('q', state.filters.q);
  params.set('page', state.filters.page);
  params.set('pageSize', 10);

  const data = await api(`/api/questions?${params}`);
  renderList(data);
  renderPager(data);
}

async function refreshAll() {
  state.stats = await api('/api/stats');
  renderModules();
  await loadList();
  await loadPapers();
}

/* ---------- 练习卷 ---------- */

async function loadPapers() {
  const data = await api('/api/papers');
  state.papers = data.items || [];
  renderPaperList();
}

function renderPaperList() {
  const ul = $('#paperList');
  $('#paperCount').textContent = state.papers.length ? `${state.papers.length} 份` : '';
  if (!state.papers.length) {
    ul.innerHTML = '<li class="paper-empty">还没有生成过</li>';
    return;
  }
  ul.innerHTML = state.papers
    .map(
      (p) => `<li>
        <a data-open="${p.id}" title="查看答卷与错题统计">${escapeHtml(p.title)}</a>
        <span class="muted">${p.count}题${p.submissions ? ` · ${p.submissions}人` : ''}</span>
        <button class="del" data-del="${p.id}" title="删除">×</button>
      </li>`,
    )
    .join('');
}

function selectedPaperModules() {
  return [...document.querySelectorAll('#pModules input:checked')].map((i) => Number(i.value));
}

function renderPaperModules() {
  $('#pModules').innerHTML = state.knowledge.modules
    .map((m) => `<label class="chip"><input type="checkbox" value="${m.id}" />${m.id}. ${escapeHtml(m.name)}</label>`)
    .join('');
}

function renderPaperPoints() {
  const mods = selectedPaperModules();
  const list = state.knowledge.modules.filter((m) => !mods.length || mods.includes(m.id));
  const box = $('#pPoints');
  box.innerHTML = list
    .flatMap((m) =>
      m.points.map(
        (p) => `<label class="chip"><input type="checkbox" value="${p.id}" />${escapeHtml(m.name)} · ${escapeHtml(p.name)}</label>`,
      ),
    )
    .join('');
}

function renderPaperResult(paper) {
  const byType = { single: 0, judge: 0, operation: 0 };
  for (const it of paper.items) byType[it.type] += 1;
  const warn = (paper.shortage || []).length
    ? `<p class="warn">${paper.shortage.map((s) => escapeHtml(s)).join('；')}</p>`
    : '';
  const studentUrl = studentLink(paper.id);

  $('#paperResult').innerHTML = `<div class="paper-card">
    <h3>${escapeHtml(paper.title)}</h3>
    <p class="muted">共 ${paper.items.length} 题 · 选择 ${byType.single} · 判断 ${byType.judge} · 操作 ${byType.operation}</p>
    ${warn}
    <div class="paper-actions">
      <a class="primary-link" href="/api/papers/${paper.id}/print" target="_blank">打印试卷</a>
      <a href="/api/papers/${paper.id}/print?answers=1" target="_blank">打印含答案</a>
      <a href="/s/${paper.id}" target="_blank">学生答题页</a>
      <button type="button" class="copy-link" data-copy="${escapeHtml(studentUrl)}">复制学生链接</button>
    </div>
    <p class="muted" style="margin-top:8px">学生链接：${escapeHtml(studentUrl)}</p>
    <details class="qr-box">
      <summary>手机扫码答题</summary>
      <div class="qr" data-qr="${escapeHtml(studentUrl)}"></div>
    </details>
  </div>`;

  fillQr();
}

/** 学生链接优先用局域网地址，手机才能打开 */
function studentLink(paperId) {
  const nic = state.network && state.network.addresses && state.network.addresses[0];
  const port = (state.network && state.network.port) || location.port || 3100;
  const origin = nic ? `http://${nic.address}:${port}` : location.origin;
  return `${origin}/s/${paperId}`;
}

function fillQr() {
  document.querySelectorAll('[data-qr]').forEach((el) => {
    const url = el.dataset.qr;
    if (!url || typeof qrcode !== 'function') return;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch {
      el.textContent = url;
    }
  });
}

async function generatePaper() {
  const btn = $('#btnGen');
  btn.disabled = true;
  $('#pStatus').textContent = '生成中…';

  try {
    const paper = await api('/api/papers', {
      method: 'POST',
      body: JSON.stringify({
        title: $('#pTitle').value.trim(),
        modules: selectedPaperModules(),
        points: [...document.querySelectorAll('#pPoints input:checked')].map((i) => i.value),
        counts: {
          single: Number($('#cSingle').value),
          judge: Number($('#cJudge').value),
          operation: Number($('#cOper').value),
        },
      }),
    });
    renderPaperResult(paper);
    $('#pStatus').textContent = `生成成功，共 ${paper.items.length} 题`;
    await loadPapers();
  } catch (err) {
    $('#pStatus').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function deletePaper(id) {
  if (!confirm('删除这份练习卷？不影响题库。')) return;
  try {
    await api(`/api/papers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadPapers();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- 答卷与错题统计 ---------- */

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openStats(id) {
  try {
    const data = await api(`/api/papers/${encodeURIComponent(id)}/stats`);
    state.currentPaper = id;
    $('#statsTitle').textContent = data.paper.title;
    $('#statsPrint').href = `/api/papers/${id}/print`;
    $('#statsQuiz').href = studentLink(id);
    const statsQr = $('#statsQr');
    if (statsQr) {
      statsQr.dataset.qr = studentLink(id);
      statsQr.innerHTML = '';
      fillQr();
    }

    const { submissions: count, avgRate, pending } = data.summary;
    $('#statsSummary').innerHTML = `
      <div class="stat-box"><span>${count}</span><label>提交人数</label></div>
      <div class="stat-box"><span>${avgRate}%</span><label>平均正确率</label></div>
      <div class="stat-box"><span>${pending || 0}</span><label>待批改操作题</label></div>`;

    if (!count) {
      $('#wrongRank').innerHTML = '<p class="muted">还没有学生提交，暂时没有错题数据。</p>';
      $('#subTable').innerHTML = '';
      $('#statsHint').textContent = '把学生链接发到班级群，提交后这里会自动汇总';
    } else {
      const rank = data.questions.filter((q) => q.attempts > 0);
      $('#wrongRank').innerHTML = rank.length
        ? rank
            .map((q) => {
              const rateText = q.wrong ? `错误率 ${q.rate}%（${q.wrong}/${q.attempts}）` : '全部答对';
              return `<div class="rank-item ${q.wrong ? '' : 'all-right'}">
                <div class="rank-head">
                  <span>第 ${q.index} 题 · ${TYPE_LABEL[q.type] || q.type}</span>
                  <span class="rank-rate">${rateText}${q.pending ? ` · ${q.pending} 道待批改` : ''}</span>
                </div>
                <div class="rank-stem">${escapeHtml(q.stem)}</div>
                <div class="rank-bar"><i style="width:${q.rate}%"></i></div>
              </div>`;
            })
            .join('')
        : '<p class="muted">这份卷子的作答都是操作题，需要人工批改。</p>';

      const rows = data.submissions
        .map(
          (s) => `<tr data-sub="${s.id}" title="点击批改操作题">
            <td>${escapeHtml(s.name || '未填姓名')}</td>
            <td>${escapeHtml(s.className || '—')}</td>
            <td class="num">${s.rate}%</td>
            <td class="num">${s.correct}/${s.autoTotal}</td>
            <td class="num">${s.manualTotal ? `${s.manualTotal} 已批` : ''}${s.manualTotal && s.pending ? ' · ' : ''}${s.pending ? `<span class="warn">${s.pending} 待批</span>` : s.manualTotal ? '' : '—'}</td>
            <td>${formatTime(s.createdAt)}</td>
          </tr>`,
        )
        .join('');

      $('#subTable').innerHTML = `<table>
        <thead><tr><th>姓名</th><th>班级</th><th>正确率</th><th>客观题</th><th>操作题</th><th>提交时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
      $('#statsHint').textContent = '点击任意一行可以批改该学生的操作题';
    }

    $('#statsModal').hidden = false;
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- 操作题批改 ---------- */

function renderGradeSummary(sum) {
  $('#gradeSummary').innerHTML = `
    <div class="stat-box"><span>${sum.rate}%</span><label>当前正确率</label></div>
    <div class="stat-box"><span>${sum.manualTotal}</span><label>已批操作题</label></div>
    <div class="stat-box"><span>${sum.pending}</span><label>剩余待批</label></div>`;
}

async function openGrade(paperId, subId) {
  try {
    const data = await api(`/api/papers/${paperId}/submissions/${subId}`);
    state.grade = { paperId, subId };

    const who = `${data.name || '未填姓名'}${data.className ? ` · ${data.className}` : ''}`;
    $('#gradeTitle').textContent = `${who} · 操作题批改`;
    renderGradeSummary(data.summary);

    const ops = data.items.filter((it) => it.type === 'operation');
    $('#gradeList').innerHTML = ops.length
      ? ops
          .map((q) => {
            const btn = (value, text) =>
              `<button type="button" class="score-btn${q.score === value ? ' active' : ''}" data-score="${value}">${text}</button>`;
            return `<div class="grade-item" data-qid="${q.id}">
              <div class="grade-head">
                <span class="tag type op">第 ${q.index} 题 · 操作题</span>
                <span class="muted">${escapeHtml(q.stem.slice(0, 40))}</span>
              </div>
              <div class="grade-block"><label>学生作答</label><pre>${escapeHtml(q.your || '（未作答）')}</pre></div>
              <details><summary>参考答案</summary><pre>${escapeHtml(q.answer || '（未填）')}</pre></details>
              <div class="grade-score">
                <span class="muted">评分</span>
                ${btn(1, '正确')}${btn(0.5, '部分正确')}${btn(0, '错误')}
              </div>
              <input class="grade-comment" maxlength="300" placeholder="评语（可选）" value="${escapeHtml(q.comment || '')}" />
            </div>`;
          })
          .join('')
      : '<p class="muted">这份卷子没有操作题，全部由客观题自动判分。</p>';

    $('#btnSaveGrade').disabled = !ops.length;
    $('#gradeStatus').textContent = '';
    $('#gradeModal').hidden = false;
  } catch (err) {
    alert(err.message);
  }
}

async function saveGrade() {
  if (!state.grade) return;

  const payload = [...document.querySelectorAll('#gradeList .grade-item')]
    .map((el) => {
      const active = el.querySelector('.score-btn.active');
      if (!active) return null;
      return {
        id: el.dataset.qid,
        score: Number(active.dataset.score),
        comment: el.querySelector('.grade-comment').value.trim(),
      };
    })
    .filter(Boolean);

  if (!payload.length) {
    $('#gradeStatus').textContent = '先给至少一道题选评分';
    return;
  }

  const btn = $('#btnSaveGrade');
  btn.disabled = true;
  try {
    const res = await api(`/api/papers/${state.grade.paperId}/submissions/${state.grade.subId}/grade`, {
      method: 'POST',
      body: JSON.stringify({ items: payload }),
    });
    renderGradeSummary(res);
    $('#gradeStatus').textContent = `已保存 ${res.saved} 道`;
    await openStats(state.grade.paperId);
  } catch (err) {
    $('#gradeStatus').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- AI 补全解析 ---------- */

async function runExplainMissing() {
  const { total, items } = await api('/api/questions/missing-analysis');
  if (!total) {
    alert('所有题目都已有解析。');
    return;
  }
  if (!confirm(`还有 ${total} 道题没有解析，逐题生成（每道约 5–10 秒），继续？`)) return;

  const btn = $('#btnExplain');
  btn.disabled = true;
  let done = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      try {
        await api(`/api/questions/${item.id}/explain`, { method: 'POST' });
      } catch {
        failed += 1;
      }
      done += 1;
      btn.textContent = `解析 ${done}/${items.length}`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, items.length) }, worker));

  btn.textContent = '补全解析';
  btn.disabled = false;
  await refreshAll();
  alert(`完成：成功 ${done - failed} 道${failed ? `，失败 ${failed} 道` : ''}`);
}

/* ---------- 编辑器 ---------- */

function optionRow(key = '', text = '') {
  const row = document.createElement('div');
  row.className = 'option-row';
  row.innerHTML = `<input class="key" maxlength="2" placeholder="A" value="${escapeHtml(key)}" />
    <input class="text" placeholder="选项内容" value="${escapeHtml(text)}" />
    <button type="button" class="link remove">删除</button>`;
  row.querySelector('.remove').addEventListener('click', () => row.remove());
  return row;
}

function renderOptions(options) {
  const box = $('#optionRows');
  box.innerHTML = '';
  const list = options && options.length ? options : [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }];
  list.forEach((o) => box.appendChild(optionRow(o.key, o.text)));
}

function renderPoints(moduleId, selected = []) {
  const m = moduleOf(moduleId);
  const box = $('#pointList');
  if (!m) {
    box.innerHTML = '<span class="muted">先选知识模块</span>';
    return;
  }
  box.innerHTML = m.points
    .map(
      (p) => `<label class="chip"><input type="checkbox" value="${p.id}" ${selected.includes(p.id) ? 'checked' : ''} />${escapeHtml(p.name)}</label>`,
    )
    .join('');
}

function renderReasons(selected = []) {
  $('#reasonList').innerHTML = state.knowledge.wrongReasonTags
    .map(
      (t) => `<label class="chip"><input type="checkbox" value="${escapeHtml(t)}" ${selected.includes(t) ? 'checked' : ''} />${escapeHtml(t)}</label>`,
    )
    .join('');
}

function toggleTypeBlocks() {
  const isSingle = $('#fType').value === 'single';
  $('#optionsBlock').hidden = !isSingle;
}

function openEditor(question) {
  state.editingId = question && question.id ? question.id : null;
  $('#editorTitle').textContent = question ? '编辑题目' : '新增题目';
  $('#btnDelete').hidden = !question;

  const q = question || {
    module: state.filters.module || 1,
    type: state.filters.type || 'single',
    stem: '',
    options: [],
    answer: '',
    analysis: '',
    points: [],
    difficulty: 3,
    source: '',
    wrongReasons: [],
  };

  $('#fModule').value = String(q.module);
  $('#fType').value = q.type;
  $('#fDifficulty').value = String(q.difficulty);
  $('#fStem').value = q.stem;
  $('#fAnswer').value = q.answer || '';
  $('#fSource').value = q.source || '';
  $('#fAnalysis').value = q.analysis || '';

  renderOptions(q.options);
  renderPoints(q.module, q.points || []);
  renderReasons(q.wrongReasons || []);
  toggleTypeBlocks();

  $('#editorModal').hidden = false;
  $('#fStem').focus();
}

function closeEditor() {
  $('#editorModal').hidden = true;
  state.editingId = null;
}

function collectForm() {
  const options = [...document.querySelectorAll('#optionRows .option-row')]
    .map((row) => ({
      key: row.querySelector('.key').value.trim(),
      text: row.querySelector('.text').value.trim(),
    }))
    .filter((o) => o.key && o.text);

  return {
    module: Number($('#fModule').value),
    type: $('#fType').value,
    stem: $('#fStem').value.trim(),
    options,
    answer: $('#fAnswer').value.trim(),
    analysis: $('#fAnalysis').value.trim(),
    points: [...document.querySelectorAll('#pointList input:checked')].map((i) => i.value),
    difficulty: Number($('#fDifficulty').value),
    source: $('#fSource').value.trim(),
    wrongReasons: [...document.querySelectorAll('#reasonList input:checked')].map((i) => i.value),
  };
}

async function saveQuestion(e) {
  e.preventDefault();
  try {
    const payload = collectForm();
    if (state.editingId) {
      await api(`/api/questions/${encodeURIComponent(state.editingId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/api/questions', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeEditor();
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteQuestion() {
  if (!state.editingId || !confirm('确定删除这道题？')) return;
  try {
    await api(`/api/questions/${encodeURIComponent(state.editingId)}`, { method: 'DELETE' });
    closeEditor();
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- 批量导入 ---------- */

function renderDrafts() {
  const box = $('#draftList');
  if (!state.drafts.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = state.drafts
    .map((d, i) => {
      const m = moduleOf(d.module);
      const opts = (d.options || []).map((o) => `<span class="tag">${escapeHtml(o.key)}. ${escapeHtml(o.text)}</span>`).join('');
      return `<div class="draft">
        <div class="d-head">
          <span class="tag mod">${d.module}. ${escapeHtml(m ? m.name : '未分类')}</span>
          <span class="tag type">${TYPE_LABEL[d.type] || d.type}</span>
          <span class="muted">#${i + 1}</span>
        </div>
        <div class="d-stem">${escapeHtml(d.stem)}</div>
        ${opts ? `<div class="d-meta">${opts}</div>` : ''}
        <div class="d-meta">答案：${escapeHtml(d.answer || '未识别')}</div>
      </div>`;
    })
    .join('');
}

async function parseText() {
  const text = $('#importText').value.trim();
  const btn = $('#btnParse');
  btn.disabled = true;
  $('#importStatus').textContent = '解析中，长文本可能需要半分钟…';

  try {
    const result = await api('/api/parse', { method: 'POST', body: JSON.stringify({ text }) });
    state.drafts = result.drafts || [];
    renderDrafts();
    $('#btnSaveDrafts').disabled = state.drafts.length === 0;
    const skipped = (result.skipped || []).length;
    $('#importStatus').textContent = `识别 ${state.drafts.length} 道${skipped ? `，${skipped} 道被跳过` : ''}`;
  } catch (err) {
    $('#importStatus').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 图片 / PDF 识别 ---------- */

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 手机上拍的试卷动辄几 MB，先缩到 1600px 再上传，速度更快也更省钱 */
async function compressImage(file, maxSide = 1600, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  const tScale = Math.min(1, 84 / Math.max(width, height));
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = Math.max(1, Math.round(width * tScale));
  thumbCanvas.height = Math.max(1, Math.round(height * tScale));
  thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);

  bitmap.close?.();
  return {
    dataUrl: canvas.toDataURL('image/jpeg', quality),
    thumb: thumbCanvas.toDataURL('image/jpeg', 0.7),
  };
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function renderFileList() {
  const ul = $('#fileList');
  if (!state.files.length) {
    ul.innerHTML = '';
    return;
  }
  ul.innerHTML = state.files
    .map(
      (f) => `<li class="file-item">
        ${f.thumb ? `<img src="${f.thumb}" alt="" />` : `<span class="file-icon">${f.kind === 'pdf' ? 'PDF' : 'IMG'}</span>`}
        <div class="file-info">
          <span class="file-name">${escapeHtml(f.name)}</span>
          <span class="file-status${f.error ? ' bad' : ''}">${escapeHtml(f.error || f.status)}</span>
        </div>
        <button type="button" class="del" data-file-remove="${f.id}" title="移除">×</button>
      </li>`,
    )
    .join('');
}

async function addFiles(list) {
  for (const file of list) {
    const entry = {
      id: 'f_' + Math.random().toString(36).slice(2, 8),
      name: file.name,
      kind: /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? 'pdf' : 'image',
      status: '准备中…',
      thumb: '',
      mime: '',
      data: '',
      error: '',
      done: false,
    };
    state.files.push(entry);
    renderFileList();

    try {
      if (entry.kind === 'pdf') {
        if (file.size > 20 * 1024 * 1024) throw new Error('PDF 不要超过 20MB，可先拆分或截图');
        entry.mime = 'application/pdf';
        entry.data = bufToBase64(await file.arrayBuffer());
      } else {
        if (!/^image\//.test(file.type)) throw new Error('不是图片文件');
        const { dataUrl, thumb } = await compressImage(file);
        entry.mime = 'image/jpeg';
        entry.thumb = thumb;
        entry.data = dataUrl.split(',')[1];
      }
      entry.status = `就绪 · ${formatSize(Math.round(entry.data.length * 0.75))}`;
    } catch (err) {
      entry.error = /image/i.test(err.message) || err.name === 'InvalidStateError'
        ? '图片读不出来，请转成 JPG 再试'
        : err.message;
    }
    renderFileList();
  }
}

function addDrafts(list) {
  const seen = new Set(state.drafts.map((d) => String(d.stem || '').replace(/\s+/g, '')));
  let added = 0;
  for (const d of list || []) {
    const key = String(d.stem || '').replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    state.drafts.push(d);
    added += 1;
  }
  renderDrafts();
  $('#btnSaveDrafts').disabled = state.drafts.length === 0;
  return added;
}

async function parsePending() {
  const btn = $('#btnParse');
  const files = state.files.filter((f) => f.data && !f.error && !f.done);

  if (!files.length) {
    const text = $('#importText').value.trim();
    if (text.length < 10) {
      $('#importStatus').textContent = '先选图片/PDF，或粘贴至少 10 个字的题目文本';
      return;
    }
    await parseText();
    return;
  }

  btn.disabled = true;
  let added = 0;
  let dropped = 0;

  try {
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      f.status = `识别中…（${i + 1}/${files.length}）`;
      renderFileList();
      $('#importStatus').textContent = `识别中 ${i + 1}/${files.length}：${f.name}`;

      try {
        const result = await api('/api/parse/file', {
          method: 'POST',
          body: JSON.stringify({ name: f.name, mime: f.mime, data: f.data }),
        });
        const n = addDrafts(result.drafts || []);
        added += n;
        dropped += (result.skipped || []).length;
        f.done = true;
        f.status = `${result.note || '已识别'} · 新增 ${n} 道`;
      } catch (err) {
        f.error = err.message;
      }
      renderFileList();
    }
    $('#importStatus').textContent = `本次新增 ${added} 道${dropped ? `，AI 丢弃 ${dropped} 条` : ''}。核对后点「全部入库」。`;
  } finally {
    btn.disabled = false;
    renderDrafts();
    $('#btnSaveDrafts').disabled = state.drafts.length === 0;
  }
}

async function saveDrafts() {
  if (!state.drafts.length) return;
  const btn = $('#btnSaveDrafts');
  btn.disabled = true;
  try {
    const result = await api('/api/questions/bulk', {
      method: 'POST',
      body: JSON.stringify({ items: state.drafts }),
    });
    $('#importStatus').textContent = `已入库 ${result.saved} 道${result.failed?.length ? `，失败 ${result.failed.length} 道` : ''}`;
    state.drafts = [];
    state.files = [];
    renderDrafts();
    renderFileList();
    $('#importText').value = '';
    $('#fileInput').value = '';
    await refreshAll();
  } catch (err) {
    $('#importStatus').textContent = err.message;
    btn.disabled = false;
  }
}

/* ---------- 事件绑定 ---------- */

function bind() {
  $('#moduleList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-module]');
    if (!li) return;
    state.filters.module = li.dataset.module;
    state.filters.page = 1;
    renderModules();
    loadList();
  });

  $('#typeFilter').addEventListener('change', (e) => {
    state.filters.type = e.target.value;
    state.filters.page = 1;
    loadList();
  });

  let timer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      state.filters.page = 1;
      loadList();
    }, 300);
  });

  $('#pager').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    state.filters.page = Number(btn.dataset.page);
    loadList();
  });

  $('#list').addEventListener('click', (e) => {
    const card = e.target.closest('.q-item');
    if (!card) return;
    const q = state.items.find((it) => it.id === card.dataset.id);
    if (q) openEditor(q);
  });

  $('#btnNew').addEventListener('click', () => openEditor(null));
  $('#btnDelete').addEventListener('click', deleteQuestion);
  $('#editorForm').addEventListener('submit', saveQuestion);

  $('#fModule').addEventListener('change', (e) => renderPoints(e.target.value, []));
  $('#fType').addEventListener('change', toggleTypeBlocks);
  $('#addOption').addEventListener('click', () => {
    const rows = document.querySelectorAll('#optionRows .option-row').length;
    const nextKey = String.fromCharCode(65 + rows);
    $('#optionRows').appendChild(optionRow(nextKey, ''));
  });

  $('#btnImport').addEventListener('click', () => {
    $('#importModal').hidden = false;
    $('#importStatus').textContent = '';
  });
  $('#btnParse').addEventListener('click', parsePending);
  $('#btnSaveDrafts').addEventListener('click', saveDrafts);

  $('#fileInput').addEventListener('change', async (e) => {
    const picked = [...e.target.files];
    e.target.value = '';
    if (!picked.length) return;
    $('#importStatus').textContent = '';
    await addFiles(picked);
  });

  $('#fileList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-file-remove]');
    if (!btn) return;
    state.files = state.files.filter((f) => f.id !== btn.dataset.fileRemove);
    renderFileList();
  });

  $('#btnPaper').addEventListener('click', () => {
    $('#pTitle').value = '';
    $('#pStatus').textContent = '';
    $('#paperResult').innerHTML = '';
    renderPaperModules();
    renderPaperPoints();
    $('#paperModal').hidden = false;
  });

  $('#pModules').addEventListener('change', renderPaperPoints);
  $('#btnGen').addEventListener('click', generatePaper);

  $('#paperList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      deletePaper(del.dataset.del);
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openStats(open.dataset.open);
  });

  $('#paperResult').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制学生链接'; }, 1500);
    } catch {
      prompt('复制这个链接发给学生：', text);
    }
  });

  $('#subTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-sub]');
    if (tr && state.currentPaper) openGrade(state.currentPaper, tr.dataset.sub);
  });

  $('#gradeList').addEventListener('click', (e) => {
    const btn = e.target.closest('.score-btn');
    if (!btn) return;
    const item = btn.closest('.grade-item');
    item.querySelectorAll('.score-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });

  $('#btnSaveGrade').addEventListener('click', saveGrade);
  $('#btnExplain').addEventListener('click', runExplainMissing);

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      el.closest('.modal').hidden = true;
    });
  });

  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal').forEach((m) => {
      m.hidden = true;
    });
  });
}

async function init() {
  try {
    state.knowledge = await api('/api/knowledge');
    state.network = await api('/api/network').catch(() => null);
    $('#fModule').innerHTML = state.knowledge.modules
      .map((m) => `<option value="${m.id}">${m.id}. ${escapeHtml(m.name)}</option>`)
      .join('');
    bind();
    await refreshAll();
  } catch (err) {
    $('#list').innerHTML = `<div class="empty"><strong>加载失败</strong>${escapeHtml(err.message)}</div>`;
  }
}

init();
