/**
 * 政府债（地方政府债）月末收益率数据集生成器（增量版）
 * ------------------------------------------------------------
 * 直接抓取中国债券信息网 yield.chinabond.com.cn（qxmc=2，财政部-中国地方政府债券
 * 收益率曲线）。Node 服务端抓取无浏览器 CORS 限制，无需本地代理。
 *
 * 产出： gov_bond_month_end.json
 *   {
 *     "meta": { generatedAt, curveName, terms, source, note },
 *     "points": [ {date, kind:'month'|'lastyear'|'today', rates:{1:..,2:..,..,30:..}}, ... ]
 *   }
 *
 * 增量策略（日常每天跑时）：
 *   - 读取仓库已有 JSON，历史月末/上年末全部保留，不做重算；
 *   - 只刷新 2 个点：
 *      ①「最新交易日」(today = 当前日期向前回溯到最近交易日)；
 *      ②「上月末」(previous month-end = 上月最后日历日向前回溯到最近交易日，覆盖/补入该点)。
 *   - 每次仅 2 个请求，极省额度、且避开中债网海外访问压力。
 *   - 跨月时上月末会自动刷新（如 10 月跑会刷新 9 月末）；历史数据永不被重算。
 *   仅在「无旧数据 / 首次运行」时走全量（START_YEAR 起），保证历史完整。
 *
 * 用法（在本目录执行）：
 *   node gen_gov_bond_data.js            # 增量更新（已有 JSON）或全量（无 JSON）
 *   START_YEAR=2022 node gen_gov_bond_data.js
 *
 * 生成后把 gov_bond_month_end.json 推送到你的 GitHub 仓库，
 * 平台即可「联网生成」（打开即自动从 raw.githubusercontent.com 拉取，无需代理）。
 */
const fs = require('fs');
const path = require('path');

const TARGET_TERMS = [1, 2, 3, 5, 7, 10, 15, 20, 30];
const QXMC = '2'; // 仅地方政府债
const CZB_XY = 'https://yield.chinabond.com.cn/cbweb-czb-web/czb/czbQueryXy?zblx=xy&workTime=';
const START_YEAR = parseInt(process.env.START_YEAR || '2020', 10);

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://gks.mof.gov.cn/gzsylqs/',
};

function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function lastCalDay(y, m) { return new Date(y, m + 1, 0); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 从 czbQueryXy 响应中挑出地方政府债曲线对象
function pickCurveObj(json) {
  if (!Array.isArray(json) || !json.length) return null;
  return json.find(o => /地方政府/.test(o.ycDefName || '')) || null;
}

// 把细网格曲线线性插值到 9 个标准期限
function parseTerms(json) {
  const obj = pickCurveObj(json);
  if (!obj || !Array.isArray(obj.seriesData) || !obj.seriesData.length) return null;
  const sd = obj.seriesData
    .map(p => [+p[0], +p[1]])
    .filter(p => isFinite(p[0]) && isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);
  if (sd.length < 2) return null;
  const terms = {};
  TARGET_TERMS.forEach(tt => {
    let val = null;
    const hit = sd.find(p => Math.abs(p[0] - tt) < 1e-6);
    if (hit) val = hit[1];
    else {
      for (let i = 0; i < sd.length - 1; i++) {
        if (sd[i][0] <= tt && tt <= sd[i + 1][0]) {
          const span = sd[i + 1][0] - sd[i][0];
          if (span > 1e-9) val = sd[i][1] + (sd[i + 1][1] - sd[i][1]) * (tt - sd[i][0]) / span;
          break;
        }
      }
    }
    if (val != null && isFinite(val) && val > 0) terms[tt] = +val.toFixed(4);
  });
  return Object.keys(terms).length >= 5 ? terms : null;
}

// 抓取指定日期的曲线；返回 {date, rates} 或 null（非交易日/无数据）
async function fetchDay(ds) {
  const url = CZB_XY + ds + '&qxmc=' + QXMC;
  try {
    const r = await fetch(url, { headers: H });
    if (!r.ok) return null;
    const t = await r.text();
    if (!t || t.trim().charAt(0) !== '[') return null;
    return parseTerms(JSON.parse(t));
  } catch (e) {
    return null;
  }
}

// 从某自然日向前回溯 maxBack 天，找到第一个有数据的交易日
async function backtrack(ds, maxBack) {
  const base = new Date(ds + 'T00:00:00');
  for (let b = 0; b < maxBack; b++) {
    const d = new Date(base);
    d.setDate(d.getDate() - b);
    const dd = iso(d);
    const rates = await fetchDay(dd);
    if (rates) return { date: dd, rates };
  }
  return null;
}

// 简单并发池
async function pool(fns, limit) {
  const out = new Array(fns.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= fns.length) return;
      try { out[idx] = await fns[idx](); } catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, fns.length)) }, () => worker()));
  return out;
}

