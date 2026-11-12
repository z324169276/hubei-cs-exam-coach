import zlib from 'node:zlib';

/**
 * 轻量 PDF 提取：只用 Node 内置 zlib，不引入第三方库。
 * 返回：
 *   text   —— 文字层内容（Word/WPS 导出的 PDF 通常可读）
 *   pages  —— 按页序排列的扫描图 [{ index, data }]，每页取页面上最大的那张图
 *   images —— 所有内嵌 JPEG（页序解析失败时的兜底）
 */
export function extractPdf(buf) {
  const src = buf.toString('latin1');
  const objects = parseObjects(src);
  const fontMaps = buildFontMaps(objects);

  const chunks = [];

  for (const [num, body] of objects) {
    if (/\/Subtype\s*\/Image/.test(body)) continue;
    const stream = readStreamBytes(body);
    if (!stream) continue;

    const data = inflate(stream);
    if (!data) continue;
    const text = data.toString('latin1');

    if (text.includes('beginbfchar') || text.includes('beginbfrange')) continue;
    if (!text.includes('BT') || !/(Tj|TJ)/.test(text)) continue;

    chunks.push(contentToText(text, fontMaps));
  }

  const text = chunks
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, pages: resolvePageImages(objects), images: collectImages(objects) };
}

/* ---------- PDF 对象与字体 ---------- */

function parseObjects(src) {
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end === -1) break;
    objects.set(Number(m[1]), src.slice(start, end));
    re.lastIndex = end + 7;
  }
  return objects;
}

function readStreamBytes(body) {
  const i = body.indexOf('stream');
  if (i === -1) return null;
  let start = i + 'stream'.length;
  if (body[start] === '\r') start += 1;
  if (body[start] === '\n') start += 1;
  const end = body.indexOf('endstream', start);
  if (end === -1) return null;
  return Buffer.from(body.slice(start, end), 'latin1');
}

/** 字体资源名 → 该字体的 ToUnicode 映射，避免不同字体共用编码表时串字 */
function buildFontMaps(objects) {
  const cache = new Map();
  const maps = new Map();

  for (const body of objects.values()) {
    const fontRe = /\/Font\s*<<([\s\S]*?)>>/g;
    let fm;
    while ((fm = fontRe.exec(body))) {
      const pairRe = /\/([^\s/<>\[\]()]+)\s+(\d+)\s+0\s+R/g;
      let p;
      while ((p = pairRe.exec(fm[1]))) {
        const name = p[1];
        if (maps.has(name)) continue;
        const cmap = cmapForObject(Number(p[2]), objects, cache);
        if (cmap) maps.set(name, cmap);
      }
    }
  }
  return maps;
}

function cmapForObject(num, objects, cache) {
  if (cache.has(num)) return cache.get(num);

  let result = null;
  const body = objects.get(num);
  const ref = body && body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);

  if (ref) {
    const target = objects.get(Number(ref[1]));
    if (target) {
      const bytes = readStreamBytes(target);
      const data = bytes ? inflate(bytes) : Buffer.from(target, 'latin1');
      const text = data ? data.toString('latin1') : '';
      if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
        result = new Map();
        mergeCMap(result, text);
      }
    }
  }

  cache.set(num, result);
  return result;
}

/* ---------- 内容流 → 文本 ---------- */

