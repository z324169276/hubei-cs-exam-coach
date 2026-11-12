const SVG_NS = 'http://www.w3.org/2000/svg';

/* 版面常量：9 个模块按 3×3 排列，模块内知识点竖排 */
const VIEW_W = 1160;
const MARGIN = 16;
const BLOCK_W = 360;
const GAP_X = 24;
const GAP_Y = 20;
const PAD = 12;
const HEADER_H = 38;
const NODE_H = 26;
const NODE_GAP = 8;

const state = {
  graph: null,
  stats: null,
  statMap: new Map(),
  edgeRecords: [],
  nodeEls: new Map(),
  nodeTips: new Map(),
  selected: null,
};

const $ = (s) => document.querySelector(s);

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

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function shortName(name, max = 13) {
  const s = String(name || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function levelKey(level) {
  return { 薄弱: 'weak', 待巩固: 'fair', 掌握: 'solid' }[level] || 'none';
}

/* ---------- 图谱布局 ---------- */

function buildLayout() {
  const nodes = new Map();
  const blocks = [];
  const rows = [0, 1, 2].map((r) => state.graph.modules.slice(r * 3, r * 3 + 3));

  let y = MARGIN;
  for (const rowModules of rows) {
    const maxPoints = Math.max(...rowModules.map((m) => m.pointCount), 1);
    const blockH = PAD * 2 + HEADER_H + maxPoints * NODE_H + Math.max(maxPoints - 1, 0) * NODE_GAP;

    rowModules.forEach((m, col) => {
      const x = MARGIN + col * (BLOCK_W + GAP_X);
      blocks.push({ ...m, x, y, w: BLOCK_W, h: blockH });

      const points = state.graph.nodes.filter((n) => n.module === m.id);
      points.forEach((p, i) => {
        const nx = x + PAD;
        const ny = y + PAD + HEADER_H + i * (NODE_H + NODE_GAP);
        nodes.set(p.id, {
          ...p,
          x: nx,
          y: ny,
          w: BLOCK_W - PAD * 2,
          h: NODE_H,
          cx: nx + (BLOCK_W - PAD * 2) / 2,
          cy: ny + NODE_H / 2,
        });
      });
    });

    y += blockH + GAP_Y;
  }

  return { nodes, blocks, height: y - GAP_Y + MARGIN };
}

/** 取节点矩形边界上朝向对方的那一点，避免连线穿过节点文字 */
function boundaryPoint(node, target) {
  const dx = target.cx - node.cx;
  const dy = target.cy - node.cy;
  if (!dx && !dy) return { x: node.cx, y: node.cy };
  const sx = dx ? node.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? node.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: node.cx + dx * t, y: node.cy + dy * t };
}

function edgePath(a, b, sameModule) {
  const p1 = boundaryPoint(a, b);
  const p2 = boundaryPoint(b, a);

  if (sameModule) {
    const dy = Math.max(14, (p2.y - p1.y) * 0.5);
    return `M ${p1.x} ${p1.y} C ${p1.x} ${p1.y + dy}, ${p2.x} ${p2.y - dy}, ${p2.x} ${p2.y}`;
  }

  const dx = (p2.x - p1.x) * 0.45;
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}

function levelOf(id) {
  return state.statMap.get(id)?.level || '未测';
}

function paintNode(id) {
  const g = state.nodeEls.get(id);
  if (!g) return;
  g.classList.remove('lv-none', 'lv-weak', 'lv-fair', 'lv-solid');
  const level = levelOf(id);
  g.classList.add(`lv-${levelKey(level)}`);

  const tip = state.nodeTips.get(id);
  const stat = state.statMap.get(id);
  const point = state.graph.nodes.find((n) => n.id === id);
  if (tip && point) {
    const mastery = stat?.mastery === null || stat?.mastery === undefined ? '—' : `${Math.round(stat.mastery * 100)}%`;
    tip.textContent = `${id} ${point.name} · ${level}${stat?.attempts ? ` · 掌握度 ${mastery}（${stat.attempts} 次作答）` : ''}`;
  }
}

/* ---------- 图谱渲染 ---------- */

function renderGraph() {
  const svg = $('#graph');
  svg.innerHTML = '';
  if (!state.graph) {
    svg.setAttribute('viewBox', '0 0 800 120');
    const text = el('text', { x: 24, y: 64, 'font-size': '13', fill: '#6b7484' });
    text.textContent = '知识图谱加载失败，请刷新页面重试。';
    svg.appendChild(text);
    return;
  }

  const layout = buildLayout();
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${layout.height}`);

  const defs = el('defs');
  for (const [id, color] of [['arrow', '#c8d0de'], ['arrow-hl', '#2f6bff']]) {
    const marker = el('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '6',
      markerHeight: '6',
      orient: 'auto',
    });
    marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  for (const block of layout.blocks) {
    const g = el('g', { class: 'module' });
    g.appendChild(el('rect', { class: 'module-box', x: block.x, y: block.y, width: block.w, height: block.h, rx: 10 }));

    const title = el('text', { class: 'module-title', x: block.x + PAD, y: block.y + PAD + 15 });
    title.textContent = `模块${block.id} ${block.name}`;
    g.appendChild(title);

    const sub = el('text', { class: 'module-sub', x: block.x + PAD, y: block.y + PAD + 31 });
    sub.textContent = `${block.pointCount} 个知识点 · ${block.score} 分`;
    g.appendChild(sub);

    svg.appendChild(g);
  }

  const edgeLayer = el('g');
  state.edgeRecords = [];
  for (const edge of state.graph.edges) {
    const a = layout.nodes.get(edge.from);
    const b = layout.nodes.get(edge.to);
    if (!a || !b) continue;

    const sameModule = a.module === b.module;
    const path = el('path', {
      class: sameModule ? 'edge' : 'edge cross',
      d: edgePath(a, b, sameModule),
      'marker-end': 'url(#arrow)',
    });
    const tip = el('title');
    tip.textContent = `${edge.from} → ${edge.to}：${edge.note || ''}（强度 ${edge.strength}）`;
    path.appendChild(tip);
    edgeLayer.appendChild(path);
    state.edgeRecords.push({ ...edge, el: path });
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = el('g');
  state.nodeEls.clear();
  state.nodeTips.clear();

  for (const [id, node] of layout.nodes) {
    const g = el('g', { class: 'node lv-none', 'data-id': id });
    g.appendChild(el('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: 7 }));

    const text = el('text', { x: node.x + 10, y: node.y + NODE_H / 2 + 4 });
    text.textContent = `${id} ${shortName(node.name)}`;
    g.appendChild(text);

    const tip = el('title');
    g.appendChild(tip);
    state.nodeTips.set(id, tip);
    state.nodeEls.set(id, g);

    g.addEventListener('mouseenter', () => highlightNode(id));
    g.addEventListener('mouseleave', resetHighlight);
    g.addEventListener('click', () => selectPoint(id));
    nodeLayer.appendChild(g);
  }
  svg.appendChild(nodeLayer);

  for (const id of layout.nodes.keys()) paintNode(id);

  if (state.selected) {
    state.nodeEls.get(state.selected)?.classList.add('sel');
    renderDetail(state.selected);
  }
}

function highlightNode(id) {
  for (const rec of state.edgeRecords) {
    const related = rec.from === id || rec.to === id;
    rec.el.classList.toggle('hl', related);
    rec.el.classList.toggle('dim', !related);
    rec.el.setAttribute('marker-end', related ? 'url(#arrow-hl)' : 'url(#arrow)');
  }
}

function resetHighlight() {
  for (const rec of state.edgeRecords) {
    rec.el.classList.remove('hl', 'dim');
    rec.el.setAttribute('marker-end', 'url(#arrow)');
  }
}

function selectPoint(id) {
  state.selected = id;
  for (const [nid, g] of state.nodeEls) g.classList.toggle('sel', nid === id);
  renderDetail(id);
}

/* ---------- 详情面板 ---------- */

function renderDetail(id) {
  const point = state.graph.nodes.find((n) => n.id === id);
  if (!point) return;

  const pre = state.graph.edges.filter((e) => e.to === id);
  const next = state.graph.edges.filter((e) => e.from === id);
  const stat = state.statMap.get(id);
  const level = stat?.level || '未测';
  const mastery = stat?.mastery === null || stat?.mastery === undefined ? '—' : `${Math.round(stat.mastery * 100)}%`;

  const relRows = (edges, lookFor) =>
    edges.length
      ? edges
          .map((e) => {
            const otherId = lookFor === 'to' ? e.from : e.to;
            const other = state.graph.nodes.find((n) => n.id === otherId);
            return `<div class="rel-item"><span><span class="tag">${otherId}</span> ${escapeHtml(other?.name || '')}</span><span class="muted">强度 ${e.strength}</span></div>`;
          })
          .join('')
      : '<p class="muted">无</p>';

  $('#detail').innerHTML = `
    <h2>知识点详情</h2>
    <h3>${id} ${escapeHtml(point.name)}</h3>
    <p class="detail-meta">模块 ${point.module} · ${escapeHtml(point.moduleName)}</p>
    <div class="detail-stat">
      <div><b>${stat?.attempts || 0}</b>作答次数</div>
      <div><b>${mastery}</b>掌握度</div>
      <div><b>${level}</b>当前状态</div>
    </div>
    <h4>直接前置</h4>
    <div class="rel-list">${relRows(pre, 'to')}</div>
    <h4>直接后继</h4>
    <div class="rel-list">${relRows(next, 'from')}</div>
  `;
}

/* ---------- 诊断 ---------- */

function applyStats(data) {
  state.stats = data;
  state.statMap = new Map(data.points.map((p) => [p.id, p]));
  for (const id of state.nodeEls.keys()) paintNode(id);
  if (state.selected) renderDetail(state.selected);
}

function pathToRoot(weakId, rootId) {
  const limit = 5;
  const walk = (cur, depth, seen) => {
    if (cur === rootId) return [cur];
    if (depth >= limit) return null;
    const parents = state.graph.edges
      .filter((e) => e.to === cur)
      .sort((a, b) => b.strength - a.strength);
    for (const e of parents) {
      if (seen.has(e.from)) continue;
      const tail = walk(e.from, depth + 1, new Set(seen).add(e.from));
      if (tail) return [cur, ...tail];
    }
    return null;
  };
  return walk(weakId, 0, new Set([weakId]));
}

function chainHtml(cause) {
  const weakId = cause.forPoints[0];
  const path = pathToRoot(weakId, cause.id) || [weakId, cause.id];
  return path
    .map((pid) => {
      const node = state.graph.nodes.find((n) => n.id === pid);
      return `<span><b>${pid}</b> ${escapeHtml(node?.name || '')}</span>`;
    })
    .join('<span class="arrow">←</span>');
}

function renderDiagnose(data) {
  const body = $('#diagnoseBody');
  const s = data.summary;

  if (!data.scope.submissionCount) {
    body.innerHTML = `<div class="empty">
      <strong>还没有答卷数据，先让学生提交一次练习卷</strong>
      当前筛选（${escapeHtml(data.scope.name || '全部学生')}${data.scope.className ? ` · ${escapeHtml(data.scope.className)}` : ''}）没有找到可用的答卷记录。
    </div>`;
    return;
  }

  const weakPoints = data.points
    .filter((p) => p.level === '薄弱')
    .sort((a, b) => a.mastery - b.mastery);

  const weakRows = weakPoints.length
    ? weakPoints
        .map(
          (p) => `<div class="weak-row">
            <span class="weak-id">${p.id}</span>
            <span class="weak-name">${escapeHtml(p.name)}<span class="weak-module"> · 模块 ${p.module} ${escapeHtml(p.moduleName)}</span></span>
            <span class="bar"><i style="width:${Math.round(p.mastery * 100)}%"></i></span>
            <span class="weak-rate">${Math.round(p.mastery * 100)}% · ${p.attempts} 次</span>
          </div>`,
        )
        .join('')
    : '<p class="muted">本次统计没有薄弱知识点，保持得不错。</p>';

  const causeCards = data.rootCauses.length
    ? data.rootCauses
        .map(
          (c) => `<div class="cause-card">
            <div class="cause-chain">${chainHtml(c)}</div>
            <div class="cause-meta">
              <span>根因掌握度 ${Math.round(c.mastery * 100)}%</span>
              <span class="contrib">贡献值 ${c.contrib.toFixed(2)}</span>
              <span>拖累 ${c.forPoints.join('、')}</span>
            </div>
            ${c.note ? `<p class="cause-note">${escapeHtml(c.note)}</p>` : ''}
          </div>`,
        )
        .join('')
    : '<p class="muted">没有回溯到上游根因：可能前置知识点都已掌握，或前置还没有作答数据。</p>';

  const needsBlock = data.needsTesting.length
    ? `<section class="weak-card">
        <div class="section-head"><h2>待补测的前置知识点</h2><span class="muted">${data.needsTesting.length} 个</span></div>
        <div class="need-list">
          ${data.needsTesting
            .map(
              (n) => `<div class="need-item"><b>${n.id}</b> ${escapeHtml(n.name)}<span class="muted">${escapeHtml(n.reason)}</span></div>`,
            )
            .join('')}
        </div>
      </section>`
    : '';

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><span>${s.tested}</span><label>已测知识点</label></div>
      <div class="stat-box"><span>${s.tested ? `${Math.round(s.averageMastery * 100)}%` : '—'}</span><label>平均掌握度</label></div>
      <div class="stat-box"><span class="warn">${s.weak}</span><label>薄弱知识点</label></div>
      <div class="stat-box"><span>${s.untested}</span><label>未测知识点</label></div>
    </div>
    <section class="weak-card">
      <div class="section-head"><h2>薄弱知识点</h2><span class="muted">${weakPoints.length} 个</span></div>
      ${weakRows}
    </section>
    <section class="weak-card">
      <div class="section-head"><h2>根因链</h2><span class="muted">按贡献值排序，最多 5 条</span></div>
      <div class="cause-list">${causeCards}</div>
    </section>
    ${needsBlock}
  `;
}

async function runDiagnose() {
  const name = $('#dName').value.trim();
  const className = $('#dClass').value.trim();
  const status = $('#dStatus');
  const query = new URLSearchParams();
  if (name) query.set('name', name);
  if (className) query.set('className', className);

  status.textContent = '诊断中…';
  try {
    const data = await api(`/api/diagnose${query.toString() ? `?${query}` : ''}`);
    applyStats(data);
    renderDiagnose(data);
    status.textContent = `已统计 ${data.scope.submissionCount} 份答卷`;
  } catch (err) {
    status.textContent = '';
    $('#diagnoseBody').innerHTML = `<div class="empty"><strong>诊断失败</strong>${escapeHtml(err.message)}</div>`;
  }
}

/* ---------- 页签与启动 ---------- */

function switchTab(name) {
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  $('#tab-graph').hidden = name !== 'graph';
  $('#tab-diagnose').hidden = name !== 'diagnose';
}

async function boot() {
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
  $('#btnDiagnose').addEventListener('click', runDiagnose);
  $('#dName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runDiagnose();
  });
  $('#dClass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runDiagnose();
  });

  try {
    state.graph = await api('/api/graph');
  } catch (err) {
    state.graph = null;
    console.warn('[graph]', err.message);
  }
  renderGraph();
}

boot();
