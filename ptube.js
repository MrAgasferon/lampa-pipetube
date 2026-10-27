/*!
 * PipeTube — YouTube в Lampa / ByLampa через инстансы Piped
 * v0.1.1
 *
 * - список инстансов Piped, проверка (API + прокси видео), выбор лучшего, ручной выбор, свой URL
 * - автопереключение инстанса при сбое
 * - главная: рекомендации (по истории), новое в подписках, тренды
 * - поиск, страница канала, подписки (локальные + импорт из Google), история
 * - воспроизведение HLS / MP4 через прокси Piped, прогресс через Lampa.Timeline
 * - SponsorBlock
 */
(function () {
  'use strict';

  if (window.ptube_loaded) return;
  window.ptube_loaded = true;

  var VERSION = '0.1.1';

  var CFG = {
    // Google OAuth-клиент типа «TVs and Limited Input devices» с включённым YouTube Data API v3.
    // Пусто — импорт подписок из Google выключен, локальные подписки работают.
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GOOGLE_SCOPE: 'https://www.googleapis.com/auth/youtube.readonly',

    INSTANCES_URL: 'https://piped-instances.kavin.rocks/',
    FALLBACK: [
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.leptons.xyz',
      'https://api.piped.private.coffee',
      'https://pipedapi.reallyaweso.me',
      'https://pipedapi.drgns.space',
      'https://pipedapi.ducks.party',
      'https://piped-api.privacy.com.de',
      'https://pipedapi.nosebs.ru',
      'https://pipedapi.r4fo.com'
    ],
    TEST_VIDEO: 'jNQXAC9IVRw',
    TEST_QUERIES: ['music', 'news', 'cooking', 'travel', 'review', 'podcast', 'lecture', 'football'],
    PLAY_TRIES: 8,
    CHECK_TTL: 6 * 3600 * 1000,
    CHECK_TIMEOUT: 8000,
    REQ_TIMEOUT: 15000,
    CONCURRENCY: 6,
    DEGRADED_PENALTY: 5000,

    HISTORY_MAX: 50,
    HISTORY_RELATED_KEEP: 10,
    RELATED_PER_VIDEO: 12,
    REC_SEEDS: 6,
    REC_MIN: 20,
    REC_MAX: 40,
    FEED_CHUNK: 30,
    FEED_MAX: 60,
    GOOGLE_IMPORT_TTL: 24 * 3600 * 1000
  };

  var REGIONS = { RU: 'Россия', BY: 'Беларусь', KZ: 'Казахстан', UA: 'Украина', US: 'США', GB: 'Великобритания', DE: 'Германия' };
  var SB_CATS = {
    sponsor: ['sponsor'],
    all: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro']
  };
  var SB_NAMES = { sponsor: 'спонсор', selfpromo: 'самопиар', interaction: 'призыв подписаться', intro: 'заставка', outro: 'концовка' };

  /* ============================================================
   * Утилиты
   * ============================================================ */
  function extend(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }
  function enc(s) { return encodeURIComponent(s); }
  function mkErr(msg, status, data) { var e = new Error(msg); e.status = status || 0; e.data = data; return e; }
  function noty(t) { try { Lampa.Noty.show(t); } catch (e) {} }
  function log() { try { console.log.apply(console, ['[PipeTube]'].concat([].slice.call(arguments))); } catch (e) {} }

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v === null || v === undefined ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { log('storage', e); } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  function setting(name, def) {
    try {
      var v = Lampa.Storage.get(name, def);
      return v === undefined || v === null || v === '' ? def : v;
    } catch (e) { return def; }
  }
  function boolSetting(name, def) { var v = setting(name, def); return v === true || v === 'true'; }

  function normApi(url) {
    url = String(url || '').replace(/^\s+|\s+$/g, '');
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url.replace(/\/+$/, '');
  }
  function hostOf(url) { var m = String(url || '').match(/^https?:\/\/([^\/]+)/i); return m ? m[1] : url; }

  function vidId(url) {
    if (!url) return '';
    var m = String(url).match(/[?&]v=([\w-]{6,})/) || String(url).match(/\/(?:shorts|embed|live)\/([\w-]{6,})/);
    return m ? m[1] : '';
  }
  function chId(url) {
    if (!url) return '';
    var m = String(url).match(/\/channel\/([\w-]+)/);
    return m ? m[1] : '';
  }

  function fmtDur(sec) {
    sec = Math.floor(sec || 0);
    if (sec <= 0) return '';
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }
  function fmtNum(n) {
    if (!(n >= 0)) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + ' млрд';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн';
    if (n >= 1e3) return Math.round(n / 1e3) + ' тыс.';
    return '' + n;
  }
  function fmtAgo(ts) {
    if (!(ts > 0)) return '';
    var d = (Date.now() - ts) / 1000;
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' мин. назад';
    if (d < 86400) return Math.round(d / 3600) + ' ч. назад';
    if (d < 86400 * 30) return Math.round(d / 86400) + ' дн. назад';
    if (d < 86400 * 365) return Math.round(d / 86400 / 30) + ' мес. назад';
    return Math.round(d / 86400 / 365) + ' г. назад';
  }

  function pool(items, n, fn) {
    return new Promise(function (resolve) {
      var out = new Array(items.length), i = 0, active = 0, done = 0;
      if (!items.length) return resolve(out);
      function next() {
        while (active < n && i < items.length) {
          (function (k) {
            active++;
            Promise.resolve().then(function () { return fn(items[k]); })
              .then(function (r) { out[k] = r; }, function () { out[k] = null; })
              .then(function () { active--; done++; if (done === items.length) resolve(out); else next(); });
          })(i++);
        }
      }
      next();
    });
  }

  /* ============================================================
   * HTTP (XHR — работает и в старых WebView)
   * ============================================================ */
  function http(url, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(), t0 = Date.now(), done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { x.abort(); } catch (e) {}
        reject(mkErr('timeout', 0));
      }, o.timeout || CFG.REQ_TIMEOUT);
      try {
        x.open(o.method || 'GET', url, true);
        if (o.headers) for (var h in o.headers) x.setRequestHeader(h, o.headers[h]);
      } catch (e) { done = true; clearTimeout(timer); return reject(mkErr(e.message, 0)); }
      x.onreadystatechange = function () {
        if (done) return;
        if (o.probe && x.readyState >= 2) {
          done = true;
          clearTimeout(timer);
          var st = x.status;
          try { x.abort(); } catch (e) {}
          return st >= 200 && st < 400 ? resolve({ status: st, ms: Date.now() - t0 }) : reject(mkErr('HTTP ' + st, st));
        }
        if (x.readyState !== 4) return;
        done = true;
        clearTimeout(timer);
        var data = null;
        try { data = x.responseText ? JSON.parse(x.responseText) : null; } catch (e) { data = x.responseText; }
        if (x.status >= 200 && x.status < 300) resolve({ status: x.status, data: data, ms: Date.now() - t0 });
        else {
          var msg = data && typeof data === 'object' ? (data.error_description || data.message || data.error) : '';
          if (msg && typeof msg === 'object') msg = msg.message || JSON.stringify(msg);
          reject(mkErr(msg || 'HTTP ' + x.status, x.status, data));
        }
      };
      x.send(o.body || null);
    });
  }
  function form(obj) {
    var a = [];
    for (var k in obj) a.push(enc(k) + '=' + enc(obj[k]));
    return a.join('&');
  }

  /* ============================================================
   * Инстансы Piped
   * ============================================================ */
  function sortInstances(items) {
    items.sort(function (a, b) {
      if (!!b.ok !== !!a.ok) return a.ok ? -1 : 1;
      return (a.ms || 99999) - (b.ms || 99999);
    });
    return items;
  }

  function probeUrl(s) {
    if (s.hls) return s.hls;
    var v = s.videoStreams || [];
    for (var i = 0; i < v.length; i++) if (!v[i].videoOnly && v[i].url) return v[i].url;
    return v[0] && v[0].url || '';
  }

  var Inst = {
    _checking: null,
    data: function () { return store.get('ptube_instances', { at: 0, items: [] }); },
    save: function (d) { store.set('ptube_instances', d); },
    selected: function () { return store.get('ptube_selected', ''); },
    select: function (api) { store.set('ptube_selected', api || ''); },
    manual: function () { return !!this.selected(); },
    customs: function () { return store.get('ptube_custom', []); },
    addCustom: function (url) {
      url = normApi(url);
      if (!url) return '';
      var c = this.customs();
      if (c.indexOf(url) < 0) { c.unshift(url); store.set('ptube_custom', c); }
      var d = this.data();
      if (!d.items.some(function (i) { return i.api === url; })) { d.items.push({ api: url, name: hostOf(url), custom: true }); this.save(d); }
      return url;
    },
    find: function (api) {
      var it = this.data().items;
      for (var i = 0; i < it.length; i++) if (it[i].api === api) return it[i];
      return null;
    },
    best: function () {
      var it = this.data().items;
      for (var i = 0; i < it.length; i++) if (it[i].ok) return it[i];
      return null;
    },
    current: function () {
      var s = this.selected();
      if (s) return this.find(s) || { api: s, name: hostOf(s) };
      return this.best();
    },
    stale: function () { return Date.now() - (this.data().at || 0) > CFG.CHECK_TTL; },

    candidates: function () {
      var self = this;
      return http(CFG.INSTANCES_URL, { timeout: 7000 }).then(function (r) {
        return (Array.isArray(r.data) ? r.data : []).filter(function (i) { return i && i.api_url; }).map(function (i) {
          return { api: normApi(i.api_url), name: i.name || hostOf(i.api_url), loc: i.locations || '' };
        });
      }).catch(function (e) { log('instances list', e.message); return []; }).then(function (list) {
        var seen = {}, out = [];
        self.customs().map(function (u) { return { api: u, name: hostOf(u), custom: true }; })
          .concat(list, CFG.FALLBACK.map(function (u) { return { api: u, name: hostOf(u) }; }))
          .forEach(function (i) { if (i.api && !seen[i.api]) { seen[i.api] = 1; out.push(i); } });
        return out;
      });
    },

    // Свежее видео из поиска на самом инстансе: популярное тестовое видео инстансы отдают из кэша
    // и не показывают бот-блокировку YouTube.
    freshVideo: function (inst) {
      var q = CFG.TEST_QUERIES[Math.floor(Math.random() * CFG.TEST_QUERIES.length)];
      return http(inst.api + '/search?q=' + enc(q) + '&filter=videos', { timeout: CFG.CHECK_TIMEOUT }).then(function (r) {
        var items = normList((r.data && r.data.items) || []).filter(function (v) { return v.kind === 'video' && v.duration > 0; });
        if (!items.length) return CFG.TEST_VIDEO;
        return items[Math.floor(Math.random() * Math.min(items.length, 10))].id;
      }, function () { return CFG.TEST_VIDEO; });
    },

    test: function (inst) {
      var self = this;
      return this.freshVideo(inst).then(function (id) {
        return http(inst.api + '/streams/' + id, { timeout: CFG.CHECK_TIMEOUT });
      }).then(function (r) {
        var s = r.data || {};
        if (s.error) throw mkErr(s.message || s.error);
        var url = probeUrl(s);
        if (!url) throw mkErr('нет потоков');
        return http(url, { probe: true, timeout: CFG.CHECK_TIMEOUT }).then(function (p) {
          return { ok: true, degraded: false, ms: r.ms + p.ms, err: '' };
        }, function (e) {
          return { ok: true, degraded: true, ms: r.ms + CFG.DEGRADED_PENALTY, err: 'прокси видео: ' + e.message };
        });
      }).then(function (res) {
        return extend({}, inst, res, { at: Date.now() });
      }, function (e) {
        return extend({}, inst, { ok: false, degraded: false, ms: 0, err: e.message || 'ошибка', at: Date.now() });
      });
    },

    check: function () {
      var self = this;
      if (this._checking) return this._checking;
      this._checking = this.candidates().then(function (list) {
        return pool(list, CFG.CONCURRENCY, function (i) { return self.test(i); });
      }).then(function (res) {
        var items = sortInstances(res.filter(Boolean));
        self.save({ at: Date.now(), items: items });
        self._checking = null;
        log('checked', items.filter(function (i) { return i.ok; }).length + '/' + items.length);
        return items;
      }, function (e) { self._checking = null; throw e; });
      return this._checking;
    },

    ensure: function () {
      var self = this, s = this.selected();
      if (s) return Promise.resolve(s);
      var b = this.best();
      if (b && !this.stale()) return Promise.resolve(b.api);
      if (b) { this.check().catch(function () {}); return Promise.resolve(b.api); }
      return this.check().then(function () {
        var b2 = self.best();
        if (!b2) throw mkErr('Нет доступных инстансов Piped');
        return b2.api;
      });
    },

    markBad: function (api, msg) {
      var d = this.data();
      d.items.forEach(function (i) { if (i.api === api) { i.ok = false; i.err = msg || 'сбой'; i.at = Date.now(); } });
      sortInstances(d.items);
      this.save(d);
      log('instance failed', api, msg);
    }
  };

  function contentError(e) {
    var m = (e && e.message || '') + ' ' + (e && e.data ? JSON.stringify(e.data) : '');
    if (/bot|sign.?in|log.?in|login_required|confirm you|anonym|po.?token/i.test(m)) return false;
    return /unavailable|private|removed|not available|copyright|terminated|age.?restrict|inappropriate|does not exist|no longer|members.only/i.test(m);
  }
  function shouldFailover(e) {
    if (!e) return false;
    if (e.status === 0 || e.status === 429 || e.status >= 502) return true;
    if (e.status === 500 || e.status === 403) return !contentError(e);
    return false;
  }

  function api(path, opt) {
    opt = opt || {};
    function attempt(left, lastErr) {
      return Inst.ensure().then(function (base) {
        return http(base + path, { timeout: opt.timeout }).then(function (r) { return r.data; }, function (e) {
          if (left > 0 && !Inst.manual() && shouldFailover(e)) {
            Inst.markBad(base, e.message);
            return attempt(left - 1, e);
          }
          throw e;
        });
      }, function (e) { throw lastErr || e; });
    }
    return attempt(opt.failover === false ? 0 : (opt.tries || 2));
  }

  function isBotBlock(e) {
    var m = (e && e.message || '') + ' ' + (e && e.data ? JSON.stringify(e.data) : '');
    return /bot|sign.?in|log.?in|login_required|confirm you|anonym|po.?token/i.test(m);
  }

  /* ============================================================
   * Модель
   * ============================================================ */
  function normItem(i) {
    if (!i) return null;
    if (i.type === 'channel') {
      var cid = chId(i.url);
      if (!cid) return null;
      return { kind: 'channel', id: cid, name: i.name || '', avatar: i.thumbnail || '', subs: i.subscribers, videos: i.videos };
    }
    if (i.type && i.type !== 'stream') return null;
    var id = vidId(i.url);
    if (!id) return null;
    return {
      kind: 'video', id: id, title: i.title || '', thumb: i.thumbnail || '',
      channel: i.uploaderName || '', channelId: chId(i.uploaderUrl), avatar: i.uploaderAvatar || '',
      duration: i.duration, views: i.views, uploaded: i.uploaded, uploadedText: i.uploadedDate || '',
      short: !!i.isShort || /\/shorts\//.test(i.url || '')
    };
  }
  function compact(v) {
    return { kind: 'video', id: v.id, title: v.title, thumb: v.thumb, channel: v.channel, channelId: v.channelId, duration: v.duration, views: v.views, uploaded: v.uploaded, short: v.short };
  }
  function hideShorts() { return boolSetting('ptube_hide_shorts', true); }
  function normList(arr) {
    var hs = hideShorts(), seen = {};
    return (arr || []).map(normItem).filter(function (v) {
      if (!v || seen[v.kind + v.id]) return false;
      seen[v.kind + v.id] = 1;
      return !(hs && v.kind === 'video' && v.short);
    });
  }

  var History = {
    all: function () { return store.get('ptube_history', []); },
    add: function (v, related) {
      var h = this.all().filter(function (x) { return x.id !== v.id; });
      h.unshift(extend(compact(v), { at: Date.now(), related: (related || []).slice(0, CFG.RELATED_PER_VIDEO).map(compact) }));
      h = h.slice(0, CFG.HISTORY_MAX);
      for (var i = CFG.HISTORY_RELATED_KEEP; i < h.length; i++) delete h[i].related;
      store.set('ptube_history', h);
    },
    clear: function () { store.del('ptube_history'); }
  };

  var Subs = {
    list: function () { return store.get('ptube_subs', []); },
    hidden: function () { return store.get('ptube_subs_hidden', []); },
    has: function (id) { return this.list().some(function (s) { return s.id === id; }); },
    add: function (ch) {
      var l = this.list();
      if (!l.some(function (s) { return s.id === ch.id; })) l.push({ id: ch.id, name: ch.name || '', avatar: ch.avatar || '', src: 'local' });
      store.set('ptube_subs', l);
      store.set('ptube_subs_hidden', this.hidden().filter(function (x) { return x !== ch.id; }));
    },
    remove: function (id) {
      var l = this.list(), was = null;
      store.set('ptube_subs', l.filter(function (s) { if (s.id === id) was = s; return s.id !== id; }));
      if (was && was.src === 'google') {
        var h = this.hidden();
        if (h.indexOf(id) < 0) { h.push(id); store.set('ptube_subs_hidden', h); }
      }
    },
    mergeGoogle: function (arr) {
      var hidden = this.hidden(), gIds = {}, l = this.list();
      arr.forEach(function (c) { gIds[c.id] = c; });
      l = l.filter(function (s) { return s.src !== 'google' || gIds[s.id]; });
      var have = {};
      l.forEach(function (s) { have[s.id] = s; });
      arr.forEach(function (c) {
        if (hidden.indexOf(c.id) >= 0) return;
        if (have[c.id]) { have[c.id].name = c.name || have[c.id].name; have[c.id].avatar = c.avatar || have[c.id].avatar; return; }
        l.push({ id: c.id, name: c.name, avatar: c.avatar, src: 'google' });
      });
      store.set('ptube_subs', l);
      return l.length;
    },
    detachGoogle: function () {
      store.set('ptube_subs', this.list().map(function (s) { s.src = 'local'; return s; }));
      store.del('ptube_subs_hidden');
    }
  };

  function loadFeed() {
    var ids = Subs.list().map(function (s) { return s.id; });
    if (!ids.length) return Promise.resolve([]);
    var chunks = [];
    for (var i = 0; i < ids.length; i += CFG.FEED_CHUNK) chunks.push(ids.slice(i, i + CFG.FEED_CHUNK));
    return Promise.all(chunks.map(function (c) {
      return api('/feed/unauthenticated?channels=' + c.join(',')).catch(function (e) { log('feed', e.message); return []; });
    })).then(function (arrs) {
      var all = [];
      arrs.forEach(function (a) { if (Array.isArray(a)) all = all.concat(a); });
      return normList(all).filter(function (v) { return v.kind === 'video'; })
        .sort(function (a, b) { return (b.uploaded || 0) - (a.uploaded || 0); })
        .slice(0, CFG.FEED_MAX);
    });
  }

  function loadTrending() {
    return api('/trending?region=' + setting('ptube_region', 'RU')).then(function (d) {
      return normList(Array.isArray(d) ? d : []).filter(function (v) { return v.kind === 'video'; });
    });
  }

  // Вариант A: related к недавно просмотренным + свежее из подписок + тренды
  function buildRecs(feed, trending) {
    var hist = History.all(), watched = {}, out = [], seen = {}, hs = hideShorts();
    hist.forEach(function (h) { watched[h.id] = 1; });
    function add(v) {
      if (!v || seen[v.id] || watched[v.id] || (hs && v.short)) return false;
      seen[v.id] = 1;
      out.push(v);
      return true;
    }
    var lists = hist.slice(0, CFG.REC_SEEDS).map(function (h) { return h.related || []; });
    var related = [];
    for (var r = 0; r < CFG.RELATED_PER_VIDEO; r++) lists.forEach(function (l) { if (l[r]) related.push(l[r]); });
    if (!related.length) return [];
    var fresh = (feed || []).slice(0, 15), tr = (trending || []).slice(0, 15), fi = 0, ti = 0;
    related.forEach(function (v, idx) {
      add(v);
      if (idx % 4 === 3) {
        while (fi < fresh.length && !add(fresh[fi++])) {}
      }
      if (idx % 8 === 7) {
        while (ti < tr.length && !add(tr[ti++])) {}
      }
    });
    // короткая история — добиваем свежим из подписок, потом трендами
    while (out.length < CFG.REC_MIN && fi < fresh.length) add(fresh[fi++]);
    while (out.length < CFG.REC_MIN && ti < tr.length) add(tr[ti++]);
    return out.slice(0, CFG.REC_MAX);
  }

  /* ============================================================
   * Воспроизведение + SponsorBlock
   * ============================================================ */
  function buildQuality(s) {
    var map = {}, muxed = (s.videoStreams || []).filter(function (x) { return !x.videoOnly && x.url; })
      .sort(function (a, b) { return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0); });
    if (s.hls) map['Авто (HLS)'] = s.hls;
    muxed.forEach(function (x) {
      var k = (x.quality || '?') + (x.format ? ' ' + x.format : '');
      if (!map[k]) map[k] = x.url;
    });
    var pref = setting('ptube_quality', 'hls'), first = '';
    if (s.livestream) first = s.hls || '';
    else if (pref === 'hls') first = s.hls || (muxed[0] && muxed[0].url) || '';
    else first = (muxed[0] && muxed[0].url) || s.hls || '';
    return { map: map, first: first };
  }

  function timelineFor(id) {
    try { return Lampa.Timeline.view(Lampa.Utils.hash('ptube_' + id)); } catch (e) { return null; }
  }

  var Sponsor = {
    vid: null, segs: [],
    load: function (id) {
      var self = this, mode = setting('ptube_sponsor', 'sponsor');
      this.vid = null;
      this.segs = [];
      if (!SB_CATS[mode]) return;
      this.vid = id;
      api('/sponsors/' + id + '?category=' + enc(JSON.stringify(SB_CATS[mode])), { failover: false, timeout: 8000 }).then(function (d) {
        if (self.vid !== id) return;
        self.segs = ((d && d.segments) || []).filter(function (s) { return s.segment && s.segment[1] > s.segment[0]; })
          .map(function (s) { return { a: +s.segment[0], b: +s.segment[1], cat: s.category, done: false }; });
        log('sponsor segments', self.segs.length);
      }).catch(function () {});
    },
    tick: function (t) {
      if (!this.vid || !this.segs.length || !(t >= 0)) return;
      for (var i = 0; i < this.segs.length; i++) {
        var s = this.segs[i];
        if (!s.done && t >= s.a && t < s.b - 0.5) {
          s.done = true;
          try { Lampa.PlayerVideo.to(s.b); } catch (e) {}
          noty('Пропущено: ' + (SB_NAMES[s.cat] || s.cat));
          return;
        }
      }
    },
    reset: function () { this.vid = null; this.segs = []; }
  };

  function play(v, opt) {
    opt = opt || {};
    var cancelled = false;
    try { Lampa.Loading.start(function () { cancelled = true; Lampa.Loading.stop(); }); } catch (e) {}
    return api('/streams/' + v.id, { tries: CFG.PLAY_TRIES }).then(function (s) {
      try { Lampa.Loading.stop(); } catch (e) {}
      if (cancelled) return;
      if (!s || s.error) throw mkErr((s && (s.message || s.error)) || 'пустой ответ');
      var q = buildQuality(s);
      if (opt.mp4) {
        var mp4 = (s.videoStreams || []).filter(function (x) { return !x.videoOnly && x.url; })[0];
        if (mp4) q.first = mp4.url;
      }
      if (!q.first) { noty('Нет воспроизводимых потоков'); return; }

      var item = extend({}, v, {
        kind: 'video', title: s.title || v.title, thumb: s.thumbnailUrl || v.thumb,
        channel: s.uploader || v.channel, channelId: chId(s.uploaderUrl) || v.channelId, duration: s.duration || v.duration
      });
      History.add(item, normList(s.relatedStreams).filter(function (x) { return x.kind === 'video'; }));

      var data = { title: item.title, url: q.first, quality: q.map };
      var tl = timelineFor(v.id);
      if (tl && !s.livestream) data.timeline = tl;
      var subs = (s.subtitles || []).filter(function (t) { return t.url && /vtt|srt/i.test(t.mimeType || t.url); }).map(function (t) {
        return { label: (t.name || t.code || '?') + (t.autoGenerated ? ' (авто)' : ''), url: t.url };
      });
      if (subs.length) data.subtitles = subs;

      Lampa.Player.play(data);
      try { Lampa.Player.playlist([data]); } catch (e) {}
      if (!s.livestream) Sponsor.load(v.id); else Sponsor.reset();
      return data;
    }).catch(function (e) {
      try { Lampa.Loading.stop(); } catch (er) {}
      if (!cancelled) {
        if (isBotBlock(e)) noty(Inst.manual()
          ? 'YouTube блокирует этот инстанс (требует вход). Выберите другой или «Авто»'
          : 'YouTube блокирует все проверенные инстансы. Попробуйте «Перепроверить все» позже');
        else noty('Не удалось открыть видео: ' + (e.message || e));
      }
      log('play', e);
    });
  }

  /* ============================================================
   * Google: Device Flow + импорт подписок
   * ============================================================ */
  var Google = {
    configured: function () { return !!CFG.GOOGLE_CLIENT_ID; },
    auth: function () { return store.get('ptube_google', null); },
    loggedIn: function () { var a = this.auth(); return !!(a && a.refresh_token); },

    token: function () {
      var a = this.auth();
      if (!a || !a.refresh_token) return Promise.reject(mkErr('не выполнен вход'));
      if (a.access_token && a.expires_at > Date.now() + 60000) return Promise.resolve(a.access_token);
      return http('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: CFG.GOOGLE_CLIENT_ID, client_secret: CFG.GOOGLE_CLIENT_SECRET, refresh_token: a.refresh_token, grant_type: 'refresh_token' })
      }).then(function (r) {
        a.access_token = r.data.access_token;
        a.expires_at = Date.now() + (r.data.expires_in || 3600) * 1000;
        store.set('ptube_google', a);
        return a.access_token;
      }, function (e) {
        if (e.status === 400 || e.status === 401) { store.del('ptube_google'); noty('Сессия Google истекла, войдите заново'); }
        throw e;
      });
    },

    login: function (back) {
      var self = this, cancelled = false;
      function close() {
        cancelled = true;
        try { Lampa.Modal.close(); } catch (e) {}
        try { Lampa.Controller.toggle(back || 'settings_component'); } catch (e) {}
      }
      http('https://oauth2.googleapis.com/device/code', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: CFG.GOOGLE_CLIENT_ID, scope: CFG.GOOGLE_SCOPE })
      }).then(function (r) {
        var d = r.data, interval = (d.interval || 5) * 1000, until = Date.now() + (d.expires_in || 1800) * 1000;
        var html = $('<div class="ptube-auth"></div>');
        html.append($('<div class="ptube-auth__line"></div>').text('Откройте на телефоне или компьютере:'));
        html.append($('<div class="ptube-auth__url"></div>').text(d.verification_url || 'google.com/device'));
        html.append($('<div class="ptube-auth__line"></div>').text('и введите код:'));
        html.append($('<div class="ptube-auth__code"></div>').text(d.user_code));
        html.append($('<div class="ptube-auth__line ptube-auth__hint"></div>').text('Доступ только на чтение: список подписок. Окно закроется само.'));
        Lampa.Modal.open({ title: 'Вход в Google', html: html, size: 'medium', onBack: close });

        function poll() {
          if (cancelled) return;
          if (Date.now() > until) { close(); noty('Код истёк, попробуйте снова'); return; }
          http('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form({ client_id: CFG.GOOGLE_CLIENT_ID, client_secret: CFG.GOOGLE_CLIENT_SECRET, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
          }).then(function (t) {
            if (cancelled) return;
            store.set('ptube_google', {
              refresh_token: t.data.refresh_token, access_token: t.data.access_token,
              expires_at: Date.now() + (t.data.expires_in || 3600) * 1000
            });
            close();
            noty('Google подключён, импортирую подписки…');
            self.importSubs().catch(function () {});
          }, function (e) {
            if (cancelled) return;
            var code = e.data && e.data.error;
            if (code === 'authorization_pending') return setTimeout(poll, interval);
            if (code === 'slow_down') { interval += 5000; return setTimeout(poll, interval); }
            close();
            noty('Вход не выполнен: ' + (code || e.message));
          });
        }
        setTimeout(poll, interval);
      }).catch(function (e) { noty('Google: ' + e.message); });
    },

    importSubs: function () {
      var out = [];
      function page(token, pageToken) {
        var url = 'https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50' + (pageToken ? '&pageToken=' + enc(pageToken) : '');
        return http(url, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
          (r.data.items || []).forEach(function (it) {
            var sn = it.snippet || {}, id = sn.resourceId && sn.resourceId.channelId;
            if (id) out.push({ id: id, name: sn.title || '', avatar: (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails['default']) || {}).url || '' });
          });
          if (r.data.nextPageToken && out.length < 5000) return page(token, r.data.nextPageToken);
        });
      }
      return this.token().then(function (t) { return page(t); }).then(function () {
        var n = Subs.mergeGoogle(out);
        store.set('ptube_google_import_at', Date.now());
        noty('Подписки из Google: ' + out.length + ', всего ' + n);
        return out.length;
      }).catch(function (e) {
        noty('Импорт подписок: ' + e.message);
        throw e;
      });
    },

    autoImport: function () {
      if (!this.configured() || !this.loggedIn()) return;
      if (Date.now() - store.get('ptube_google_import_at', 0) < CFG.GOOGLE_IMPORT_TTL) return;
      this.importSubs().catch(function () {});
    },

    logout: function () {
      var a = this.auth();
      if (a && a.refresh_token) http('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: a.refresh_token })
      }).catch(function () {});
      store.del('ptube_google');
      store.del('ptube_google_import_at');
      Subs.detachGoogle();
      noty('Google отключён. Подписки остались локально');
    }
  };

  /* ============================================================
   * Меню инстансов
   * ============================================================ */
  function instDescr(i) {
    if (!i) return 'не выбран';
    if (i.ok === undefined) return i.name + ' — не проверен';
    if (!i.ok) return i.name + ' — недоступен' + (i.err ? ' (' + i.err + ')' : '');
    return i.name + ' — ' + i.ms + ' мс' + (i.degraded ? ', прокси видео не ответил' : '');
  }

  function showInstanceMenu(back) {
    back = back || 'content';
    var sel = Inst.selected(), d = Inst.data(), best = Inst.best();
    var items = [{ title: 'Авто: лучший', subtitle: best ? instDescr(best) : 'нет проверенных', selected: !sel, act: 'auto' }];
    d.items.forEach(function (i) {
      items.push({ title: (i.custom ? '★ ' : '') + i.name, subtitle: instDescr(i).replace(i.name + ' — ', ''), selected: sel === i.api, act: 'pick', api: i.api, ghost: !i.ok });
    });
    items.push({ title: 'Перепроверить все', subtitle: d.at ? 'последняя проверка: ' + fmtAgo(d.at) : 'ещё не проверялись', act: 'check' });
    items.push({ title: 'Добавить свой URL API', subtitle: 'например pipedapi.example.com', act: 'custom' });

    Lampa.Select.show({
      title: 'Инстанс Piped',
      items: items,
      onBack: function () { Lampa.Controller.toggle(back); },
      onSelect: function (a) {
        if (a.act === 'auto') { Inst.select(''); noty('Автовыбор инстанса'); Lampa.Controller.toggle(back); }
        else if (a.act === 'pick') { Inst.select(a.api); noty('Инстанс: ' + hostOf(a.api)); Lampa.Controller.toggle(back); }
        else if (a.act === 'check') {
          Lampa.Controller.toggle(back);
          noty('Проверяю инстансы…');
          Inst.check().then(function (r) {
            noty('Доступно: ' + r.filter(function (i) { return i.ok; }).length + ' из ' + r.length);
            showInstanceMenu(back);
          }).catch(function (e) { noty('Проверка: ' + e.message); });
        } else if (a.act === 'custom') {
          Lampa.Input.edit({ title: 'URL API Piped', value: '', free: true, nosave: true }, function (val) {
            var url = Inst.addCustom(val);
            if (!url) { Lampa.Controller.toggle(back); return; }
            noty('Проверяю ' + hostOf(url) + '…');
            Inst.test({ api: url, name: hostOf(url), custom: true }).then(function (r) {
              var dd = Inst.data();
              dd.items = sortInstances(dd.items.filter(function (i) { return i.api !== url; }).concat([r]));
              Inst.save(dd);
              Inst.select(url);
              noty(instDescr(r));
              Lampa.Controller.toggle(back);
            });
          });
        }
      }
    });
  }

  /* ============================================================
   * UI: стили, карточки, компонент
   * ============================================================ */
  var CSS = '' +
    '.ptube{padding:0 1.5em 3em}' +
    '.ptube-head{display:flex;flex-wrap:wrap;padding:1.2em 0 .4em}' +
    '.ptube-btn{padding:.6em 1.2em;margin:0 .8em .8em 0;border-radius:1em;background:rgba(255,255,255,.08);font-size:1.1em}' +
    '.ptube-btn.focus{background:#fff;color:#000}' +
    '.ptube-title{padding:1em 0 .2em}.ptube-title__name{font-size:2em;font-weight:600}.ptube-title__sub{opacity:.6;margin-top:.3em}' +
    '.ptube-sec__title{font-size:1.5em;font-weight:600;margin:1em 0 .5em}' +
    '.ptube-grid{display:flex;flex-wrap:wrap;margin:0 -.6em}' +
    '.ptube-card{width:20%;padding:.6em;box-sizing:border-box}' +
    '.ptube-card__img{position:relative;padding-bottom:56.25%;border-radius:.8em;background:rgba(255,255,255,.06) center/cover no-repeat}' +
    '.ptube-card.focus .ptube-card__img{box-shadow:0 0 0 .25em #fff}' +
    '.ptube-card__dur{position:absolute;right:.4em;bottom:.4em;background:rgba(0,0,0,.8);padding:.1em .4em;border-radius:.3em;font-size:.85em}' +
    '.ptube-card__bar{position:absolute;left:0;bottom:0;height:.25em;background:#e53935;border-radius:0 0 0 .8em}' +
    '.ptube-card__title{margin-top:.5em;font-size:1.05em;line-height:1.3;max-height:2.6em;overflow:hidden}' +
    '.ptube-card__meta{opacity:.6;font-size:.9em;margin-top:.2em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.ptube-card--channel .ptube-card__img{width:62%;padding-bottom:62%;margin:0 auto;border-radius:50%}' +
    '.ptube-card--channel .ptube-card__title,.ptube-card--channel .ptube-card__meta{text-align:center}' +
    '.ptube-card--more .ptube-card__img{display:flex}.ptube-more{position:absolute;top:50%;left:0;right:0;text-align:center;transform:translateY(-50%);font-size:1.3em}' +
    '.ptube-empty{opacity:.6;padding:.6em}' +
    '.ptube-auth{padding:1em;text-align:center;line-height:1.6}.ptube-auth__url{font-size:1.4em;font-weight:600}' +
    '.ptube-auth__code{font-size:2.4em;font-weight:700;letter-spacing:.15em;margin:.3em 0}.ptube-auth__hint{opacity:.6;font-size:.9em;margin-top:.8em}' +
    '@media (max-width:1100px){.ptube-card{width:25%}}@media (max-width:800px){.ptube-card{width:33.33%}}@media (max-width:560px){.ptube-card{width:50%}}';

  function push(view, title, extra) {
    Lampa.Activity.push(extend({ url: '', title: title, component: 'ptube', view: view, page: 1 }, extra));
  }

  function searchPrompt() {
    Lampa.Input.edit({ title: 'Поиск', value: store.get('ptube_last_query', ''), free: true, nosave: true }, function (val) {
      val = String(val || '').replace(/^\s+|\s+$/g, '');
      if (!val) { Lampa.Controller.toggle('content'); return; }
      store.set('ptube_last_query', val);
      push('search', 'Поиск: ' + val, { query: val });
    });
  }

  function cardMenu(v) {
    var items = [];
    if (v.kind === 'video') {
      items.push({ title: 'Воспроизвести', act: function () { play(v); } });
      items.push({ title: 'Воспроизвести MP4 (совместимость)', act: function () { play(v, { mp4: true }); } });
    }
    var cid = v.kind === 'channel' ? v.id : v.channelId;
    if (cid) {
      var cname = v.kind === 'channel' ? v.name : v.channel;
      items.push({ title: 'Открыть канал', act: function () { push('channel', cname || 'Канал', { channel_id: cid }); } });
      items.push(Subs.has(cid)
        ? { title: 'Отписаться', act: function () { Subs.remove(cid); noty('Отписка: ' + cname); } }
        : { title: 'Подписаться', act: function () { Subs.add({ id: cid, name: cname, avatar: v.avatar }); noty('Подписка: ' + cname); } });
    }
    Lampa.Select.show({
      title: v.title || v.name || '',
      items: items,
      onBack: function () { Lampa.Controller.toggle('content'); },
      onSelect: function (a) { Lampa.Controller.toggle('content'); a.act(); }
    });
  }

  function Component(object) {
    var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
    var body = $('<div class="ptube"></div>');
    var last = null, alive = true;

    function refresh() {
      if (!alive) return;
      try {
        if (Lampa.Controller.enabled().name === 'content') Lampa.Controller.collectionSet(scroll.render());
      } catch (e) {}
    }
    function bind(el, onEnter, onLong) {
      el.on('hover:focus', function () { last = el[0]; scroll.update(el, true); });
      el.on('hover:enter', onEnter);
      if (onLong) el.on('hover:long', onLong);
      return el;
    }

    function card(v) {
      var el = $('<div class="ptube-card selector"><div class="ptube-card__img"></div><div class="ptube-card__title"></div><div class="ptube-card__meta"></div></div>');
      var img = el.find('.ptube-card__img');
      if (v.kind === 'channel') {
        el.addClass('ptube-card--channel');
        if (v.avatar) img.css('background-image', 'url("' + v.avatar + '")');
        el.find('.ptube-card__title').text(v.name);
        el.find('.ptube-card__meta').text(v.subs > 0 ? fmtNum(v.subs) + ' подписчиков' : (Subs.has(v.id) ? 'подписка' : ''));
        return bind(el, function () { push('channel', v.name || 'Канал', { channel_id: v.id }); }, function () { cardMenu(v); });
      }
      if (v.thumb) img.css('background-image', 'url("' + v.thumb + '")');
      if (v.duration > 0) img.append($('<div class="ptube-card__dur"></div>').text(fmtDur(v.duration)));
      else if (v.duration === -1) img.append($('<div class="ptube-card__dur"></div>').text('LIVE'));
      var tl = timelineFor(v.id);
      if (tl && tl.percent > 0) img.append($('<div class="ptube-card__bar"></div>').css('width', Math.min(100, tl.percent) + '%'));
      el.find('.ptube-card__title').text(v.title);
      el.find('.ptube-card__meta').text([v.channel, v.views > 0 ? fmtNum(v.views) + ' просм.' : '', fmtAgo(v.uploaded) || v.uploadedText].filter(Boolean).join(' · '));
      return bind(el, function () { play(v); }, function () { cardMenu(v); });
    }

    var ui = {
      head: function (btns) {
        var h = $('<div class="ptube-head"></div>');
        btns.forEach(function (b) {
          if (!b) return;
          var el = $('<div class="ptube-btn selector"></div>').text(b[0]);
          bind(el, function () { b[1](el); });
          h.append(el);
        });
        body.append(h);
        return h;
      },
      title: function (name, sub) {
        var t = $('<div class="ptube-title"><div class="ptube-title__name"></div><div class="ptube-title__sub"></div></div>');
        t.find('.ptube-title__name').text(name || '');
        t.find('.ptube-title__sub').text(sub || '');
        body.append(t);
        return t;
      },
      section: function (title) {
        var s = $('<div class="ptube-sec"><div class="ptube-sec__title"></div><div class="ptube-grid"><div class="ptube-empty">Загрузка…</div></div></div>');
        s.find('.ptube-sec__title').text(title);
        body.append(s);
        return { el: s, grid: s.find('.ptube-grid') };
      },
      fill: function (sec, items, emptyText) {
        sec.grid.find('.ptube-empty').remove();
        if (!items.length) {
          if (emptyText === null) sec.el.remove();
          else sec.grid.append($('<div class="ptube-empty"></div>').text(emptyText || 'Пусто'));
        }
        items.forEach(function (v) { sec.grid.append(card(v)); });
        refresh();
      },
      error: function (sec, e) {
        sec.grid.find('.ptube-empty').remove();
        sec.grid.append($('<div class="ptube-empty"></div>').text('Ошибка: ' + (e && e.message || e)));
        refresh();
      },
      paged: function (sec, promise, emptyText) {
        promise.then(function (r) {
          if (!alive) return;
          ui.fill(sec, r.items, emptyText);
          if (r.next) {
            var btn = $('<div class="ptube-card ptube-card--more selector"><div class="ptube-card__img"><div class="ptube-more">Ещё…</div></div></div>');
            bind(btn, function () {
              btn.find('.ptube-more').text('Загрузка…');
              r.next().then(function (r2) {
                if (!alive) return;
                var prev = btn.prev();
                btn.remove();
                ui.paged(sec, Promise.resolve(r2), '');
                var nxt = prev.next();
                if (nxt.length) { try { Lampa.Controller.collectionFocus(nxt[0], scroll.render()); } catch (e) {} }
              }, function (e) { btn.find('.ptube-more').text('Ошибка, ещё раз'); log(e); });
            });
            sec.grid.append(btn);
            refresh();
          }
        }, function (e) { if (alive) ui.error(sec, e); });
      }
    };

    this.create = function () {
      var self = this;
      scroll.minus();
      scroll.append(body);
      this.activity.loader(true);
      var view = Views[object.view] || Views.main;
      var needsInst = view !== Views.subs && view !== Views.history;
      (needsInst ? Inst.ensure() : Promise.resolve()).then(function () {
        if (!alive) return;
        view(object, ui);
      }, function (e) {
        if (!alive) return;
        ui.title('Нет доступного инстанса Piped', e.message || '');
        ui.head([['Выбрать инстанс', function () { showInstanceMenu('content'); }]]);
      }).then(function () {
        if (!alive) return;
        self.activity.loader(false);
        self.activity.toggle();
      });
      return this.render();
    };

    this.start = function () {
      try { if (Lampa.Activity.active().activity !== this.activity) return; } catch (e) {}
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
        right: function () { Navigator.move('right'); },
        up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
        down: function () { Navigator.move('down'); },
        back: function () { Lampa.Activity.backward(); }
      });
      Lampa.Controller.toggle('content');
    };
    this.pause = function () {};
    this.stop = function () {};
    this.render = function () { return scroll.render(); };
    this.destroy = function () {
      alive = false;
      try { scroll.destroy(); } catch (e) {}
      body.remove();
    };
  }

  /* ============================================================
   * Экраны
   * ============================================================ */
  function pageOf(path, nextPath) {
    return api(path).then(function (d) {
      var items = normList(d.items || d.relatedStreams || []);
      return { items: items, next: d.nextpage ? function () { return pageOf(nextPath(d.nextpage), nextPath); } : null, raw: d };
    });
  }

  var Views = {
    main: function (o, ui) {
      var cur = Inst.current();
      ui.head([
        ['Поиск', searchPrompt],
        ['Подписки (' + Subs.list().length + ')', function () { push('subs', 'Подписки'); }],
        ['История', function () { push('history', 'История'); }],
        ['Инстанс: ' + (cur ? hostOf(cur.api) : '—'), function () { showInstanceMenu('content'); }]
      ]);
      var hasHist = History.all().length > 0, hasSubs = Subs.list().length > 0;
      var secRec = ui.section('Рекомендации');
      var secFeed = hasSubs ? ui.section('Новое в подписках') : null;
      var secTr = ui.section('Тренды');

      var feedP = loadFeed().catch(function () { return []; });
      var trP = loadTrending();
      if (secFeed) feedP.then(function (f) { ui.fill(secFeed, f, 'Нет новых видео'); });
      trP.then(function (t) { ui.fill(secTr, t, 'Тренды недоступны на этом инстансе'); }, function (e) { ui.error(secTr, e); });
      Promise.all([feedP, trP.catch(function () { return []; })]).then(function (r) {
        var recs = buildRecs(r[0], r[1]);
        ui.fill(secRec, recs, hasHist ? 'Пока нечего порекомендовать' : 'Посмотрите пару видео — рекомендации строятся по истории просмотров');
      });
    },

    search: function (o, ui) {
      ui.head([['Новый поиск', searchPrompt]]);
      var q = o.query || '';
      ui.paged(ui.section('Результаты: ' + q), pageOf('/search?q=' + enc(q) + '&filter=all', function (np) {
        return '/nextpage/search?q=' + enc(q) + '&filter=all&nextpage=' + enc(np);
      }), 'Ничего не найдено');
    },

    channel: function (o, ui) {
      var id = o.channel_id;
      var title = ui.title(o.title || 'Канал', '');
      ui.head([[Subs.has(id) ? 'Отписаться' : 'Подписаться', function (el) {
        if (Subs.has(id)) { Subs.remove(id); el.text('Подписаться'); noty('Отписка'); }
        else { Subs.add({ id: id, name: title.find('.ptube-title__name').text(), avatar: title.data('avatar') }); el.text('Отписаться'); noty('Подписка оформлена'); }
      }]]);
      var sec = ui.section('Видео');
      var p = pageOf('/channel/' + id, function (np) { return '/nextpage/channel/' + id + '?nextpage=' + enc(np); });
      p.then(function (r) {
        var d = r.raw || {};
        title.find('.ptube-title__name').text(d.name || o.title || '');
        title.find('.ptube-title__sub').text(d.subscriberCount > 0 ? fmtNum(d.subscriberCount) + ' подписчиков' : '');
        title.data('avatar', d.avatarUrl || '');
        if (Subs.has(id) && d.avatarUrl) {
          var l = Subs.list();
          l.forEach(function (s) { if (s.id === id) { s.avatar = d.avatarUrl; s.name = d.name || s.name; } });
          store.set('ptube_subs', l);
        }
      }, function () {});
      ui.paged(sec, p, 'На канале нет видео');
    },

    subs: function (o, ui) {
      var btns = [];
      if (Google.configured()) {
        btns.push(Google.loggedIn()
          ? ['Обновить из Google', function () { Google.importSubs().then(function () { Lampa.Activity.replace(); }); }]
          : ['Импорт из Google: в настройках', function () { noty('Настройки → PipeTube → Google'); }]);
      }
      if (btns.length) ui.head(btns);
      var list = Subs.list().slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      ui.fill(ui.section('Каналы: ' + list.length), list.map(function (s) {
        return { kind: 'channel', id: s.id, name: s.name, avatar: s.avatar };
      }), 'Подписок нет. Подписаться можно со страницы канала или долгим нажатием на видео');
    },

    history: function (o, ui) {
      ui.head([['Очистить историю', function () { History.clear(); noty('История очищена'); Lampa.Activity.backward(); }]]);
      ui.fill(ui.section('Просмотренные'), History.all(), 'История пуста');
    }
  };

  /* ============================================================
   * Настройки
   * ============================================================ */
  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({ component: 'ptube', name: 'PipeTube', icon: ICON });

    function button(name, title, descr, onChange) {
      Lampa.SettingsApi.addParam({
        component: 'ptube', param: { name: name, type: 'button' },
        field: { name: title, description: typeof descr === 'function' ? descr() : descr },
        onRender: function (item) { if (typeof descr === 'function') { try { item.find('.settings-param__descr').text(descr()); } catch (e) {} } },
        onChange: onChange
      });
    }

    button('ptube_inst_btn', 'Инстанс Piped', function () {
      var c = Inst.current();
      return (Inst.manual() ? 'Вручную: ' : 'Авто: ') + instDescr(c);
    }, function () { showInstanceMenu('settings_component'); });

    Lampa.SettingsApi.addParam({
      component: 'ptube', param: { name: 'ptube_quality', type: 'select', values: { hls: 'HLS (до 1080p)', mp4: 'MP4 (360p, совместимость)' }, 'default': 'hls' },
      field: { name: 'Поток по умолчанию', description: 'Если HLS не играет на устройстве — переключите на MP4' }
    });
    Lampa.SettingsApi.addParam({
      component: 'ptube', param: { name: 'ptube_region', type: 'select', values: REGIONS, 'default': 'RU' },
      field: { name: 'Регион трендов' }
    });
    Lampa.SettingsApi.addParam({
      component: 'ptube', param: { name: 'ptube_hide_shorts', type: 'trigger', 'default': true },
      field: { name: 'Скрывать Shorts' }
    });
    Lampa.SettingsApi.addParam({
      component: 'ptube', param: { name: 'ptube_sponsor', type: 'select', values: { off: 'Выключен', sponsor: 'Только спонсорские вставки', all: 'Спонсоры, самопиар, заставки, концовки' }, 'default': 'sponsor' },
      field: { name: 'SponsorBlock', description: 'Автоматически пропускать отмеченные сообществом фрагменты' }
    });

    button('ptube_google_btn', 'Подписки из Google', function () {
      if (!Google.configured()) return 'Не настроено: нужен OAuth-клиент (см. README)';
      if (!Google.loggedIn()) return 'Войти и импортировать подписки YouTube (только чтение)';
      var at = store.get('ptube_google_import_at', 0);
      return 'Подключено' + (at ? ', импорт ' + fmtAgo(at) : '') + '. Обновляется раз в сутки';
    }, function () {
      if (!Google.configured()) { noty('OAuth-клиент не задан в плагине'); return; }
      if (!Google.loggedIn()) { Google.login('settings_component'); return; }
      Lampa.Select.show({
        title: 'Google',
        items: [{ title: 'Импортировать подписки сейчас', act: 'import' }, { title: 'Выйти', subtitle: 'подписки останутся локально', act: 'logout' }],
        onBack: function () { Lampa.Controller.toggle('settings_component'); },
        onSelect: function (a) {
          Lampa.Controller.toggle('settings_component');
          if (a.act === 'import') Google.importSubs().catch(function () {});
          else Google.logout();
        }
      });
    });

    button('ptube_clear_btn', 'Очистить историю', function () { return 'Записей: ' + History.all().length + '. Рекомендации строятся по ней'; }, function () {
      History.clear();
      noty('История очищена');
    });

    button('ptube_about', 'О плагине', 'PipeTube ' + VERSION, function () {});
  }

  /* ============================================================
   * Запуск
   * ============================================================ */
  var ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 8.5v7l6-3.5z" fill="currentColor"/></svg>';

  function addMenu() {
    var item = $('<li class="menu__item selector" data-action="ptube"><div class="menu__ico">' + ICON + '</div><div class="menu__text">YouTube</div></li>');
    item.on('hover:enter', function () { push('main', 'YouTube'); });
    $('.menu .menu__list').eq(0).append(item);
  }

  function bindPlayer() {
    try { Lampa.PlayerVideo.listener.follow('timeupdate', function (e) { Sponsor.tick(e && e.current); }); } catch (e) {}
    try { Lampa.Player.listener.follow('destroy', function () { Sponsor.reset(); }); } catch (e) {}
  }

  function start() {
    if (window.ptube_started) return;
    window.ptube_started = true;
    $('head').append('<style id="ptube-css">' + CSS + '</style>');
    Lampa.Component.add('ptube', Component);
    addMenu();
    addSettings();
    bindPlayer();
    setTimeout(function () {
      if (Inst.stale()) Inst.check().catch(function () {});
      Google.autoImport();
    }, 3000);
  }

  window.ptube = {
    version: VERSION, CFG: CFG, Inst: Inst, api: api, play: play, Subs: Subs, History: History, Google: Google, Sponsor: Sponsor,
    _t: { buildRecs: buildRecs, buildQuality: buildQuality, loadFeed: loadFeed, normList: normList, shouldFailover: shouldFailover, Views: Views, Component: Component, start: start }
  };

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