(async () => {
  const today = new Date();
  const todayIso = iso(today);
  const file = path.join(__dirname, 'gov_bond_month_end.json');

  // 读取已有数据（增量基础）
  let oldPoints = [];
  let oldMeta = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw.points)) oldPoints = raw.points;
    oldMeta = raw.meta || null;
  } catch (e) { /* 首次运行无文件 */ }

  const existing = new Map();
  oldPoints.forEach(p => { if (p && p.date) existing.set(p.date, p); });

  const isIncremental = existing.size > 0;
  console.log('=== 政府债数据集生成（' + (isIncremental ? '增量' : '全量') + '）===');
  console.log('当前日期:', todayIso, ' 已有时点:', existing.size);

  let newToday = null;
  const extraTasks = [];

  if (isIncremental) {
    // 1) 刷新「最新交易日」(today)：当前日期向前回溯到最近交易日
    const latest = await backtrack(todayIso, 12);
    if (!latest) { console.error('未能获取最新交易日，退出'); process.exit(1); }
    newToday = { date: latest.date, kind: 'today', rates: latest.rates };
    // 移除旧的 today 点，保证全序列只有一个「当日」
    for (const [k, v] of existing) if (v.kind === 'today') existing.delete(k);
    existing.set(newToday.date, newToday);
    console.log('→ 已更新最新交易日', newToday.date);

    // 2) 刷新「上月末」(previous month-end)：重新抓取上月最后日历日对应的交易日，
    //    覆盖/补入该点（kind 沿用既有 lastyear，否则为 month）。仅 1 个请求，跨月后确保上月末为最终值。
    const pmY = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
    const pmM = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
    const prevMonthEnd = iso(lastCalDay(pmY, pmM));
    const pm = await backtrack(prevMonthEnd, 8);
    if (pm) {
      const prev = existing.get(prevMonthEnd);
      const kind = (prev && prev.kind === 'lastyear') ? 'lastyear' : 'month';
      existing.set(prevMonthEnd, { date: prevMonthEnd, kind, rates: pm.rates });
      console.log('→ 已更新上月末', prevMonthEnd, ' kind=' + kind);
    } else {
      console.log('⚠️ 上月末', prevMonthEnd, '抓取失败，保留既有值');
    }
  } else {
    // 全量（首次 / 无旧数据）：从 START_YEAR 起重算所有月末 + 最新交易日 + 上年末
    const latest = await backtrack(todayIso, 12);
    if (!latest) { console.error('未能获取最新交易日，退出'); process.exit(1); }
    newToday = { date: latest.date, kind: 'today', rates: latest.rates };

    for (let y = START_YEAR; y <= today.getFullYear(); y++) {
      const months = (y === today.getFullYear()) ? today.getMonth() : 12;
      for (let m = 0; m < months; m++) {
        const ld = lastCalDay(y, m);
        if (ld > today) continue;
        extraTasks.push({ ds: iso(ld), run: () => backtrack(iso(ld), 8) });
      }
    }
    const ly = await backtrack(iso(lastCalDay(START_YEAR - 1, 11)), 8);
    if (ly) existing.set(ly.date, { date: ly.date, kind: 'lastyear', rates: ly.rates });
  }

  if (extraTasks.length) {
    console.log('→ 补抓 ' + extraTasks.length + ' 个缺失/最新月末（并发 5）...');
    const res = await pool(extraTasks.map(t => t.run), 5);
    extraTasks.forEach((t, i) => { if (res[i]) existing.set(t.ds, { date: t.ds, kind: 'month', rates: res[i].rates }); });
  } else {
    console.log('→ 无需补抓历史月末，仅更新「当日」');
  }

  const dedup = [...existing.values()].sort((a, b) => a.date < b.date ? -1 : 1);

  const out = {
    meta: oldMeta || {
      generatedAt: todayIso,
      curveName: '财政部-中国地方政府债券收益率曲线',
      terms: TARGET_TERMS,
      source: '中国债券信息网 yield.chinabond.com.cn (qxmc=2)',
      note: '地方政府债月末收益率(%)；月末取当月最后可得交易日；today 为最新交易日',
    },
    points: dedup,
  };
  out.meta.generatedAt = todayIso;

  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  const months = dedup.filter(p => p.kind === 'month').length;
  console.log('✅ 写入', file);
  console.log('   时点总数:', dedup.length, ' 月末:', months, ' 上年末:', dedup.filter(p => p.kind === 'lastyear').length, ' 当日:', newToday.date);
  console.log('   覆盖:', dedup[0].date, '~', dedup[dedup.length - 1].date);
})().catch(e => { console.error('生成失败:', e); process.exit(1); });
