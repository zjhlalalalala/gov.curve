/**
 * 政府债（地方政府债）月末收益率数据集生成器
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
 * 用法（在本目录执行）：
 *   node gen_gov_bond_data.js            # 生成 2020-01 ~ 至今
 *   START_YEAR=2022 node gen_gov_bond_data.js
 *
 * 生成后把 gov_bond_month_end.json 推送到你的 GitHub 仓库，
 * 平台即可「联网生成」（打开即自动从 raw.githubusercontent.com 拉取，无需代理）。
 * GitHub Actions 会每月 1 号自动执行本脚本并写回仓库。
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
  console.log('=== 政府债月末数据集生成 ===');
  console.log('起始年份:', START_YEAR, ' 当前日期:', todayIso);

  // 1) 最新交易日（今日向前回溯，最多 12 天）
  console.log('→ 定位最新交易日 ...');
  const latest = await backtrack(todayIso, 12);
  if (!latest) { console.error('未能获取最新交易日，退出'); process.exit(1); }
  console.log('  最新交易日 =', latest.date);

  // 2) 各月末（含上年末）
  const tasks = [];
  for (let y = START_YEAR; y <= today.getFullYear(); y++) {
    const months = (y === today.getFullYear()) ? today.getMonth() : 12; // 当年只到当前月
    for (let m = 0; m < months; m++) {
      const ld = lastCalDay(y, m);
      if (ld > today) continue;
      tasks.push({ key: iso(ld), run: () => backtrack(iso(ld), 8) });
    }
  }
  console.log('→ 抓取 ' + tasks.length + ' 个潜在月末（并发 5）...');
  const results = await pool(tasks.map(t => t.run), 5);

  const points = [];
  // 上年末
  const lastYearDec = backtrack(iso(lastCalDay(START_YEAR - 1, 11)), 8);
  const ly = await lastYearDec;
  if (ly) points.push({ date: ly.date, kind: 'lastyear', rates: ly.rates });

  tasks.forEach((t, i) => {
    const r = results[i];
    if (r) points.push({ date: r.date, kind: 'month', rates: r.rates });
  });
  // 最新交易日作为 today
  points.push({ date: latest.date, kind: 'today', rates: latest.rates });

  // 去重（按 date），today 优先
  const byDate = new Map();
  points.forEach(p => { byDate.set(p.date, p); });
  const dedup = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);

  const out = {
    meta: {
      generatedAt: todayIso,
      curveName: '财政部-中国地方政府债券收益率曲线',
      terms: TARGET_TERMS,
      source: '中国债券信息网 yield.chinabond.com.cn (qxmc=2)',
      note: '地方政府债月末收益率(%)；月末取当月最后可得交易日；today 为最新交易日',
    },
    points: dedup,
  };

  const file = path.join(__dirname, 'gov_bond_month_end.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  const months = dedup.filter(p => p.kind === 'month').length;
  console.log('✅ 写入', file);
  console.log('   时点总数:', dedup.length, ' 月末:', months, ' 上年末:', dedup.filter(p => p.kind === 'lastyear').length, ' 当日:', latest.date);
  console.log('   覆盖:', dedup[0].date, '~', dedup[dedup.length - 1].date);
})().catch(e => { console.error('生成失败:', e); process.exit(1); });
