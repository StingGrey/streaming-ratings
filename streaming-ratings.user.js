// ==UserScript==
// @name         流媒体评分助手（IMDb / 烂番茄 / Metacritic / 豆瓣）
// @namespace    https://github.com/StingGrey/streaming-ratings
// @version      0.3.0
// @homepageURL  https://github.com/StingGrey/streaming-ratings
// @supportURL   https://github.com/StingGrey/streaming-ratings/issues
// @updateURL    https://raw.githubusercontent.com/StingGrey/streaming-ratings/main/streaming-ratings.user.js
// @downloadURL  https://raw.githubusercontent.com/StingGrey/streaming-ratings/main/streaming-ratings.user.js
// @description  在 Netflix、Disney+、HBO Max 的影片详情页自动显示 IMDb、烂番茄、Metacritic、豆瓣评分（MDBList 或 OMDb）
// @match        *://*.netflix.com/*
// @match        *://*.disneyplus.com/*
// @match        *://*.hbomax.com/*
// @match        *://*.max.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @connect      api.mdblist.com
// @connect      www.omdbapi.com
// @connect      v3.sg.media-imdb.com
// @connect      movie.douban.com
// @connect      search.douban.com
// @connect      www.wikidata.org
// @connect      zh.wikipedia.org
// @connect      v3-cinemeta.strem.io
// @connect      cinemeta-live.strem.io
// @connect      cinemeta-catalogs.strem.io
// @connect      api.tvmaze.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 测试钩子：node 下注入 __SR_TEST__ 时只导出查询逻辑，不碰 DOM
  const TEST = typeof __SR_TEST__ !== 'undefined' ? __SR_TEST__ : null;

  const SEARCH_TTL = 7 * 24 * 3600 * 1000; // 片名 → 条目的匹配结果
  const RATING_TTL = 24 * 3600 * 1000; // 评分本身
  const MISS_TTL = 6 * 3600 * 1000; // 没搜到的，过一阵再试

  // ---------------------------------------------------------------- 网络 & 缓存

  function request(url, asText) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        headers: { Accept: asText ? 'text/html' : 'application/json' },
        onload: (r) => {
          if (asText) return resolve({ status: r.status, data: r.responseText || '' });
          let data;
          try {
            data = JSON.parse(r.responseText);
          } catch {
            return reject(new Error(`HTTP ${r.status}，返回的不是 JSON`));
          }
          resolve({ status: r.status, data });
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function cacheGet(key) {
    const e = GM_getValue('c:' + key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      GM_deleteValue('c:' + key);
      return undefined;
    }
    return e.v;
  }

  // 只缓存成功的结果（含"没找到"）；抛错不缓存，下次重试
  async function cached(key, ttl, fn) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
    const v = await fn();
    GM_setValue('c:' + key, { v, exp: Date.now() + (v == null ? MISS_TTL : ttl) });
    return v;
  }

  function clearCache() {
    for (const k of GM_listValues()) if (k.startsWith('c:')) GM_deleteValue(k);
  }

  // 脚本升级后自动清缓存，免得旧版本缓存的"没找到"挡住新的匹配逻辑
  (function clearCacheOnUpgrade() {
    const ver = typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : null;
    if (!ver || GM_getValue('cacheVer') === ver) return;
    clearCache();
    GM_setValue('cacheVer', ver);
  })();

  // ---------------------------------------------------------------- 匹配

  function norm(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, 'and')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function titleScore(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 4;
    if (x.includes(y) || y.includes(x)) return 1.5;
    return 0;
  }

  const TV_QIDS = new Set(['tvSeries', 'tvMiniSeries']);
  const OK_QIDS = new Set(['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie', 'tvSpecial', 'video']);

  // IMDb 自家的搜索联想接口，免 key，用来把片名换成 tt 编号
  async function searchImdb(title, year, kind) {
    const q = title.trim().slice(0, 100);
    if (!q) return null;
    const { data } = await request(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`);
    const items = (data.d || []).filter((x) => /^tt\d+$/.test(x.id) && (!x.qid || OK_QIDS.has(x.qid)));

    // 中日韩片名（如「鱿鱼游戏」）IMDb 返回的是英文名，字面对不上，只能信它排在前面的结果
    const foreign = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title);
    let best = null;
    let bestScore = -Infinity;
    items.forEach((x, i) => {
      let ts = titleScore(x.l, title);
      if (!ts) {
        if (!foreign || i > 2) return; // 名字完全对不上的不要，宁可走豆瓣兜底
        ts = 1;
      }
      const isTv = TV_QIDS.has(x.qid);
      let s = ts - i * 0.3; // 保留 IMDb 自身的相关度排序
      if (kind) s += (kind === 'show') === isTv ? 2 : -2;
      if (year && x.y) {
        const d = Math.abs(x.y - year);
        // 剧集页面上的年份常是最新一季，落在播出区间内也算对
        const range = /^(\d{4})[-–](\d{4})?/.exec(x.yr || '');
        const inRange = isTv && range && year >= +range[1] && year <= (+range[2] || 9999);
        s += d === 0 ? 3 : d === 1 || inRange ? 2 : -Math.min(d, 6) * 0.5;
      }
      if (s > bestScore) {
        bestScore = s;
        best = x;
      }
    });
    if (!best) return null;
    return { id: best.id, title: best.l, year: best.y || null, type: TV_QIDS.has(best.qid) ? 'show' : 'movie' };
  }

  const SEASON_RE = /\s*第[一二三四五六七八九十百\d]+季\s*$/;

  async function searchDouban(title, year) {
    const { data } = await request(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title.trim())}`);
    const items = Array.isArray(data) ? data.filter((x) => x.type === 'movie' && x.id) : [];

    let best = null;
    let bestScore = -Infinity;
    items.forEach((x, i) => {
      const ts = Math.max(titleScore(x.title.replace(SEASON_RE, ''), title), titleScore(x.sub_title, title));
      if (!ts) return;
      let s = ts - i * 0.3;
      const y = parseInt(x.year, 10);
      if (year && y) s += y === year ? 3 : Math.abs(y - year) === 1 ? 1 : -1;
      if (/第一季$/.test(x.title)) s += 0.5; // 剧集年份对不上时默认第一季
      if (s > bestScore) {
        bestScore = s;
        best = x;
      }
    });
    if (!best) return null;
    return { id: best.id, title: best.title, subTitle: best.sub_title || '', year: parseInt(best.year, 10) || null };
  }

  // 从 HTML 里抠出 `window.__DATA__ = {...};` 那段 JSON（按括号配对，考虑字符串转义）
  function extractJsonAfter(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // 豆瓣搜索页直接认 IMDb 编号，比按片名搜准得多（英文名在 suggest 接口里经常搜不到）
  async function doubanSearchPage(q) {
    const { data } = await request(
      `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(q)}&cat=1002`,
      true,
    );
    const d = extractJsonAfter(data, 'window.__DATA__');
    // 请求太频繁会被跳到 sec.douban.com 人机验证页；抛错而不是返回空，免得把"没找到"缓存下来
    if (!d) throw new Error('豆瓣搜索页被限流，稍后再试');
    return ((d && d.items) || []).filter((it) => it.tpl_name === 'search_subject' && it.id);
  }

  function doubanItem(x) {
    const v = x.rating && x.rating.value;
    return {
      id: String(x.id),
      title: x.title || '',
      rate: v ? Number(v).toFixed(1) : '',
      url: x.url || `https://movie.douban.com/subject/${x.id}/`,
    };
  }

  async function searchDoubanByImdb(tt) {
    const x = (await doubanSearchPage(tt))[0];
    return x ? doubanItem(x) : null;
  }

  // 豆瓣兜底：suggest 接口搜不到时，用完整搜索页按片名搜（英文名也认）
  async function searchDoubanPage(title, year, kind) {
    const q = norm(title);
    if (!q) return null;
    const items = (await doubanSearchPage(title.trim())).slice(0, 6);
    let best = null;
    let bestD = Infinity;
    for (const it of items) {
      if (!norm(it.title).includes(q)) continue;
      const m = /\((\d{4})\)/.exec(it.title);
      const y = m ? +m[1] : null;
      // 豆瓣会收未播出的占位条目（年份写到 2040 之类），一律跳过
      if (y && y > new Date().getFullYear() + 1) continue;
      let d = 0;
      if (year && y) {
        // 电影卡 ±1 年；剧集页面年份常是最新一季，只要求不晚于它，越接近越好
        if (kind === 'show' ? y > year + 1 : Math.abs(y - year) > 1) continue;
        d = Math.abs(y - year);
      }
      // 名字完全一致（去掉季数）优先
      if (norm(it.title.replace(/\(\d{4}\)\s*$/, '')) !== q) d += 0.5;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best ? doubanItem(best) : null;
  }

  // 播出年份区间，如 "2021–2025" / "2023-" / "2010"
  function yearRange(s) {
    const m = /^(\d{4})(?:\s*[-–]\s*(\d{4})?)?/.exec(s || '');
    if (!m) return null;
    const a = +m[1];
    return [a, /[-–]/.test(m[0]) ? +m[2] || 9999 : a];
  }

  // Cinemeta（Stremio 的公开元数据服务，免 key）：片名搜索带别名，中文名也常能搜到
  const CM = 'https://v3-cinemeta.strem.io';
  async function searchCinemeta(title, year, kind) {
    const q = title.trim().slice(0, 100);
    if (!q) return null;
    const types = kind === 'show' ? ['series'] : kind === 'movie' ? ['movie'] : ['series', 'movie'];
    let best = null;
    let bestScore = -Infinity;
    for (const t of types) {
      const { data } = await request(`${CM}/catalog/${t}/top/search=${encodeURIComponent(q)}.json`);
      ((data && data.metas) || []).slice(0, 5).forEach((m, i) => {
        const id = m.imdb_id || m.id;
        if (!/^tt\d+$/.test(id || '')) return;
        const ts = titleScore(m.name, title);
        const r = yearRange(m.releaseInfo);
        const yearOk = year && r ? year >= r[0] - 1 && year <= r[1] + 1 : null;
        // 名字对不上（译名）时只信前两条、且首播年份几乎一致的，不然开放区间（如 2007–）会捞到无关老剧
        if (!ts && (i > 1 || !r || !year || Math.abs(r[0] - year) > 1)) return;
        if (ts && yearOk === false) return;
        const s = (ts || 1) - i * 0.3 + (yearOk ? 2 : 0);
        if (s > bestScore) {
          bestScore = s;
          best = { id, title: m.name || '', year: r ? r[0] : null, type: t === 'series' ? 'show' : 'movie' };
        }
      });
    }
    return best;
  }

  // Cinemeta 的条目详情带 imdbRating，没填 key 或 MDBList/OMDb 出错时拿来兜 IMDb 分
  async function cinemetaMeta(imdb) {
    // 类型猜错时 Cinemeta 照样回同一个编号，评分是对的，但片名/年份会是别的片
    const one = async (t) => {
      const { data } = await request(`${CM}/meta/${t}/${imdb.id}.json`).catch(() => ({ data: null }));
      const m = data && data.meta;
      if (!m || (m.imdb_id || m.id) !== imdb.id || !(m.imdbRating || m.name)) return null;
      const r = yearRange(m.releaseInfo);
      return { rating: m.imdbRating || '', name: m.name || '', year: r ? r[0] : null, type: t === 'series' ? 'show' : 'movie' };
    };
    if (imdb.type) return one(imdb.type === 'show' ? 'series' : 'movie');

    const [mv, sr] = await Promise.all([one('movie'), one('series')]);
    if (!mv || !sr) return mv || sr;
    if (norm(mv.name) === norm(sr.name)) return mv;
    // 两边片名不一致：有已知片名就按片名选，否则只要评分、不要片名
    if (imdb.title) return titleScore(sr.name, imdb.title) > titleScore(mv.name, imdb.title) ? sr : mv;
    return { rating: mv.rating || sr.rating, name: '', year: null, type: null };
  }

  // TVmaze：剧集专用，免 key，带 IMDb 编号；只认英文名
  async function searchTvmaze(title) {
    const q = title.trim().slice(0, 100);
    if (!q || !/[a-z]/i.test(q)) return null;
    const { status, data } = await request(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(q)}`).catch(
      () => ({ status: 404, data: null }),
    );
    if (status !== 200 || !data) return null;
    const tt = data.externals && data.externals.imdb;
    if (!/^tt\d+$/.test(tt || '') || !titleScore(data.name, title)) return null;
    return { id: tt, title: data.name, year: parseInt(data.premiered, 10) || null, type: 'show' };
  }

  // 中文维基：搜索会做繁简转换，再通过条目关联的 Wikidata 拿 IMDb 编号
  async function searchZhwiki(title) {
    const q = title.trim().slice(0, 100);
    if (!q) return null;
    const { data } = await request(
      'https://zh.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&generator=search' +
        `&gsrnamespace=0&gsrlimit=4&prop=pageprops&ppprop=wikibase_item&gsrsearch=${encodeURIComponent(q)}`,
    );
    const pages = Object.values((data.query && data.query.pages) || {}).sort((a, b) => a.index - b.index);
    const ids = pages.map((p) => p.pageprops && p.pageprops.wikibase_item).filter(Boolean);
    return wdImdbFromIds(ids, title);
  }

  // Wikidata 兜底：港台译名 IMDb/豆瓣都搜不到时，Wikidata 往往收了 zh-hk / zh-tw 标签并关联 IMDb 编号
  // 用全文搜索而不是精确标签匹配，因为标签里常有多余空格（如「驚世轉捩點： 越戰」）
  const WD = 'https://www.wikidata.org/w/api.php?format=json&origin=*&';
  async function searchWikidata(title) {
    const q = title.trim().slice(0, 100);
    if (!q) return null;
    const { data: s } = await request(`${WD}action=query&list=search&srnamespace=0&srlimit=5&srsearch=${encodeURIComponent(q)}`);
    const ids = ((s.query && s.query.search) || []).map((x) => x.title).filter((t) => /^Q\d+$/.test(t));
    return wdImdbFromIds(ids, title);
  }

  // Wikidata「是一个」(P31) → 电影/剧集，给后面查评分用
  const WD_SHOW = new Set(['Q5398426', 'Q1259759', 'Q526877', 'Q63952888', 'Q15416', 'Q3464665', 'Q21191270']);
  const WD_MOVIE = new Set(['Q11424', 'Q24869', 'Q93204', 'Q202866', 'Q506240', 'Q226730', 'Q17517379']);
  const WD_LANGS = 'en|zh|zh-hans|zh-hant|zh-hk|zh-tw|zh-cn|ja|ko';

  // 搜索结果里常混着无关条目（比如「奧本海默」），必须有标签或别名和页面片名对得上
  async function wdImdbFromIds(ids, title) {
    if (!ids.length) return null;
    const { data: e } = await request(
      `${WD}action=wbgetentities&props=claims|labels|aliases&languages=${WD_LANGS}&ids=${ids.join('|')}`,
    );
    for (const id of ids) {
      const ent = e.entities && e.entities[id];
      const claim = ent && ent.claims && ent.claims.P345 && ent.claims.P345[0];
      const tt = claim && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
      if (!/^tt\d+$/.test(tt || '')) continue;
      const names = [
        ...Object.values(ent.labels || {}).map((l) => l.value),
        ...Object.values(ent.aliases || {}).flat().map((a) => a.value),
      ];
      if (title && !names.some((n) => titleScore(n, title) >= 4)) continue;
      const p31 = ((ent.claims && ent.claims.P31) || []).map((c) => c.mainsnak.datavalue && c.mainsnak.datavalue.value.id);
      const type = p31.some((q) => WD_SHOW.has(q)) ? 'show' : p31.some((q) => WD_MOVIE.has(q)) ? 'movie' : null;
      const en = ent.labels && ent.labels.en && ent.labels.en.value;
      return { id: tt, title: en || '', year: null, type };
    }
    return null;
  }

  async function doubanRating(id) {
    const { data } = await request(`https://movie.douban.com/j/subject_abstract?subject_id=${encodeURIComponent(id)}`);
    const s = data && data.subject;
    if (!s) return null;
    return { rate: s.rate || '', title: s.title || '', url: s.url || `https://movie.douban.com/subject/${id}/` };
  }

  // ---------------------------------------------------------------- 评分数据源

  const fmt1 = (v) => Number(v).toFixed(1);
  const pct = (v) => Math.round(Number(v)) + '%';
  const int = (v) => String(Math.round(Number(v)));

  // MDBList 的 source 名 → 统一字段
  const MDBLIST_MAP = {
    imdb: ['imdb', fmt1],
    tomatoes: ['rt', pct],
    popcorn: ['popcorn', pct],
    metacritic: ['mc', int],
    letterboxd: ['lb', fmt1],
  };

  async function mdblistRatings(imdb, key) {
    const types = imdb.type ? [imdb.type] : ['movie', 'show'];
    let data;
    let status;
    for (const t of types) {
      ({ status, data } = await request(
        `https://api.mdblist.com/imdb/${t}/${imdb.id}?apikey=${encodeURIComponent(key)}`,
      ));
      if (status !== 404) break;
    }
    if (status >= 400 || !data || data.error) {
      throw new Error('MDBList：' + ((data && (data.error || data.detail)) || 'HTTP ' + status));
    }
    const out = {};
    for (const r of data.ratings || []) {
      const m = MDBLIST_MAP[r.source];
      if (!m || r.value == null || r.value === 0) continue;
      // MDBList 给的是各站的相对路径，拼成直达链接（imdb 的 url 字段是排名数字，不用）
      let url = null;
      if (typeof r.url === 'string' && r.url.startsWith('/')) {
        if (r.source === 'tomatoes' || r.source === 'popcorn') url = 'https://www.rottentomatoes.com' + r.url;
        else if (r.source === 'letterboxd') url = 'https://letterboxd.com' + r.url;
        else if (r.source === 'metacritic') url = `https://www.metacritic.com/${data.type === 'show' ? 'tv' : 'movie'}${r.url}`;
      }
      out[m[0]] = { text: m[1](r.value), votes: r.votes || null, url };
    }
    return out;
  }

  async function omdbRatings(imdb, key) {
    const { data } = await request(`https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&i=${imdb.id}`);
    if (!data || data.Response === 'False' || data.response === 'False') {
      throw new Error('OMDb：' + ((data && (data.Error || data.error)) || '未知错误'));
    }
    const ok = (v) => v && v !== 'N/A';
    const out = {};
    if (ok(data.imdbRating)) out.imdb = { text: data.imdbRating, votes: data.imdbVotes };
    for (const r of data.Ratings || []) {
      if (r.Source === 'Rotten Tomatoes') out.rt = { text: r.Value };
      if (r.Source === 'Metacritic') out.mc = { text: r.Value.split('/')[0] };
    }
    if (!out.mc && ok(data.Metascore)) out.mc = { text: data.Metascore };
    return out;
  }

  function pickProvider() {
    const pref = GM_getValue('provider', 'auto');
    const mk = GM_getValue('mdblistKey', '');
    const ok = GM_getValue('omdbKey', '');
    const p = {
      mdblist: mk ? { name: 'mdblist', fetch: (im) => mdblistRatings(im, mk) } : null,
      omdb: ok ? { name: 'omdb', fetch: (im) => omdbRatings(im, ok) } : null,
    };
    if (pref === 'omdb') return p.omdb || p.mdblist;
    return p.mdblist || p.omdb; // auto / mdblist：MDBList 带爆米花和 Letterboxd，优先
  }

  // ---------------------------------------------------------------- 总流程

  const infoKey = (info) => `${norm(info.title)}|${info.year || ''}|${info.kind || ''}`;

  async function lookup(info) {
    const key = infoKey(info);
    const ov = GM_getValue('ov:' + key, {}); // 用户手动纠正过的匹配
    const doubanOn = GM_getValue('doubanEnabled', true);
    // 出错先记下来；最后某一项已经由别的源查到了，就不再显示那一项的报错
    const errs = [];
    const soft = (label, group) => (e) => {
      errs.push({ group, msg: `${label}：${e.message}` });
      return null;
    };
    const dbSearch = (t, y) => cached(`db:s:${norm(t)}|${y || ''}`, SEARCH_TTL, () => searchDouban(t, y));
    const imSearch = (t, y, k) => cached(`im:s:${norm(t)}|${y || ''}|${k || ''}`, SEARCH_TTL, () => searchImdb(t, y, k));

    // 豆瓣搜索和 IMDb 搜索并行；豆瓣结果还能给中文片名提供英文原名兜底
    const dbP = ov.douban
      ? Promise.resolve({ id: ov.douban })
      : doubanOn
        ? dbSearch(info.title, info.year).catch(soft('豆瓣', 'douban'))
        : Promise.resolve(null);

    let imdb = null;
    if (ov.imdb) {
      imdb = { id: ov.imdb, type: null, title: '', year: null };
    } else {
      imdb = await imSearch(info.title, info.year, info.kind).catch(soft('IMDb 搜索', 'imdb'));
      if (!imdb) {
        const db = await dbP;
        const alt = db && db.subTitle && norm(db.subTitle) !== norm(info.title) ? db.subTitle : null;
        if (alt) imdb = await imSearch(alt, info.year || db.year, info.kind).catch(soft('IMDb 搜索', 'imdb'));
      }
      // 兜底链：Cinemeta → TVmaze（剧集、英文名）→ 中文维基 → Wikidata，一个命中就停
      const nt = norm(info.title);
      const fallbacks = [
        ['Cinemeta', `cm:s:${nt}|${info.year || ''}|${info.kind || ''}`, () => searchCinemeta(info.title, info.year, info.kind)],
        ['TVmaze', `tm:s:${nt}`, () => (info.kind === 'movie' ? null : searchTvmaze(info.title))],
        ['中文维基', `zw:s:${nt}`, () => searchZhwiki(info.title)],
        ['Wikidata', `wd:s:${nt}`, () => searchWikidata(info.title)],
      ];
      for (const [label, ck, fn] of fallbacks) {
        if (imdb) break;
        imdb = await cached(ck, SEARCH_TTL, fn).catch(soft(label, 'imdb'));
      }
    }

    const provider = pickProvider();
    let ratings = {};
    if (imdb && provider) {
      ratings = (await cached(`r:${provider.name}:${imdb.id}`, RATING_TTL, () => provider.fetch(imdb)).catch(soft('评分', 'rating'))) || {};
    }
    // 没 key 或 MDBList/OMDb 出错时，用 Cinemeta 兜 IMDb 分；顺便补全 Wikidata/手动指定时缺的片名年份
    if (imdb && (!ratings.imdb || !imdb.title)) {
      const cm = await cached(`cm:m:${imdb.id}`, RATING_TTL, () => cinemetaMeta(imdb)).catch(soft('Cinemeta', 'rating'));
      if (cm) {
        if (!ratings.imdb && cm.rating) ratings = { ...ratings, imdb: { text: cm.rating, votes: null } };
        imdb = { ...imdb, title: imdb.title || cm.name, year: imdb.year || cm.year, type: imdb.type || cm.type };
      }
    }

    let douban = null;
    if (doubanOn || ov.douban) {
      // 优先用 IMDb 编号反查豆瓣；查不到再用片名搜索的结果
      if (!ov.douban && imdb) {
        douban = await cached(`db:tt:${imdb.id}`, RATING_TTL, () => searchDoubanByImdb(imdb.id)).catch(soft('豆瓣', 'douban'));
      }
      if (!douban) {
        // 搜索页被限流时，退回 suggest 接口（按片名，限流宽松得多）
        let db = await dbP;
        if (!db && imdb && imdb.title && norm(imdb.title) !== norm(info.title)) {
          db = await dbSearch(imdb.title, imdb.year || info.year).catch(soft('豆瓣', 'douban'));
        }
        if (db) {
          const r = await cached(`db:r:${db.id}`, RATING_TTL, () => doubanRating(db.id)).catch(soft('豆瓣评分', 'douban'));
          douban = { ...db, ...(r || {}) };
        }
      }
      // 最后用豆瓣完整搜索页按片名搜（页面片名、IMDb 英文名各试一次）
      if (!douban && !ov.douban) {
        const names = [info.title, imdb && imdb.title].filter((t, i, a) => t && a.findIndex((u) => norm(u) === norm(t)) === i);
        for (const t of names) {
          douban = await cached(`db:p:${norm(t)}|${info.year || ''}`, SEARCH_TTL, () => searchDoubanPage(t, info.year, info.kind)).catch(soft('豆瓣', 'douban'));
          if (douban) break;
        }
      }
    }

    const solved = { imdb: !!imdb, douban: !!douban, rating: !!ratings.imdb };
    const errors = errs.filter((e) => !solved[e.group]).map((e) => e.msg);
    return { imdb, ratings, douban, provider: provider ? provider.name : null, errors };
  }

  if (TEST) {
    Object.assign(TEST, {
      norm, searchImdb, searchDouban, searchDoubanByImdb, searchDoubanPage, searchCinemeta, cinemetaMeta,
      searchTvmaze, searchZhwiki, searchWikidata, doubanRating, lookup, infoKey,
    });
    return;
  }

  // ---------------------------------------------------------------- 页面识别

  function textOf(el) {
    if (!el) return '';
    return (el.getAttribute('alt') || el.getAttribute('aria-label') || el.textContent || '').trim();
  }

  function firstText(selectors, root) {
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        const t = textOf(el);
        if (t && t.length < 150) return { el, text: t };
      }
    }
    return null;
  }

  function findYear(...roots) {
    for (const r of roots) {
      if (!r) continue;
      const m = /\b(19[2-9]\d|20[0-4]\d)\b/.exec(r.innerText || r.textContent || '');
      if (m) return +m[1];
    }
    return null;
  }

  const SITE_NAME = /^(netflix|disney\+|hbo max|max)$/i;

  function cleanDocTitle() {
    const t = document.title
      .replace(/^(watch|观看|收看)\s+/i, '')
      .replace(/\s*[|\-–—•·]\s*(netflix|disney\+|hbo max|max)\s*$/i, '')
      .trim();
    return SITE_NAME.test(t) ? '' : t;
  }

  function guessKind(...roots) {
    const text = roots.map((r) => (r ? r.innerText || r.textContent || '' : '')).join(' ');
    if (/\b\d+\s+(seasons?|episodes?)\b|limited series|miniseries|\d+\s*季|共\s*\d+\s*集|剧集/i.test(text)) return 'show';
    return null;
  }

  // 每个站点：是不是详情页、片名/年份/类型、评分条插哪
  // 选择器是按各站当前的 DOM 写的，站点改版后片名会退回 document.title，插入位置退回右上角浮层
  const SITES = [
    {
      name: 'netflix',
      host: /(^|\.)netflix\.com$/,
      isDetail: () => /\/title\/\d+/.test(location.pathname) || new URLSearchParams(location.search).has('jbv'),
      extract() {
        const root =
          document.querySelector('.previewModal--container.detail-modal') ||
          document.querySelector('.detail-modal') ||
          document;
        const t = firstText(
          [
            '.previewModal--player-titleTreatment-logo',
            '[data-uia="previewModal--player-titleTreatment-logo"]',
            '.about-header strong',
            '[data-uia="title-info-title"]',
            'h1',
          ],
          root,
        );
        const meta = root.querySelector('.previewModal--detailsMetadata, .videoMetadata--container');
        const left = root.querySelector('.previewModal--detailsMetadata-left');
        return {
          title: (t && t.text) || cleanDocTitle(),
          year: findYear(root.querySelector('.videoMetadata--second-line .year, .year'), meta),
          kind: root.querySelector('.episodeSelector, [data-uia="episode-selector"]') ? 'show' : guessKind(meta),
          anchor: left || meta,
          mode: 'prepend',
        };
      },
    },
    {
      name: 'disney',
      host: /(^|\.)disneyplus\.com$/,
      isDetail: () => /\/(movies|series)\/|\/browse\/entity-|\/details\//.test(location.pathname),
      extract() {
        const t = firstText(
          [
            '[data-testid="details-title-treatment"] img',
            '[data-testid="title-treatment"] img',
            'img[data-testid*="title"]',
            '.title-treatment img',
            'h1',
          ],
          document,
        );
        const meta = document.querySelector(
          '[data-testid="details-metadata"], [data-testid="metadata"], [data-testid*="metadata"]',
        );
        const tabs = [...document.querySelectorAll('[role="tab"]')].map((e) => e.textContent).join(' ');
        const kind = /\/series\//.test(location.pathname) || /episodes|剧集|集数/i.test(tabs)
          ? 'show'
          : /\/movies\//.test(location.pathname) ? 'movie' : guessKind(meta);
        return {
          title: (t && t.text) || cleanDocTitle(),
          year: findYear(meta),
          kind,
          anchor: meta || (t && t.el.closest('div')),
          mode: 'after',
        };
      },
    },
    {
      name: 'hbomax',
      host: /(^|\.)(hbomax|max)\.com$/,
      isDetail: () => /\/(movie|movies|show|series|mini-series|feature|standalone)\//.test(location.pathname),
      extract() {
        const t = firstText(
          ['[data-testid$="_title"]', '[class*="TitleTreatment"] img', 'img[class*="Title"][alt]', 'h1'],
          document,
        );
        const meta = document.querySelector('[data-testid*="metadata"], [class*="Metadata"]');
        const p = location.pathname;
        const kind = /\/(show|series|mini-series)\//.test(p) ? 'show' : /\/(movie|movies|feature)\//.test(p) ? 'movie' : null;
        return {
          title: (t && t.text) || cleanDocTitle(),
          year: findYear(meta),
          kind: kind || guessKind(meta),
          anchor: meta || (t && t.el.parentElement),
          mode: 'after',
        };
      },
    },
  ];

  // ---------------------------------------------------------------- 评分条

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  const CSS = `
    :host { all: initial; }
    .box { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color: #fff; }
    .box.floating { background: rgba(18,18,18,.9); padding: 8px 10px; border-radius: 10px; margin: 0;
      box-shadow: 0 4px 20px rgba(0,0,0,.5); max-width: 440px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px 3px 3px; border-radius: 6px;
      background: rgba(255,255,255,.14); color: #fff; text-decoration: none; white-space: nowrap; }
    a.chip:hover { background: rgba(255,255,255,.26); }
    a.chip:focus-visible, button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .src { padding: 2px 5px; border-radius: 4px; font-weight: 700; font-size: 11px; }
    .imdb .src { background: #f5c518; color: #000; }
    .rt .src { background: #fa320a; }
    .popcorn .src { background: #e8a317; color: #000; }
    .mc .src { background: #66cc33; color: #000; }
    .mc.mid .src { background: #ffcc33; }
    .mc.low .src { background: #ff0000; color: #fff; }
    .lb .src { background: #40bcf4; color: #000; }
    .douban .src { background: #00b51d; }
    .val { font-weight: 600; }
    .muted { opacity: .75; font-size: 12px; }
    .warn { color: #ffb4a8; font-size: 12px; }
    button { all: unset; cursor: pointer; font-size: 12px; opacity: .75; text-decoration: underline; }
    button:hover { opacity: 1; }
  `;

  class Panel {
    constructor() {
      this.host = h('div', { id: 'sr-ratings-host' });
      // 别让点击冒泡到 Netflix 卡片上触发跳转
      for (const ev of ['click', 'mousedown', 'pointerdown', 'keydown']) {
        this.host.addEventListener(ev, (e) => e.stopPropagation());
      }
      const root = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      this.box = h('div', { class: 'box', role: 'group', 'aria-label': '影片评分' });
      root.append(style, this.box);
      this.anchor = null;
    }

    mount(anchor, mode) {
      if (anchor && document.contains(anchor)) {
        if (this.anchor === anchor && this.host.isConnected) return;
        this.anchor = anchor;
        this.host.removeAttribute('style');
        this.box.classList.remove('floating');
        if (mode === 'prepend') anchor.prepend(this.host);
        else anchor.after(this.host);
      } else if (!this.host.isConnected || this.anchor) {
        // 找不到合适位置就浮在右上角
        this.anchor = null;
        this.host.setAttribute('style', 'position:fixed;top:84px;right:24px;z-index:2147483647;');
        this.box.classList.add('floating');
        document.body.append(this.host);
      }
    }

    unmount() {
      this.host.remove();
      this.anchor = null;
    }

    set(...kids) {
      this.box.replaceChildren(...kids.flat().filter(Boolean));
    }
  }

  function chip(cls, label, value, href, tip) {
    const kids = [h('span', { class: 'src' }, label), h('span', { class: 'val' }, value)];
    return href
      ? h('a', { class: `chip ${cls}`, href, target: '_blank', rel: 'noopener noreferrer', title: tip }, kids)
      : h('span', { class: `chip ${cls}`, title: tip }, kids);
  }

  function render(panel, info, res, onFix) {
    const { imdb, ratings: r, douban } = res;
    const q = encodeURIComponent((imdb && imdb.title) || info.title);
    const kids = [];

    if (imdb) {
      const tip = `匹配到：${imdb.title || imdb.id}${imdb.year ? ` (${imdb.year})` : ''} · ${imdb.id}` +
        (r.imdb && r.imdb.votes ? ` · ${Number(String(r.imdb.votes).replace(/,/g, '')).toLocaleString()} 人评分` : '');
      kids.push(chip('imdb', 'IMDb', r.imdb ? r.imdb.text : '–', `https://www.imdb.com/title/${imdb.id}/`, tip));
      if (r.rt) kids.push(chip('rt', '烂番茄', r.rt.text, r.rt.url || `https://www.rottentomatoes.com/search?search=${q}`, '专业影评新鲜度'));
      if (r.popcorn) kids.push(chip('popcorn', '爆米花', r.popcorn.text, r.popcorn.url || `https://www.rottentomatoes.com/search?search=${q}`, '烂番茄观众评分'));
      if (r.mc) {
        const n = parseInt(r.mc.text, 10);
        const lvl = n >= 61 ? '' : n >= 40 ? ' mid' : ' low';
        kids.push(chip('mc' + lvl, 'MC', r.mc.text, r.mc.url || `https://www.metacritic.com/search/${q}/`, 'Metacritic 媒体评分'));
      }
      if (r.lb) kids.push(chip('lb', 'Letterboxd', r.lb.text, r.lb.url || `https://letterboxd.com/imdb/${imdb.id}/`, 'Letterboxd（满分 5）'));
    } else {
      kids.push(h('span', { class: 'muted' }, `IMDb 没找到「${info.title}」`));
    }

    if (douban) {
      kids.push(chip('douban', '豆瓣', douban.rate || '暂无', douban.url, douban.title || ''));
    }

    if (!res.provider) {
      kids.push(h('button', { type: 'button', onclick: () => askKey('mdblistKey') }, '设置 MDBList key 看完整评分'));
    }
    kids.push(h('button', { type: 'button', title: '手动指定 IMDb / 豆瓣条目', onclick: onFix }, '匹配错了？'));
    if (res.errors.length) kids.push(h('span', { class: 'warn', title: res.errors.join('\n') }, '⚠ ' + res.errors[0]));

    panel.set(kids);
  }

  // ---------------------------------------------------------------- 设置菜单

  function askKey(name) {
    const label = name === 'mdblistKey' ? 'MDBList API key（mdblist.com → Preferences → API Access）' : 'OMDb API key（omdbapi.com/apikey.aspx 免费申请）';
    const v = prompt(label + '\n留空则清除', GM_getValue(name, ''));
    if (v === null) return;
    GM_setValue(name, v.trim());
    clearCache();
    refresh();
  }

  GM_registerMenuCommand('设置 MDBList API key', () => askKey('mdblistKey'));
  GM_registerMenuCommand('设置 OMDb API key', () => askKey('omdbKey'));
  GM_registerMenuCommand('切换数据源（自动 / MDBList / OMDb）', () => {
    const order = ['auto', 'mdblist', 'omdb'];
    const next = order[(order.indexOf(GM_getValue('provider', 'auto')) + 1) % order.length];
    GM_setValue('provider', next);
    alert('评分数据源：' + { auto: '自动（有 MDBList key 就用 MDBList）', mdblist: 'MDBList 优先', omdb: 'OMDb 优先' }[next]);
    refresh();
  });
  GM_registerMenuCommand('开 / 关豆瓣评分', () => {
    const on = !GM_getValue('doubanEnabled', true);
    GM_setValue('doubanEnabled', on);
    alert('豆瓣评分已' + (on ? '开启' : '关闭'));
    refresh();
  });
  GM_registerMenuCommand('清空评分缓存', () => {
    clearCache();
    refresh();
  });

  // ---------------------------------------------------------------- 主循环（SPA，轮询 URL 和 DOM）

  const panel = new Panel();
  let cur = null; // { sig, firstSeen, started, info, token }
  let token = 0;

  function refresh() {
    cur = null;
    tick();
  }

  function fixMatch(info) {
    const v = prompt(
      `「${info.title}」匹配不对的话，粘贴正确的 IMDb 链接/编号（tt…）或豆瓣链接。\n留空则恢复自动匹配。`,
      '',
    );
    if (v === null) return;
    const key = 'ov:' + infoKey(info);
    const ov = GM_getValue(key, {});
    const tt = /tt\d{5,}/.exec(v);
    const db = /douban\.com\/subject\/(\d+)/.exec(v);
    if (!v.trim()) GM_deleteValue(key);
    else {
      if (tt) ov.imdb = tt[0];
      if (db) ov.douban = db[1];
      if (!tt && !db) return alert('没认出 IMDb 编号或豆瓣链接');
      GM_setValue(key, ov);
    }
    refresh();
  }

  async function run(info) {
    const my = ++token;
    panel.set(h('span', { class: 'muted' }, `正在查「${info.title}」的评分…`));
    try {
      const res = await lookup(info);
      if (my !== token) return;
      render(panel, info, res, () => fixMatch(info));
    } catch (e) {
      if (my !== token) return;
      panel.set(h('span', { class: 'warn' }, '评分查询失败：' + e.message));
    }
  }

  function tick() {
    const site = SITES.find((s) => s.host.test(location.hostname));
    if (!site || !site.isDetail()) {
      if (cur) {
        token++;
        panel.unmount();
        cur = null;
      }
      return;
    }
    const info = site.extract();
    if (!info || !info.title) return;

    const sig = norm(info.title);
    if (!cur || cur.sig !== sig) cur = { sig, firstSeen: Date.now(), started: false };
    panel.mount(info.anchor, info.mode);

    // 年份/类型往往比片名晚渲染出来，等它们一会儿再查，匹配更准
    if (!cur.started && (info.year || Date.now() - cur.firstSeen > 2000)) {
      cur.started = true;
      run({ title: info.title, year: info.year, kind: info.kind });
    }
  }

  setInterval(tick, 800);
  tick();
})();