const TOKEN_RE = /\/([^\s/<>\[\]()]+)|<([0-9A-Fa-f\s]*)>|\(((?:\\[\s\S]|[^\\()])*)\)|(-?\d*\.?\d+)|(\[|\])|([A-Za-z*'"]+)/g;

function contentToText(content, fontMaps) {
  const segments = [];
  let stack = [];
  let array = null;
  let cmap = null;
  let tmX = 0;
  let tmY = 0;
  let lmX = 0;
  let lmY = 0;
  let pending = '';
  let segX = 0;
  let segY = 0;

  const flush = () => {
    if (pending) segments.push({ x: segX, y: segY, text: pending });
    pending = '';
  };

  const append = (str) => {
    if (!str) return;
    pending += str;
  };

  const decode = (tok) => (tok.hex !== undefined ? decodeHex(tok.hex, cmap) : decodeLiteral(tok.lit));

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(content))) {
    const [, name, hex, lit, num, bracket, op] = m;

    if (name !== undefined) {
      stack.push({ name });
      continue;
    }
    if (hex !== undefined) {
      stack.push({ hex });
      continue;
    }
    if (lit !== undefined) {
      stack.push({ lit });
      continue;
    }
    if (num !== undefined) {
      stack.push(Number(num));
      continue;
    }
    if (bracket === '[') {
      array = [];
      continue;
    }
    if (bracket === ']') {
      stack.push(array || []);
      array = null;
      continue;
    }
    if (!op) continue;

    if (op === 'Tf') {
      const font = stack.find((v) => v && v.name);
      cmap = (font && fontMaps.get(font.name)) || null;
    } else if (op === 'Tm') {
      flush();
      const nums = stack.filter((v) => typeof v === 'number');
      if (nums.length >= 6) {
        tmX = nums[nums.length - 2];
        tmY = nums[nums.length - 1];
        lmX = tmX;
        lmY = tmY;
        segX = tmX;
        segY = tmY;
      }
    } else if (op === 'Td' || op === 'TD') {
      const nums = stack.filter((v) => typeof v === 'number');
      if (nums.length >= 2) {
        const tx = nums[nums.length - 2];
        const ty = nums[nums.length - 1];
        lmX += tx;
        lmY += ty;
        tmX = lmX;
        tmY = lmY;
        if (Math.abs(ty) > 0.5) {
          flush();
          segX = tmX;
          segY = tmY;
        }
      }
    } else if (op === 'T*' || op === 'BT' || op === 'ET') {
      flush();
      if (op === 'BT') {
        segX = tmX;
        segY = tmY;
      }
    } else if (op === 'Tj' || op === "'" || op === '"') {
      const tok = [...stack].reverse().find((v) => v && (v.hex !== undefined || v.lit !== undefined));
      if (tok) append(decode(tok));
      if (op !== 'Tj') flush();
    } else if (op === 'TJ') {
      const arr = [...stack].reverse().find((v) => Array.isArray(v));
      if (arr) {
        for (const item of arr) {
          if (typeof item === 'number') continue;
          append(decode(item));
        }
      }
    }

    stack = [];
    array = null;
  }

  flush();

  let out = '';
  let prevY = null;
  for (const seg of segments) {
    if (!seg.text) continue;
    if (prevY !== null && Math.abs(seg.y - prevY) > 2) out += '\n';
    else if (prevY !== null && seg.x - segX > 24 && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(seg.text)) out += ' ';
    out += seg.text;
    prevY = seg.y;
    segX = seg.x;
  }

  return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function decodeLiteral(s) {
  const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (all, g) =>
    map[g] !== undefined ? map[g] : String.fromCharCode(parseInt(g, 8)),
  );
}

function decodeHex(hex, cmap) {
  const clean = hex.replace(/\s+/g, '');
  let out = '';

  if (cmap && cmap.size) {
    for (let i = 0; i + 4 <= clean.length; i += 4) {
      out += cmap.get(clean.slice(i, i + 4).toLowerCase()) || '';
    }
    return out;
  }

  for (let i = 0; i + 2 <= clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32) out += String.fromCharCode(code);
  }
  return out;
}

function mergeCMap(cmap, text) {
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = re.exec(m[1]))) {
      cmap.set(p[1].toLowerCase().padStart(4, '0'), hexToStr(p[2]));
    }
  }

  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let p;
    while ((p = re.exec(m[1]))) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;

      if (p[3]) {
        const startChar = hexToStr(p[3]).charCodeAt(0);
        for (let c = lo; c <= hi; c += 1) {
          cmap.set(c.toString(16).padStart(4, '0'), String.fromCharCode(startChar + (c - lo)));
        }
      } else if (p[4]) {
        const items = [...p[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToStr(x[1]));
        items.forEach((val, i) => {
          if (lo + i <= hi) cmap.set((lo + i).toString(16).padStart(4, '0'), val);
        });
      }
    }
  }
}

