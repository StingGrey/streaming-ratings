// ==UserScript==
// @name         流媒体评分助手（IMDb / 烂番茄 / Metacritic / 豆瓣）
// @namespace    https://github.com/StingGrey/streaming-ratings
// @version      0.4.0
// @homepageURL  https://github.com/StingGrey/streaming-ratings
// @supportURL   https://github.com/StingGrey/streaming-ratings/issues
// @updateURL    https://raw.githubusercontent.com/StingGrey/streaming-ratings/main/streaming-ratings.user.js
// @downloadURL  https://raw.githubusercontent.com/StingGrey/streaming-ratings/main/streaming-ratings.user.js
// @description  在 Netflix、Disney+、HBO Max 的影片详情页自动显示 IMDb、烂番茄、Metacritic、豆瓣评分（MDBList 或 OMDb）；在巴哈姆特動畫瘋、Crunchyroll 显示 Bangumi 评分和排名
// @match        *://*.netflix.com/*
// @match        *://*.disneyplus.com/*
// @match        *://*.hbomax.com/*
// @match        *://*.max.com/*
// @match        *://ani.gamer.com.tw/*
// @match        *://www.crunchyroll.com/*
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
// @connect      api.bgm.tv
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

  function request(url, asText, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url,
        data: opts.body,
        timeout: 15000,
        headers: { Accept: asText ? 'text/html' : 'application/json', ...opts.headers },
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

  // ---------------------------------------------------------------- Bangumi（动画站只查这个）

  const BGM_API = 'https://api.bgm.tv';
  // Bangumi 要求请求带上能认出是谁的 UA
  const BGM_HEADERS = { 'User-Agent': 'StingGrey/streaming-ratings (https://github.com/StingGrey/streaming-ratings)' };

  // 繁 → 简单字对照（ICU Hant-Hans 生成，只留基本区单字）
  // Bangumi 搜索不做繁简转换：「我獨自升級」会搜出「我叫MT」，转成「我独自升级」才对
  const T2S_FROM =
    '丟並乾亂亙亞佇佈佔併來侖侶侷俁係俔俠俬俱倀倆倈倉個們倖倣倫偉側偵偽傑傖傘備傢傭傯傳傴債傷傾僂僅僇僉僑僕僞僥僨僱價儀儂億儈儉儐儔儕儘償優儲儷儸儺儻儼兇兌兒兗內兩冊冪凈凍凜凱別刪剄則剋剎剗剛剝剮剴創剷劃劇劉劊劌劍劏劑劚勁動勗務勛勝勞勢勩勱勳勵勸勻匭匯匱區協卹卻厙厠厭厲厴參叄叢吒吢吳吶呂咷咼員唄唚唸問啓啞啟啢喎喚喨喪喫喬單喲嗆嗇嗊嗎嗚嗩嗶嘆嘍嘔嘖嘗嘜嘩嘮嘯嘰嘵嘸嘽噓噚噝噠噥噦噯噲噴噸噹嚀嚇嚌嚐嚕嚙嚥嚦嚨嚮嚲嚳嚴嚶囀囁囂囅囈囉囍囑囓囪圇國圍園圓圖團垵埡埰執堅堊堖堝堯報場塊塋塏塒塗塚塢塤塵塹墊墜墮墳墶墻墾壇壋壎壓壘壙壚壜壞壟壠壢壩壪壯壺壼壽夠夢夥夾奐奧奩奪奬奮奼妝姊姍姦姪娛婁婦婭媧媯媼媽嫋嫗嫵嫻嫿嬀嬃嬈嬋嬌嬙嬝嬡嬤嬪嬰嬸孃孌孫學孿宮寢實寧審寫寬寵寶尅將專尋對導尷屆屍屓屜屢層屨屬岡峴島峽崍崑崗崙崢崬嵐嶁嶄嶇嶔嶗嶠嶢嶧嶨嶮嶴嶸嶺嶼巋巒巔巖巰帥師帳帶幀幃幗幘幟幣幫幬幹幾庫廁廂廄廈廎廚廝廟廠廡廢廣廩廬廳廻弒弔弳張強彆彈彌彎彙彞彠彥彿後徑從徠復徬徵徹恆恥悅悞悳悵悶悽惡惱惲惻愛愜愨愴愷愾慄慇態慍慘慚慟慣慤慪慫慮慳慶慼慾憂憊憐憑憒憖憚憤憫憮憲憶懃懇應懌懍懞懟懣懨懮懲懶懷懸懺懼懾戀戇戔戧戩戰戱戲戶拋挩挾捨捫捲掃掄掗掙掛採揀揚換揮搆損搖搗搥搧搨搵搶搾摀摑摜摟摯摳摶摺摻撈撏撐撓撚撝撟撢撣撥撫撲撳撻撾撿擁擄擇擊擋擓擔據擠擣擬擯擰擱擲擴擷擺擻擼擾攄攆攏攔攖攙攛攜攝攢攣攤攪攬敗敘敵數斂斃斆斕斬斷於昇時晉晝暈暉暘暢暫暱曄曆曇曉曏曖曠曨曬書會朧東枒柵桿梔梘條梟梲棄棖棗棟棡棧棲棶椏楊楓楨業極榖榪榮榲榿構槍槓槖槤槧槨槳樁樂樅樑樓標樞樣樸樹樺橈橋機橢橫檁檉檔檜檝檟檢檣檮檯檳檸檻櫃櫓櫚櫛櫝櫞櫟櫥櫧櫨櫪櫫櫬櫱櫳櫸櫺櫻欄權欏欒欖欞欵欽歎歐歛歟歡歲歷歸歿殘殞殤殨殫殮殯殰殲殺殼毀毆毬毿氂氈氌氣氫氬氳氹氾汎汙決沍沒沖況洩洶浹涇涼淒淚淥淨淪淵淶淺渙減渢渦測渾湊湞湧湯溈準溝溫溮溳溼滄滅滌滎滬滯滲滷滸滻滾滿漁漊漚漢漣漬漲漵漸漿潁潑潔潙潛潤潯潰潷潿澀澆澇澐澗澠澤澦澩澮澱濁濃濕濘濚濜濟濤濫濬濰濱濺濼濾瀂瀅瀆瀇瀉瀋瀏瀕瀘瀝瀟瀠瀦瀧瀨瀰瀲瀾灃灄灑灕灘灝灠灣灤灧災為烏烴無煉煒煙煢煥煩煬煱熅熒熗熱熲熾燁燄燈燉燐燒燙燜營燦燬燭燴燶燻燼燾燿爍爐爛爭爲爺爾牀牆牋牘牽犖犢犧狀狹狽猙猶猻獁獃獄獅獎獨獪獫獮獰獱獲獵獷獸獺獻獼玀現琺琿瑋瑒瑣瑤瑩瑪瑯瑲璉璡璣璦璫環璵璽瓊瓏瓔瓚甌甕產産畝畢畫異當疇疊痀痙痠痾瘂瘋瘍瘓瘞瘡瘧瘮瘲瘺瘻療癆癇癉癒癘癟癡癢癤癥癧癩癬癭癮癰癱癲發皁皚皰皸皺盃盜盞盡監盤盧盪眞眥眾睏睜睞睪瞇瞘瞜瞞瞭瞶瞼矓矚矯砲硏硜硤硨硯碩碭碸確碼磑磚磣磧磯磽磾礄礆礎礙礡礦礪礫礬礮礱祕祿禍禎禕禡禦禪禮禰禱禿秈稅稈稏稜稟種稱穀穇穌積穎穠穡穢穩穫穭窩窪窮窯窵窶窺竄竅竇竈竊竪競筆筍筧筴箇箋箎箏箝節範築篋篔篤篩篳簀簆簍簞簡簣簫簷簹簽簾籃籌籐籙籛籜籟籠籤籩籪籬籮籲粧粵糝糞糧糰糲糴糶糹糾紀紂約紅紆紇紈紉紋納紐紓純紕紖紗紘紙級紛紜紝紡紬紮細紱紲紳紵紹紺紼紿絀終絃組絅絆絎結絕絛絝絞絡絢給絨絰統絲絳絶絹綁綃綆綈綉綌綏綐綑經綜綞綠綢綣綫綬維綯綰綱網綳綴綵綸綹綺綻綽綾綿緄緇緊緋緑緒緓緔緗緘緙線緝緞締緡緣緦編緩緬緯緱緲練緶緹緻縈縉縊縋縐縑縕縗縛縝縞縟縣縧縫縭縮縱縲縳縴縵縶縷縹總績繃繅繆繒織繕繚繞繡繢繩繪繫繭繮繯繰繳繸繹繼繽繾繿纈纊續纍纏纓纔纖纘纜缽罃罈罌罎罣罰罵罷羅羆羈羋羣羥羨義羶習翫翬翹翺翽耬耮聖聞聯聰聲聳聵聶職聹聽聾肅脅脈脛脣脫脹腎腖腡腦腫腳腸膃膕膚膞膠膩膽膾膿臉臍臏臘臚臟臠臢臥臨臺與興舉舊舖艙艤艦艫艱艷芻苎苧茲荊荳莊莖莢莧菓華菸萇萊萬萵葉葒著葤葦葯葷蒐蒓蒔蒞蒼蓀蓆蓋蓮蓯蓽蔔蔞蔣蔥蔦蔭蔴蕁蕆蕎蕒蕓蕕蕘蕢蕩蕪蕭蕷薀薈薊薌薑薔薘薟薦薩薳薴薺藉藍藎藝藥藪藭藴藶藷藹藺蘀蘄蘆蘇蘊蘋蘚蘞蘢蘭蘺蘿虆處虛虜號虧虯蛺蛻蜆蝕蝟蝦蝨蝸螄螞螢螮螻螿蟄蟈蟎蟣蟬蟯蟲蟶蟻蠅蠆蠍蠐蠑蠔蠟蠣蠧蠨蠱蠶蠻衆衊術衚衛衝袞袴裊裏補裝裡製複褌褘褲褳褸褻襇襏襖襝襠襤襪襬襯襲襴覈見覎規覓視覘覡覥覦親覬覯覲覷覺覽覿觀觴觶觸訁訂訃計訊訌討訐訒訓訕訖託記訛訝訟訢訣訥訩訪設許訴訶診註証詁詆詎詐詒詔評詖詗詘詛詞詠詡詢詣試詩詫詬詭詮詰話該詳詵詼詿誄誅誆誇誌認誑誒誕誘誚語誠誡誣誤誥誦誨說説誰課誶誹誼誾調諂諄談諉請諍諏諑諒論諗諛諜諝諞諡諢諤諦諧諫諭諮諱諳諶諷諸諺諼諾謀謁謂謄謅謊謎謐謔謖謗謙謚講謝謠謡謨謫謬謭謳謹謾譁譅證譎譏譖識譙譚譜譟譫譯議譴護譸譽譾讀變讋讌讎讒讓讕讖讚讜讞豈豎豐豔豬豶貍貓貙貝貞貟負財貢貧貨販貪貫責貯貰貲貳貴貶買貸貺費貼貽貿賀賁賂賃賄賅資賈賊賑賒賓賕賙賚賜賞賠賡賢賣賤賦賧質賫賬賭賰賴賵賸賺賻購賽賾贄贅贇贈贊贋贍贏贐贓贔贖贗贛贜赬趕趙趨趲跡跤跼踐踡踰踴蹌蹕蹟蹣蹤蹧蹺躂躉躊躋躍躑躒躓躕躚躡躥躦躪軀車軋軌軍軑軒軔軛軟軤軫軲軸軹軺軻軼軾較輅輇輈載輊輒輓輔輕輛輜輝輞輟輥輦輩輪輬輯輳輸輻輾輿轀轂轄轅轆轉轍轎轔轝轟轡轢轤辦辭辮辯農迴逕這連週進遊運過達違遙遜遞遠適遯遲遷選遺遼邁還邇邊邏邐郟郵鄆鄉鄒鄔鄖鄧鄭鄰鄲鄴鄶鄺酇酈醃醖醜醞醫醬醱醼釀釁釃釅釋釐釒釓釔釕釗釘釙針釣釤釦釧釩釵釷釹釺鈀鈁鈃鈄鈈鈉鈍鈎鈐鈑鈒鈔鈕鈞鈣鈥鈦鈧鈮鈰鈳鈴鈷鈸鈹鈺鈽鈾鈿鉀鉅鉈鉉鉋鉍鉑鉕鉗鉚鉛鉞鉢鉤鉦鉨鉬鉭鉶鉸鉺鉻鉿銀銃銅銍銑銓銖銘銚銛銜銠銣銥銦銨銩銪銫銬銱銲銳銷銹銻銼鋁鋃鋅鋇鋌鋏鋒鋙鋝鋟鋣鋤鋥鋦鋨鋩鋪鋭鋮鋯鋰鋱鋶鋸鋼錁錄錆錇錈錏錐錒錕錘錙錚錛錟錠錡錢錦錨錩錫錮錯録錳錶錸鍀鍁鍃鍆鍇鍈鍊鍋鍍鍔鍘鍚鍛鍠鍤鍥鍩鍬鍰鍵鍶鍺鍾鎂鎄鎇鎊鎔鎖鎗鎘鎚鎛鎡鎢鎣鎦鎧鎩鎪鎬鎮鎰鎲鎳鎵鎶鎸鎿鏃鏇鏈鏌鏍鏐鏑鏗鏘鏜鏝鏞鏟鏡鏢鏤鏨鏰鏵鏷鏹鏺鏽鐃鐋鐐鐒鐓鐔鐘鐙鐝鐠鐦鐧鐨鐫鐮鐯鐲鐳鐵鐶鐸鐺鐿鑄鑈鑊鑌鑑鑒鑔鑕鑞鑠鑣鑥鑭鑰鑱鑲鑷鑹鑼鑽鑾鑿钁長門閂閃閆閈閉開閌閎閏閑閒間閔閘閡関閣閥閧閨閩閫閬閭閱閲閶閹閻閼閽閾閿闃闆闇闈闊闋闌闍闐闒闓闔闕闖闘關闞闠闡闢闤闥阨阪陘陝陞陣陰陳陸陽隄隉隊階隕際隨險隱隴隸隻雋雖雙雛雜雞離難雲電霑霢霧霽靂靄靆靈靉靚靜靦靨靷鞀鞏鞝鞽韁韃韉韋韌韍韓韙韜韞韮韻響頁頂頃項順頇須頊頌頎頏預頑頒頓頗領頜頡頤頦頭頮頰頲頴頷頸頹頻頽顆題額顎顏顒顓顔願顙顛類顢顥顧顫顬顯顰顱顳顴風颭颮颯颱颳颶颸颺颻颼飀飄飆飈飛飠飢飣飥飩飪飫飭飯飲飴飼飽飾飿餃餄餅餉養餌餎餏餑餒餓餕餖餘餚餛餜餞餡館餬餱餳餵餶餷餺餼餽餾餿饁饃饅饈饉饊饋饌饑饒饗饜饞饢馬馭馮馱馳馴馹駁駐駑駒駔駕駘駙駛駝駟駡駢駭駰駱駸駿騁騂騅騌騍騎騏騖騙騤騧騫騭騮騰騶騷騸騾驀驁驂驃驄驅驊驌驍驏驕驗驚驛驟驢驤驥驦驪驫骯髏髒體髕髖髮鬀鬆鬍鬚鬢鬥鬧鬨鬩鬭鬮鬱鬹魎魘魚魛魢魨魯魴魷魺鮁鮃鮊鮋鮍鮎鮐鮑鮒鮓鮚鮜鮝鮞鮣鮦鮪鮫鮭鮮鮳鮶鮺鯀鯁鯇鯉鯊鯒鯔鯕鯖鯛鯝鯡鯢鯤鯧鯨鯪鯫鯰鯴鯷鯽鯿鰁鰂鰃鰆鰈鰉鰍鰏鰐鰒鰓鰜鰟鰠鰣鰥鰧鰨鰩鰭鰮鰱鰲鰳鰵鰷鰹鰺鰻鰼鰾鱂鱅鱈鱉鱒鱔鱖鱗鱘鱝鱟鱠鱣鱤鱧鱨鱭鱯鱷鱸鱺鳥鳧鳩鳬鳲鳳鳴鳶鳾鴆鴇鴉鴒鴕鴛鴝鴞鴟鴣鴦鴨鴯鴰鴴鴷鴻鴿鵁鵂鵃鵐鵑鵒鵓鵜鵝鵠鵡鵪鵬鵮鵯鵲鵷鵾鶄鶇鶉鶊鶓鶖鶘鶚鶡鶥鶩鶪鶬鶯鶲鶴鶹鶺鶻鶼鷀鷁鷂鷄鷈鷊鷓鷖鷗鷙鷚鷥鷦鷫鷯鷲鷳鷸鷹鷺鷽鷿鸂鸇鸌鸏鸕鸘鸚鸛鸝鸞鹵鹹鹺鹼鹽麗麤麥麩麯麴麵麼麽黃黌點黨黲黴黶黷黽黿鼇鼈鼉鼕鼴齊齋齎齏齒齔齕齗齙齜齟齠齡齣齦齧齩齪齬齲齶齷龍龎龐龑龔龕龜';
  const T2S_TO =
    '丢并干乱亘亚伫布占并来仑侣局俣系伣侠私具伥俩俫仓个们幸仿伦伟侧侦伪杰伧伞备家佣偬传伛债伤倾偻仅戮佥侨仆伪侥偾雇价仪侬亿侩俭傧俦侪尽偿优储俪㑩傩傥俨凶兑儿兖内两册幂净冻凛凯别删刭则克刹刬刚剥剐剀创铲划剧刘刽刿剑㓥剂㔉劲动勖务勋胜劳势勚劢勋励劝匀匦汇匮区协恤却厍厕厌厉厣参叁丛咤吣吴呐吕啕呙员呗吣念问启哑启唡㖞唤亮丧吃乔单哟呛啬唝吗呜唢哔叹喽呕啧尝唛哗唠啸叽哓呒啴嘘㖊咝哒哝哕嗳哙喷吨当咛吓哜尝噜啮咽呖咙向亸喾严嘤啭嗫嚣冁呓啰禧嘱啮囱囵国围园圆图团埯垭采执坚垩垴埚尧报场块茔垲埘涂冢坞埙尘堑垫坠堕坟垯墙垦坛垱埙压垒圹垆坛坏垄垅坜坝塆壮壶壸寿够梦伙夹奂奥奁夺奖奋姹妆姐姗奸侄娱娄妇娅娲妫媪妈袅妪妩娴婳妫媭娆婵娇嫱袅嫒嬷嫔婴婶娘娈孙学孪宫寝实宁审写宽宠宝克将专寻对导尴届尸屃屉屡层屦属冈岘岛峡崃昆岗仑峥岽岚嵝崭岖嵚崂峤峣峄峃崄岙嵘岭屿岿峦巅岩巯帅师帐带帧帏帼帻帜币帮帱干几库厕厢厩厦庼厨厮庙厂庑废广廪庐厅回弑吊弪张强别弹弥弯汇彝彟彦佛后径从徕复彷征彻恒耻悦悮德怅闷凄恶恼恽恻爱惬悫怆恺忾栗殷态愠惨惭恸惯悫怄怂虑悭庆戚欲忧惫怜凭愦慭惮愤悯怃宪忆勤恳应怿懔蒙怼懑恹忧惩懒怀悬忏惧慑恋戆戋戗戬战戯戏户抛捝挟舍扪卷扫抡挜挣挂采拣扬换挥构损摇捣捶扇拓揾抢榨捂掴掼搂挚抠抟折掺捞挦撑挠捻㧑挢掸掸拨抚扑揿挞挝捡拥掳择击挡㧟担据挤捣拟摈拧搁掷扩撷摆擞撸扰摅撵拢拦撄搀撺携摄攒挛摊搅揽败叙敌数敛毙敩斓斩断于升时晋昼晕晖旸畅暂昵晔历昙晓向暧旷昽晒书会胧东丫栅杆栀枧条枭棁弃枨枣栋㭎栈栖梾桠杨枫桢业极谷杩荣榅桤构枪杠橐梿椠椁桨桩乐枞梁楼标枢样朴树桦桡桥机椭横檩柽档桧楫槚检樯梼台槟柠槛柜橹榈栉椟橼栎橱槠栌枥橥榇蘖栊榉棂樱栏权椤栾榄棂款钦叹欧敛欤欢岁历归殁残殒殇㱮殚殓殡㱩歼杀壳毁殴球毵牦毡氇气氢氩氲凼泛泛污决冱没冲况泄汹浃泾凉凄泪渌净沦渊涞浅涣减沨涡测浑凑浈涌汤沩准沟温浉涢湿沧灭涤荥沪滞渗卤浒浐滚满渔溇沤汉涟渍涨溆渐浆颍泼洁沩潜润浔溃滗涠涩浇涝沄涧渑泽滪泶浍淀浊浓湿泞溁浕济涛滥浚潍滨溅泺滤澛滢渎㲿泻沈浏濒泸沥潇潆潴泷濑弥潋澜沣滠洒漓滩灏漤湾滦滟灾为乌烃无炼炜烟茕焕烦炀㶽煴荧炝热颎炽烨焰灯炖磷烧烫焖营灿毁烛烩㶶熏烬焘耀烁炉烂争为爷尔床墙笺牍牵荦犊牺状狭狈狰犹狲犸呆狱狮奖独狯猃狝狞㺍获猎犷兽獭献猕猡现珐珲玮玚琐瑶莹玛琅玱琏琎玑瑷珰环玙玺琼珑璎瓒瓯瓮产产亩毕画异当畴叠佝痉酸疴痖疯疡痪瘗疮疟瘆疭瘘瘘疗痨痫瘅愈疠瘪痴痒疖症疬癞癣瘿瘾痈瘫癫发皂皑疱皲皱杯盗盏尽监盘卢荡真眦众困睁睐睾眯眍䁖瞒了瞆睑眬瞩矫炮研硁硖砗砚硕砀砜确码硙砖碜碛矶硗䃅硚硷础碍礴矿砺砾矾炮砻秘禄祸祯祎祃御禅礼祢祷秃籼税秆䅉棱禀种称谷䅟稣积颖秾穑秽稳获稆窝洼穷窑窎窭窥窜窍窦灶窃竖竞笔笋笕䇲个笺篪筝钳节范筑箧筼笃筛筚箦筘篓箪简篑箫檐筜签帘篮筹藤箓篯箨籁笼签笾簖篱箩吁妆粤糁粪粮团粝籴粜纟纠纪纣约红纡纥纨纫纹纳纽纾纯纰纼纱纮纸级纷纭纴纺䌷扎细绂绁绅纻绍绀绋绐绌终弦组䌹绊绗结绝绦绔绞络绚给绒绖统丝绛绝绢绑绡绠绨绣绤绥䌼捆经综缍绿绸绻线绶维绹绾纲网绷缀彩纶绺绮绽绰绫绵绲缁紧绯绿绪绬绱缃缄缂线缉缎缔缗缘缌编缓缅纬缑缈练缏缇致萦缙缢缒绉缣缊缞缚缜缟缛县绦缝缡缩纵缧䌸纤缦絷缕缥总绩绷缫缪缯织缮缭绕绣缋绳绘系茧缰缳缲缴䍁绎继缤缱䍀缬纩续累缠缨才纤缵缆钵䓨坛罂坛挂罚骂罢罗罴羁芈群羟羡义膻习玩翚翘翱翙耧耢圣闻联聪声耸聩聂职聍听聋肃胁脉胫唇脱胀肾胨脶脑肿脚肠腽腘肤䏝胶腻胆脍脓脸脐膑腊胪脏脔臜卧临台与兴举旧铺舱舣舰舻艰艳刍苧苎兹荆豆庄茎荚苋果华烟苌莱万莴叶荭着荮苇药荤搜莼莳莅苍荪席盖莲苁荜卜蒌蒋葱茑荫麻荨蒇荞荬芸莸荛蒉荡芜萧蓣蕰荟蓟芗姜蔷荙莶荐萨䓕苧荠借蓝荩艺药薮䓖蕴苈薯蔼蔺萚蕲芦苏蕴苹藓蔹茏兰蓠萝蔂处虚虏号亏虬蛱蜕蚬蚀猬虾虱蜗蛳蚂萤䗖蝼螀蛰蝈螨虮蝉蛲虫蛏蚁蝇虿蝎蛴蝾蚝蜡蛎蠹蟏蛊蚕蛮众蔑术胡卫冲衮绔袅里补装里制复裈袆裤裢褛亵裥袯袄裣裆褴袜䙓衬袭襕核见觃规觅视觇觋觍觎亲觊觏觐觑觉览觌观觞觯触讠订讣计讯讧讨讦讱训讪讫托记讹讶讼䜣诀讷讻访设许诉诃诊注证诂诋讵诈诒诏评诐诇诎诅词咏诩询诣试诗诧诟诡诠诘话该详诜诙诖诔诛诓夸志认诳诶诞诱诮语诚诫诬误诰诵诲说说谁课谇诽谊訚调谄谆谈诿请诤诹诼谅论谂谀谍谞谝谥诨谔谛谐谏谕谘讳谙谌讽诸谚谖诺谋谒谓誊诌谎谜谧谑谡谤谦谥讲谢谣谣谟谪谬谫讴谨谩哗䜧证谲讥谮识谯谭谱噪谵译议谴护诪誉谫读变詟䜩雠谗让谰谶赞谠谳岂竖丰艳猪豮狸猫䝙贝贞贠负财贡贫货贩贪贯责贮贳赀贰贵贬买贷贶费贴贻贸贺贲赂赁贿赅资贾贼赈赊宾赇赒赉赐赏赔赓贤卖贱赋赕质赍账赌䞐赖赗剩赚赙购赛赜贽赘赟赠赞赝赡赢赆赃赑赎赝赣赃赪赶赵趋趱迹交局践蜷逾踊跄跸迹蹒踪糟跷跶趸踌跻跃踯跞踬蹰跹蹑蹿躜躏躯车轧轨军轪轩轫轭软轷轸轱轴轵轺轲轶轼较辂辁辀载轾辄挽辅轻辆辎辉辋辍辊辇辈轮辌辑辏输辐辗舆辒毂辖辕辘转辙轿辚舆轰辔轹轳办辞辫辩农回迳这连周进游运过达违遥逊递远适遁迟迁选遗辽迈还迩边逻逦郏邮郓乡邹邬郧邓郑邻郸邺郐邝酂郦腌酝丑酝医酱酦宴酿衅酾酽释厘钅钆钇钌钊钉钋针钓钐扣钏钒钗钍钕钎钯钫钘钭钚钠钝钩钤钣钑钞钮钧钙钬钛钪铌铈钶铃钴钹铍钰钸铀钿钾钜铊铉铇铋铂钷钳铆铅钺钵钩钲鿭钼钽铏铰铒铬铪银铳铜铚铣铨铢铭铫铦衔铑铷铱铟铵铥铕铯铐铞焊锐销锈锑锉铝锒锌钡铤铗锋铻锊锓铘锄锃锔锇铓铺锐铖锆锂铽锍锯钢锞录锖锫锩铔锥锕锟锤锱铮锛锬锭锜钱锦锚锠锡锢错录锰表铼锝锨锪钔锴锳炼锅镀锷铡钖锻锽锸锲锘锹锾键锶锗钟镁锿镅镑镕锁枪镉锤镈镃钨蓥镏铠铩锼镐镇镒镋镍镓鿔镌镎镞镟链镆镙镠镝铿锵镗镘镛铲镜镖镂錾镚铧镤镪䥽锈铙铴镣铹镦镡钟镫镢镨锎锏镄镌镰䦃镯镭铁镮铎铛镱铸鿭镬镔鉴鉴镲锧镴铄镳镥镧钥镵镶镊镩锣钻銮凿䦆长门闩闪闫闬闭开闶闳闰闲闲间闵闸阂关阁阀哄闺闽阃阆闾阅阅阊阉阎阏阍阈阌阒板暗闱阔阕阑阇阗阘闿阖阙闯斗关阚阓阐辟阛闼厄坂陉陕升阵阴陈陆阳堤陧队阶陨际随险隐陇隶只隽虽双雏杂鸡离难云电沾霡雾霁雳霭叇灵叆靓静腼靥纼鼗巩绱鞒缰鞑鞯韦韧韨韩韪韬韫韭韵响页顶顷项顺顸须顼颂颀颃预顽颁顿颇领颌颉颐颏头颒颊颋颕颔颈颓频颓颗题额颚颜颙颛颜愿颡颠类颟颢顾颤颥显颦颅颞颧风飐飑飒台刮飓飔飏飖飕飗飘飙飚飞饣饥饤饦饨饪饫饬饭饮饴饲饱饰饳饺饸饼饷养饵饹饻饽馁饿馂饾余肴馄馃饯馅馆糊糇饧喂馉馇馎饩馈馏馊馌馍馒馐馑馓馈馔饥饶飨餍馋馕马驭冯驮驰驯驲驳驻驽驹驵驾骀驸驶驼驷骂骈骇骃骆骎骏骋骍骓骔骒骑骐骛骗骙䯄骞骘骝腾驺骚骟骡蓦骜骖骠骢驱骅骕骁骣骄验惊驿骤驴骧骥骦骊骉肮髅脏体髌髋发剃松胡须鬓斗闹哄阋斗阄郁鬶魉魇鱼鱽鱾鲀鲁鲂鱿鲄鲅鲆鲌鲉鲏鲇鲐鲍鲋鲊鲒鲘鲞鲕䲟鲖鲔鲛鲑鲜鲓鲪鲝鲧鲠鲩鲤鲨鲬鲻鲯鲭鲷鲴鲱鲵鲲鲳鲸鲮鲰鲶鲺鳀鲫鳊鳈鲗鳂䲠鲽鳇鳅鲾鳄鳆鳃鳒鳑鳋鲥鳏䲢鳎鳐鳍鳁鲢鳌鳓鳘鲦鲣鲹鳗鳛鳔鳉鳙鳕鳖鳟鳝鳜鳞鲟鲼鲎鲙鳣鳡鳢鲿鲚鳠鳄鲈鲡鸟凫鸠凫鸤凤鸣鸢䴓鸩鸨鸦鸰鸵鸳鸲鸮鸱鸪鸯鸭鸸鸹鸻䴕鸿鸽䴔鸺鸼鹀鹃鹆鹁鹈鹅鹄鹉鹌鹏鹐鹎鹊鹓鹍䴖鸫鹑鹒鹋鹙鹕鹗鹖鹛鹜䴗鸧莺鹟鹤鹠鹡鹘鹣鹚鹢鹞鸡䴘鹝鹧鹥鸥鸷鹨鸶鹪鹔鹩鹫鹇鹬鹰鹭鸴䴙㶉鹯鹱鹲鸬鹴鹦鹳鹂鸾卤咸鹾碱盐丽粗麦麸曲麹面么么黄黉点党黪霉黡黩黾鼋鳌鳖鼍冬鼹齐斋赍齑齿龀龁龂龅龇龃龆龄出龈啮咬龊龉龋腭龌龙厐庞䶮龚龛龟';
  let t2sMap = null;
  function t2s(s) {
    if (!t2sMap) {
      const to = [...T2S_TO];
      t2sMap = new Map([...T2S_FROM].map((c, i) => [c, to[i]]));
      t2sMap.set('妳', '你'); // ICU 不转，台湾片名里很常见
    }
    // 两岸叫法不同、Bangumi 别名里又常没收的词，顺手换掉
    return [...(s || '')].map((c) => t2sMap.get(c) || c).join('').replace(/钢弹/g, '高达');
  }

  // 拆出季数：「幼女戰記 2」「黑色五葉草 Season 2」「転生したら剣でしたII」「第四季」都认
  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const ROMAN = { Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5, Ⅵ: 6, II: 2, III: 3, IV: 4 };
  const SEASON_RES = [
    /第\s*([一二三四五六七八九十]|\d+)\s*(?:季|期|部|シーズン|シリーズ)/,
    /\bseason\s*(\d+)/i,
    /\b(\d+)(?:st|nd|rd|th)\s*season\b/i,
    /([ⅡⅢⅣⅤⅥ])/,
    /(?<![A-Za-z])(III|II|IV)(?![A-Za-z])/,
    /(?<!no\.?|号)[\s!！]([2-9])[\s!！]*$/i, // 「微速前進！2！！」；「Kaiju No. 8」「怪獸 8 號」不算
  ];
  // 「電影」「劇場版」前缀单独拿出来，不然搜索会拿「电影」两个字去搜
  // 结尾的「(TV版)」去掉；「(2012)」这种年份标注单独拿出来，别名靠它区分同名的不同季
  const MOVIE_RE = /^(?:电影|剧场版|映画|劇場アニメ)\s*|\s*[(（](?:电影|剧场)版?[)）]$/;
  function splitSeason(s) {
    let t = t2s(s || '').trim().replace(/\s*[(（]TV版[)）]$/i, '');
    const ym = /\s*[(（](\d{4})[)）]$/.exec(t);
    const tag = ym ? +ym[1] : null;
    if (ym) t = t.slice(0, ym.index);
    const movie = MOVIE_RE.test(t);
    t = t.replace(MOVIE_RE, '');
    for (const re of SEASON_RES) {
      const m = re.exec(t);
      if (!m) continue;
      const v = m[1];
      const n = CN_NUM[v] || ROMAN[v] || parseInt(v, 10);
      const raw = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
      if (n) return { raw, base: norm(raw), season: n, movie, tag };
    }
    return { raw: t, base: norm(t), season: 1, movie, tag };
  }

  // 字符二元组的 Dice 相似度，对付「小狸貓和小狐狸」vs「小狸猫与小狐狸」这种差一两个字的译名
  function dice(a, b) {
    if (a.length < 4 || b.length < 4) return 0;
    const grams = (s) => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
      return m;
    };
    const x = grams(a);
    const y = grams(b);
    let hit = 0;
    for (const [g, n] of x) hit += Math.min(n, y.get(g) || 0);
    return (2 * hit) / (a.length - 1 + b.length - 1);
  }

  // 条目的日文名、中文名、别名（别名里常有台湾译名和英文名）
  // 别名常带地区标注，如「超人力霸王(台)」，去掉再比
  function bgmNames(x) {
    const names = [x.name, x.name_cn];
    for (const it of x.infobox || []) {
      if (it.key !== '别名' && it.key !== '中文名') continue;
      names.push(...(Array.isArray(it.value) ? it.value.map((v) => v && v.v) : [it.value]));
    }
    return names
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => n.replace(/\s*[(（](?:台|港|陆|澳|台湾|香港|大陆|日|英)[)）]\s*$/, ''));
  }

  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

  // 中英并列的片名（「MAO 摩緒」「The Anime「幻想水滸傳」」）拆成英文部分和中文部分，各自都能单独对上
  // 但另一半像续作标记（「我的英雄學院 FINAL SEASON」）就不行，那是另一季
  const SEQUEL_RE = /final|season|stage|part|movie|film|ova|oad|special|arc|chapter|篇|季|期|部|章|外传|续/i;
  function bilingualParts(raw) {
    const segs = raw.split(/[\s「」『』【】()（）]+/).filter(Boolean);
    const cjk = norm(segs.filter((s) => CJK.test(s)).join(''));
    const latin = norm(segs.filter((s) => !CJK.test(s)).join(''));
    if (!cjk || !latin) return [];
    return [[latin, cjk], [cjk, latin]].filter(([, rest]) => !SEQUEL_RE.test(rest)).map(([p]) => p);
  }

  // 片名里的数字和英文字母基本不会因为翻译不同而变，模糊匹配时必须一致（「鋼彈 00」≠「鋼彈桑」）
  const asciiSig = (s) => (s.match(/[a-z0-9]+/g) || []).join(' ');

  // 繁简统一、季数分开比：季数不同的名字直接不算，免得第三季的页面挂上第一季的分
  // 不完全一致时要求长度接近，免得「超人力霸王狄奧」挂上「超人力霸王」、「XX 外傳」挂上本篇
  function bgmTitleScore(x, title) {
    const q = splitSeason(title);
    if (!q.base) return 0;
    const parts = bilingualParts(q.raw);
    let best = 0;
    for (const n of bgmNames(x)) {
      const v = splitSeason(n);
      if (!v.base || v.season !== q.season) continue;
      if (v.base === q.base) {
        // 「Fire Force (2020)」是第二季的别名，页面上的「Fire Force」应该优先配不带年份的那个
        if (!v.tag || v.tag === q.tag) return 4;
        best = Math.max(best, 3);
        continue;
      }
      if (parts.includes(v.base)) best = Math.max(best, 2.5);
      const [a, b] = v.base.length < q.base.length ? [v.base, q.base] : [q.base, v.base];
      if (a.length / b.length < 0.8 || asciiSig(a) !== asciiSig(b)) continue;
      if (b.includes(a)) best = Math.max(best, 1 + (a.length / b.length) * 1.5);
      const d = dice(a, b);
      if (d >= 0.65) best = Math.max(best, 1 + (d - 0.65) * 4);
    }
    return best;
  }

  function bgmItem(x) {
    const r = x.rating || {};
    return {
      id: x.id,
      name: x.name || '',
      nameCn: x.name_cn || '',
      year: parseInt(x.date, 10) || null,
      score: r.score || 0,
      rank: r.rank || 0,
      votes: r.total || 0,
    };
  }

  async function bgmSearch(keyword) {
    const { status, data } = await request(`${BGM_API}/v0/search/subjects?limit=10`, false, {
      method: 'POST',
      headers: { ...BGM_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, filter: { type: [2] } }),
    });
    if (status >= 400 || !data || !Array.isArray(data.data)) {
      throw new Error((data && (data.description || data.title)) || 'HTTP ' + status);
    }
    return data.data;
  }

  // 片名（繁/简/日/英都行）→ Bangumi 动画条目
  // 依次用原文、简体、去掉季数、只留主标题去搜，搜到完全对上的就停
  // recent：「本季新番」这类卡片，没有确切年份，只是近两年的稍微优先
  async function searchBangumi(title, year, recent) {
    const t = title.trim().slice(0, 100);
    if (!t) return null;
    const { raw, movie } = splitSeason(t);
    // 主标题：中文片名取第一段中文；英文片名只按标点切，不然「Fire Force」会切出个「Fire」
    const head = CJK.test(raw)
      ? raw.split(/[\s:：,，!！?？~～\-－—「」『』【】()（）·・]+/).find((s) => s.length >= 2 && CJK.test(s))
      : raw.split(/\s*[:：,，!！?？~～－—「」『』【】()（）·・]+\s*/).find((s) => s.length >= 4);
    const queries = [t, t2s(t), raw, head].filter((q, i, a) => q && a.indexOf(q) === i);
    let best = null;
    let bestScore = -Infinity;
    let exact = false;
    for (const q of queries) {
      (await bgmSearch(q)).forEach((x, i) => {
        const ts = bgmTitleScore(x, t);
        if (!ts) return;
        if (ts === 4) exact = true;
        const y = parseInt(x.date, 10);
        let s = ts - i * 0.03; // 搜索排名只当平局时的参考
        if (year && y) s += y === year ? 3 : Math.abs(y - year) === 1 ? 1 : -Math.min(Math.abs(y - year), 6) * 0.5;
        if (recent && y >= new Date().getFullYear() - 1) s += 1;
        if (x.platform === '其他') s -= 1; // PV、CM 之类
        if (movie !== (x.platform === '剧场版')) s -= 1.5;
        if (s > bestScore) {
          bestScore = s;
          best = x;
        }
      });
      if (exact) break;
    }
    return best ? bgmItem(best) : null;
  }

  async function bgmSubject(id) {
    const { status, data } = await request(`${BGM_API}/v0/subjects/${encodeURIComponent(id)}`, false, { headers: BGM_HEADERS });
    if (status === 404) return null;
    if (status >= 400 || !data || !data.id) throw new Error((data && (data.description || data.title)) || 'HTTP ' + status);
    return bgmItem(data);
  }

  async function lookupBgm(info) {
    const ov = GM_getValue('ov:' + infoKey(info), {});
    let hit = null;
    let fresh = false; // 刚搜出来的结果自带评分，不用再查一次
    const errors = [];
    if (ov.bgm) hit = { id: ov.bgm };
    else {
      hit = await cached(`bgm:s:${norm(info.title)}|${info.year || ''}|${info.recent ? 'r' : ''}`, SEARCH_TTL, () => {
        fresh = true;
        return searchBangumi(info.title, info.year, info.recent);
      }).catch((e) => {
        errors.push('Bangumi 搜索：' + e.message);
        return null;
      });
    }
    let bgm = null;
    if (hit) {
      bgm = await cached(`bgm:r:${hit.id}`, RATING_TTL, () => (fresh ? hit : bgmSubject(hit.id))).catch((e) => {
        errors.push('Bangumi 评分：' + e.message);
        return null;
      });
    }
    return { bgm, errors };
  }

  if (TEST) {
    Object.assign(TEST, {
      norm, searchImdb, searchDouban, searchDoubanByImdb, searchDoubanPage, searchCinemeta, cinemetaMeta,
      searchTvmaze, searchZhwiki, searchWikidata, doubanRating, lookup, infoKey,
      t2s, splitSeason, searchBangumi, bgmSubject, lookupBgm, bgmSearch, bgmNames, bgmTitleScore,
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

  const SITE_NAME = /^(netflix|disney\+|hbo max|max|crunchyroll|巴哈姆特動畫瘋)$/i;

  function cleanDocTitle() {
    const t = document.title
      .replace(/^(watch|观看|觀看|收看)\s+/i, '')
      .replace(/\s*[|\-–—•·]\s*(netflix|disney\+|hbo max|max|crunchyroll|巴哈姆特動畫瘋)\s*$/i, '')
      .replace(/\s*線上看$/, '')
      .trim();
    return SITE_NAME.test(t) ? '' : t;
  }

  // 巴哈的片名后面常挂着集数「[9]」「[特別篇]」
  const aniTitle = (s) => (s || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

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
    // 下面两个动画站只查 Bangumi；列表页的卡片也挂上小角标
    // cards：sel 卡片、title 片名、year 年份、badgeIn 角标放哪、inline 跟在文字后面、recent 本季新番
    {
      name: 'anigamer',
      host: /^ani\.gamer\.com\.tw$/,
      source: 'bgm',
      isDetail: () => /^\/anime(Video|Ref)\.php/.test(location.pathname),
      extract() {
        const h1 = document.querySelector('.anime_name h1');
        const first = [...document.querySelectorAll('.type-list .type')].find((li) => /首播/.test(textOf(li.querySelector('.title'))));
        return {
          title: aniTitle(h1 ? h1.textContent : cleanDocTitle()),
          year: findYear(first && first.querySelector('.content')),
          anchor: document.querySelector('.anime_name .anime_info_detail') || h1,
          mode: 'after',
          theme: 'auto', // 巴哈有亮色和暗色两种主题
        };
      },
      cards: [
        { sel: 'a.anime-card-block', title: '.anime-name', badgeIn: '.anime-pic-block', recent: true },
        { sel: 'a.theme-list-main', title: '.theme-name', year: '.theme-time', badgeIn: '.theme-img-block' },
        { sel: 'a.text-anime-info', title: '.text-anime-name', inline: '.text-anime-number' },
      ],
    },
    {
      name: 'crunchyroll',
      host: /(^|\.)crunchyroll\.com$/,
      source: 'bgm',
      isDetail: () => /\/(series|watch)\//.test(location.pathname),
      extract() {
        const hero = document.querySelector('[data-t="series-hero-body"]');
        if (hero) {
          const t = firstText(['h1'], hero);
          return {
            title: t ? t.text : cleanDocTitle(),
            anchor: hero.querySelector('[data-t="ratings-wrapper"]') || (t && t.el),
            mode: 'after',
          };
        }
        // 播放页：拿剧集名，拿不到就不显示（document.title 是单集标题，对不上）
        const t = firstText(['[data-t="show-title-link"] h4', 'a.show-title-link h4', 'a[href*="/series/"] h4'], document);
        return t && { title: t.text, anchor: t.el.closest('a') || t.el, mode: 'after' };
      },
      cards: [
        { sel: '[data-t^="series-card"]', title: 'a[aria-label]:not([aria-label=""]), h3, h4', badgeIn: '[class*="poster-wrapper"]', pos: 'left:6px;top:6px' },
      ],
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
    .bgm .src { background: #f09199; }
    .val { font-weight: 600; }
    .muted { opacity: .75; font-size: 12px; }
    .warn { color: #ffb4a8; font-size: 12px; }
    button { all: unset; cursor: pointer; font-size: 12px; opacity: .75; text-decoration: underline; }
    button:hover { opacity: 1; }
    .box.light { color: #1f1f1f; }
    .light .chip { background: rgba(0,0,0,.06); color: #1f1f1f; }
    .light a.chip:hover { background: rgba(0,0,0,.12); }
    .light a.chip:focus-visible, .light button:focus-visible { outline-color: #1f1f1f; }
    .light .warn { color: #c0392b; }
  `;

  // 往上找第一个不透明的背景色，判断是不是亮色页面；一个都没设就是浏览器默认的白底
  function isLightBg(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(e).backgroundColor);
      if (!m) continue;
      const [r, g, b, a = 1] = m[1].split(',').map(Number);
      if (a < 0.5) continue;
      return 0.299 * r + 0.587 * g + 0.114 * b > 150;
    }
    return true;
  }

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

    mount(anchor, mode, theme) {
      if (anchor && document.contains(anchor)) {
        this.box.classList.toggle('light', theme === 'auto' && isLightBg(anchor.parentElement || anchor));
        if (this.anchor === anchor && this.host.isConnected) return;
        this.anchor = anchor;
        this.host.removeAttribute('style');
        this.box.classList.remove('floating');
        if (mode === 'prepend') anchor.prepend(this.host);
        else anchor.after(this.host);
      } else if (!this.host.isConnected || this.anchor) {
        // 找不到合适位置就浮在右上角
        this.anchor = null;
        this.box.classList.remove('light');
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

  const bgmUrl = (id) => `https://bangumi.tv/subject/${id}`;

  function bgmTip(b) {
    const names = [b.name, b.nameCn].filter((n, i, a) => n && a.indexOf(n) === i).join(' / ');
    return `匹配到：${names}${b.year ? ` (${b.year})` : ''}` + (b.votes ? ` · ${b.votes.toLocaleString()} 人评分` : '');
  }

  function renderBgm(panel, info, res, onFix) {
    const b = res.bgm;
    const kids = [];
    if (b) {
      kids.push(chip('bgm', 'Bangumi', b.score ? b.score.toFixed(1) : '暂无', bgmUrl(b.id), bgmTip(b)));
      if (b.rank) kids.push(h('span', { class: 'muted', title: 'Bangumi 动画总排名' }, `排名 #${b.rank}`));
    } else {
      kids.push(h('span', { class: 'muted' }, `Bangumi 没找到「${info.title}」`));
    }
    kids.push(h('button', { type: 'button', title: '手动指定 Bangumi 条目', onclick: onFix }, '匹配错了？'));
    if (res.errors.length) kids.push(h('span', { class: 'warn', title: res.errors.join('\n') }, '⚠ ' + res.errors[0]));
    panel.set(kids);
  }

  // ---------------------------------------------------------------- 列表卡片上的 Bangumi 角标

  const BADGE_CSS = `
    :host { all: initial; }
    a { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 5px;
      background: rgba(0,0,0,.75); color: #fff; text-decoration: none; white-space: nowrap;
      font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang TC", "Segoe UI", sans-serif; }
    a:hover { background: rgba(0,0,0,.92); }
    .src { color: #f09199; font-size: 11px; }
  `;

  const badges = new Set();

  function makeBadge(b) {
    const host = h('span', { class: 'sr-bgm-badge' });
    const url = bgmUrl(b.id);
    // 角标在卡片链接里面，点它只开 Bangumi，不触发卡片跳转
    host.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    for (const ev of ['mousedown', 'pointerdown', 'mouseup', 'pointerup']) host.addEventListener(ev, (e) => e.stopPropagation());
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    const tip = `Bangumi ${b.score ? b.score.toFixed(1) : '暂无评分'}${b.rank ? ` · 排名 #${b.rank}` : ''}\n${bgmTip(b)}`;
    root.append(style, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: tip },
      h('span', { class: 'src' }, 'Bgm'), b.score ? b.score.toFixed(1) : '暂无'));
    badges.add(host);
    return host;
  }

  function mountBadge(card, conf, host) {
    if (conf.inline) {
      host.style.cssText = 'display:inline-block;margin-left:6px;vertical-align:middle;line-height:0;';
      (card.querySelector(conf.inline) || card).append(host);
      return;
    }
    const box = (conf.badgeIn && card.querySelector(conf.badgeIn)) || card;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    // 巴哈的海报区域设了 pointer-events:none，角标自己要打开
    host.style.cssText = `position:absolute;${conf.pos || 'left:6px;bottom:6px'};z-index:5;pointer-events:auto;line-height:0;`;
    box.append(host);
  }

  // 卡片一多就是几十上百个请求：只查滚到眼前的，同时最多 3 个，同名的只查一次
  function limiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= n || !queue.length) return;
      active++;
      const [fn, resolve, reject] = queue.shift();
      fn().then(resolve, reject).finally(() => {
        active--;
        next();
      });
    };
    return (fn) => new Promise((resolve, reject) => {
      queue.push([fn, resolve, reject]);
      next();
    });
  }
  const bgmLimit = limiter(3);
  const cardMemo = new Map();
  const cardLookup = (info) => {
    const k = `${norm(info.title)}|${info.year || ''}|${info.recent ? 'r' : ''}`;
    if (!cardMemo.has(k)) cardMemo.set(k, bgmLimit(() => lookupBgm(info)));
    return cardMemo.get(k);
  };

  const cardState = new WeakMap(); // 卡片 → { title, year, conf, host }
  let cardObserver = null;

  async function loadCard(card) {
    const st = cardState.get(card);
    if (!st) return;
    const res = await cardLookup({ title: st.title, year: st.year, recent: st.conf.recent }).catch(() => null);
    // 等结果的工夫卡片可能被 SPA 换成了别的片
    if (cardState.get(card) !== st || !res || !res.bgm) return;
    st.host = makeBadge(res.bgm);
    mountBadge(card, st.conf, st.host);
  }

  function scanCards(site) {
    if (!site.cards || !GM_getValue('bgmCards', true)) return;
    cardObserver = cardObserver || new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cardObserver.unobserve(e.target);
        loadCard(e.target);
      }
    }, { rootMargin: '300px' });
    for (const conf of site.cards) {
      for (const card of document.querySelectorAll(conf.sel)) {
        const t = firstText(conf.title.split(/,\s*/), card);
        const title = aniTitle(t && t.text);
        if (!title) continue;
        const st = cardState.get(card);
        // 已经处理过、片名没变、角标还在（或者还在查）就跳过；React 重绘把角标弄掉了就重挂
        if (st && st.title === title && (!st.host || st.host.isConnected)) continue;
        if (st && st.host) st.host.remove();
        cardState.set(card, { title, year: conf.year ? findYear(card.querySelector(conf.year)) : null, conf, host: null });
        cardObserver.unobserve(card);
        cardObserver.observe(card);
      }
    }
  }

  function removeBadges() {
    for (const b of badges) b.remove();
    badges.clear();
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
  GM_registerMenuCommand('开 / 关动画列表卡片上的 Bangumi 角标', () => {
    const on = !GM_getValue('bgmCards', true);
    GM_setValue('bgmCards', on);
    alert('列表卡片上的 Bangumi 角标已' + (on ? '开启' : '关闭') + '（刷新页面生效）');
    if (!on) removeBadges();
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
    const bgm = info.source === 'bgm';
    const v = prompt(
      bgm
        ? `「${info.title}」匹配不对的话，粘贴正确的 Bangumi 条目链接（bangumi.tv/subject/…）或编号。\n留空则恢复自动匹配。`
        : `「${info.title}」匹配不对的话，粘贴正确的 IMDb 链接/编号（tt…）或豆瓣链接。\n留空则恢复自动匹配。`,
      '',
    );
    if (v === null) return;
    const key = 'ov:' + infoKey(info);
    const ov = GM_getValue(key, {});
    const tt = /tt\d{5,}/.exec(v);
    const db = /douban\.com\/subject\/(\d+)/.exec(v);
    const bg = /subject\/(\d+)/.exec(v) || /^\s*(\d+)\s*$/.exec(v);
    if (!v.trim()) GM_deleteValue(key);
    else if (bgm) {
      if (!bg) return alert('没认出 Bangumi 条目链接');
      GM_setValue(key, { ...ov, bgm: bg[1] });
    } else {
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
      const bgm = info.source === 'bgm';
      const res = await (bgm ? lookupBgm(info) : lookup(info));
      if (my !== token) return;
      (bgm ? renderBgm : render)(panel, info, res, () => fixMatch(info));
    } catch (e) {
      if (my !== token) return;
      panel.set(h('span', { class: 'warn' }, '评分查询失败：' + e.message));
    }
  }

  function tick() {
    const site = SITES.find((s) => s.host.test(location.hostname));
    if (site) scanCards(site);
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
    panel.mount(info.anchor, info.mode, info.theme);

    // 年份/类型往往比片名晚渲染出来，等它们一会儿再查，匹配更准
    if (!cur.started && (info.year || Date.now() - cur.firstSeen > 2000)) {
      cur.started = true;
      run({ title: info.title, year: info.year, kind: info.kind, source: site.source });
    }
  }

  setInterval(tick, 800);
  tick();
})();
