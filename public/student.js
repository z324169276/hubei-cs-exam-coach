const $ = (s) => document.querySelector(s);
const TYPE_LABEL = { single: '选择题', judge: '判断题', operation: '操作题' };

const state = { quiz: null, answers: {} };

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const paperId = location.pathname.split('/').filter(Boolean)[1] || '';

function renderQuestion(q) {
  const tag = `<div class="q-tags">
      <span class="q-tag">第 ${q.index} 题</span>
      <span class="q-tag type">${TYPE_LABEL[q.type] || q.type}</span>
    </div>`;

  let body = '';
  if (q.type === 'single') {
    body = `<div class="opts">${(q.options || [])
      .map(
        (o) => `<label class="opt">
          <input type="radio" name="${q.id}" value="${escapeHtml(o.key)}" />
          <span>${escapeHtml(o.key)}. ${escapeHtml(o.text)}</span>
        </label>`,
      )
      .join('')}</div>`;
  } else if (q.type === 'judge') {
    body = `<div class="judge">
      <label class="opt"><input type="radio" name="${q.id}" value="对" /><span>对</span></label>
      <label class="opt"><input type="radio" name="${q.id}" value="错" /><span>错</span></label>
    </div>`;
  } else {
    body = `<textarea class="op-area" name="${q.id}" placeholder="写出关键操作步骤或代码"></textarea>`;
  }

  return `<article class="q-card" data-id="${q.id}" data-type="${q.type}">
    ${tag}
    <div class="q-stem"><span class="num">${q.index}.</span>${escapeHtml(q.stem)}</div>
    ${body}
  </article>`;
}

function updateProgress() {
  const cards = [...document.querySelectorAll('.q-card')];
  let done = 0;
  for (const card of cards) {
    const id = card.dataset.id;
    const type = card.dataset.type;
    if (type === 'operation') {
      const area = card.querySelector('.op-area');
      if (area && area.value.trim()) done += 1;
    } else {
      const picked = card.querySelector(`input[name="${CSS.escape(id)}"]:checked`);
      if (picked) done += 1;
    }
  }
  $('#progress').textContent = `已答 ${done} / ${cards.length}`;
}

function collectAnswers() {
  const answers = {};
  for (const card of document.querySelectorAll('.q-card')) {
    const id = card.dataset.id;
    if (card.dataset.type === 'operation') {
      answers[id] = card.querySelector('.op-area').value.trim();
    } else {
      const picked = card.querySelector(`input[name="${CSS.escape(id)}"]:checked`);
      answers[id] = picked ? picked.value : '';
    }
  }
  return answers;
}

function renderResult(result) {
  const pending = result.details.filter((d) => d.ok === null).length;
  const wrong = result.details.filter((d) => d.ok === false).length;

  const items = result.details
    .map((d) => {
      const cls = d.ok === null ? 'pending' : d.ok ? 'ok' : 'bad';
      const badge = d.ok === null ? '待批改' : d.ok ? '正确' : '错误';
      const rows = [];

      if (d.type === 'operation') {
        rows.push(`<div class="r-line mine">你的作答：${d.your ? escapeHtml(d.your) : '<span style="color:#9aa2b1">未作答</span>'}</div>`);
        rows.push(`<div class="r-line right">参考答案：<br />${escapeHtml(d.answer || '暂无')}</div>`);
      } else {
        rows.push(`<div class="r-line mine">你的答案：<b>${escapeHtml(d.your || '未作答')}</b></div>`);
        rows.push(`<div class="r-line right">正确答案：<b>${escapeHtml(d.answer || '暂无')}</b></div>`);
      }

      const analysis = d.analysis
        ? `<div class="r-analysis">${escapeHtml(d.analysis)}</div>`
        : '';

      return `<div class="r-item ${cls}">
        <div class="r-head"><span class="badge ${cls}">${badge}</span><span>第 ${d.index} 题 · ${TYPE_LABEL[d.type] || d.type}</span></div>
        <div class="r-stem">${escapeHtml(d.stem)}</div>
        ${rows.join('')}
        ${analysis}
      </div>`;
    })
    .join('');

  const rate = result.rate || 0;
  $('#result').innerHTML = `
    <div class="score-card">
      <div class="rate">${rate}%</div>
      <div class="sub">客观题答对 ${result.correct} / ${result.autoTotal}${pending ? ` · ${pending} 道操作题待批改` : ''}${wrong ? ` · 错 ${wrong} 道` : ''}</div>
      <div class="bar"><i style="width:${rate}%"></i></div>
    </div>
    ${items}
    <div class="r-actions">
      <button type="button" id="btnWrong">我的错题本</button>
      <button type="button" id="btnRetry">重新作答</button>
      <button type="button" class="primary" id="btnTop">回到顶部</button>
    </div>`;

  $('#result').hidden = false;

  $('#btnWrong').addEventListener('click', () => { location.href = '/wrong'; });
  $('#btnRetry').addEventListener('click', () => location.reload());
  $('#btnTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

/** 把这次提交记到本机，供「我的错题本」回看 */
function saveRecord(data) {
  try {
    const list = JSON.parse(localStorage.getItem('hubei-wrongbook') || '[]');
    list.unshift({
      paperId,
      subId: data.id,
      title: ($('#paperTitle').textContent || '练习卷').trim(),
      rate: data.rate || 0,
      at: Date.now(),
    });
    localStorage.setItem('hubei-wrongbook', JSON.stringify(list.slice(0, 50)));
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

async function submit() {
  const btn = $('#btnSubmit');
  btn.disabled = true;
  btn.textContent = '提交中…';

  try {
    const res = await fetch(`/api/quiz/${encodeURIComponent(paperId)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#sName').value.trim(),
        className: $('#sClass').value.trim(),
        answers: collectAnswers(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '提交失败');

    $('#quiz').hidden = true;
    $('#identityCard').hidden = true;
    $('#submitBar').hidden = true;
    renderResult(data);
    saveRecord(data);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = '提交答卷';
  }
}

function showError(message) {
  $('#paperTitle').textContent = '练习卷';
  document.querySelector('.s-main').innerHTML = `<div class="error-card"><strong>无法打开这份练习卷</strong>${escapeHtml(message)}</div>`;
  $('#submitBar').hidden = true;
}

async function init() {
  if (!paperId) return showError('链接不完整');

  try {
    const res = await fetch(`/api/quiz/${encodeURIComponent(paperId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '练习卷不存在');

    state.quiz = data;
    document.title = data.title;

    const total = data.items.length;
    const modules = [...new Set(data.items.map((it) => it.module))].length;

    $('#paperTitle').textContent = data.title;
    $('#paperMeta').textContent = `共 ${total} 题 · 覆盖 ${modules} 个模块 · 提交后自动判分`;
    $('#quiz').innerHTML = data.items.map(renderQuestion).join('');
    $('#submitBar').hidden = false;
    updateProgress();

    $('#quiz').addEventListener('change', updateProgress);
    $('#quiz').addEventListener('input', (e) => {
      if (e.target.classList.contains('op-area')) updateProgress();
    });
    $('#btnSubmit').addEventListener('click', submit);
  } catch (err) {
    showError(err.message);
  }
}

init();