function hexToStr(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

/* ---------- 扫描页内嵌图片 ---------- */

/** 取出一个图片对象的 JPEG 字节，太小的一般是 logo/水印 */
function imageDataOf(body) {
  if (!body || !/\/Subtype\s*\/Image/.test(body) || !/\/DCTDecode/.test(body)) return null;
  const stream = readStreamBytes(body);
  if (!stream) return null;

  let raw = stream;
  while (raw.length && (raw[raw.length - 1] === 10 || raw[raw.length - 1] === 13)) {
    raw = raw.subarray(0, raw.length - 1);
  }
  return raw.length > 4096 ? raw : null;
}

/** 兜底：按对象顺序收集所有内嵌 JPEG */
function collectImages(objects) {
  const images = [];
  for (const body of objects.values()) {
    const img = imageDataOf(body);
    if (img) images.push(img);
  }
  return images;
}

/**
 * 按 /Pages 的 Kids 顺序还原页序，每页只取页面上最大的那张图。
 * 直接按对象顺序取图会踩两个坑：页序错乱，以及把页眉 logo 当扫描页。
 */
function resolvePageImages(objects) {
  const kidsOrder = [];
  for (const body of objects.values()) {
    for (const m of body.matchAll(/\/Kids\s*\[([^\]]*)\]/g)) {
      for (const r of m[1].matchAll(/(\d+)\s+0\s+R/g)) kidsOrder.push(Number(r[1]));
    }
  }

  const pages = [];
  for (const [num, body] of objects) {
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(body)) pages.push({ num, body });
  }
  if (!pages.length) return [];

  pages.sort((a, b) => {
    const ia = kidsOrder.indexOf(a.num);
    const ib = kidsOrder.indexOf(b.num);
    if (ia === -1 && ib === -1) return a.num - b.num;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const result = [];
  const used = new Set();

  pages.forEach((page, i) => {
    const refs = xobjectRefs(page.body, objects);
    let best = null;

    for (const num of refs) {
      const img = imageDataOf(objects.get(num));
      if (img && (!best || img.length > best.data.length)) best = { num, data: img };
    }

    if (best && !used.has(best.num)) {
      used.add(best.num);
      result.push({ index: i + 1, data: best.data });
    }
  });

  return result;
}

/** 页面资源里的图片 XObject 引用；资源可能内联，也可能指向独立对象 */
function xobjectRefs(pageBody, objects) {
  let res = resourceDict(pageBody, objects);
  if (!res) {
    const parent = pageBody.match(/\/Parent\s+(\d+)\s+0\s+R/);
    if (parent) res = resourceDict(objects.get(Number(parent[1])) || '', objects);
  }
  if (!res) return [];

  const xo = dictAfter(res, 'XObject');
  if (!xo) return [];

  const refs = [];
  for (const r of xo.matchAll(/(\d+)\s+0\s+R/g)) refs.push(Number(r[1]));
  return refs;
}

function resourceDict(body, objects) {
  const m = /\/Resources\b/.exec(body);
  if (!m) return '';

  const tail = body.slice(m.index);
  const ref = tail.match(/^\/Resources\s+(\d+)\s+0\s+R/);
  if (ref) return objects.get(Number(ref[1])) || '';
  return readDict(tail, 0);
}

/** 从 from 位置取第一个配平的 << ... >>，嵌套字典也能完整取出 */
function readDict(text, from) {
  const start = text.indexOf('<<', from);
  if (start === -1) return '';

  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth += 1;
      i += 1;
    } else if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function dictAfter(text, key) {
  const m = new RegExp(`/${key}\\b`).exec(text);
  return m ? readDict(text, m.index) : '';
}

function inflate(raw) {
  try {
    return zlib.inflateSync(raw);
  } catch {
    try {
      return zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      return null;
    }
  }
}
