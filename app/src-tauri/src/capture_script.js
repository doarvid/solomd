// SoloMD 注入脚本 —— 在 chat.deepseek.com 的页面里运行。
//
// 编译期由 browser.rs `include_str!` 内嵌，拼进子 webview 的
// initialization_script。**不调用任何 Tauri API** —— 数据经哨兵 URL 由
// Rust 侧的 on_navigation 截获（见 browser.rs 的说明）。
//
// 提取方式参考 obsidian-omnichat/ai.js：调 DeepSeek 自己的
// /api/v0/chat/history_messages 拿结构化 JSON，而不是抓 DOM。
// 好处是引用链接带 url+title、深度思考内容拿得到、前端改 class 不影响。
//
// 这是一份**不能 import 任何东西**的普通脚本，下面所有函数都是自包含的。

(function () {
  if (window.__solomd) return;

  var SENTINEL = 'https://solomd.invalid/capture';
  var CHUNK = 200000;

  // ---------------------------------------------------------------- 传输

  // base64 而不是 encodeURIComponent：base64 的字符集是 A-Za-z0-9+/=，
  // 不含 %，URL 解析器不可能对它做二次百分号编码，round-trip 无损。
  function toB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(bin);
  }

  function send(kind, payload) {
    var enc = toB64(JSON.stringify(payload));
    var total = Math.max(1, Math.ceil(enc.length / CHUNK));
    for (var n = 0; n < total; n++) {
      location.href =
        SENTINEL + '/' + kind + '/' + n + '/' + total + '#' + enc.slice(n * CHUNK, (n + 1) * CHUNK);
    }
  }

  function fail(message) {
    send('capture', {
      url: location.href,
      title: document.title,
      text: '',
      links: [],
      markdown: '',
      error: String(message),
    });
  }

  // ------------------------------------------------------------ URL 归一化

  var TRACKING = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'spm', 'from', 'source', 'feature', 'ref', 'ref_src',
    'fbclid', 'gclid', 'msclkid', 'ved', 'ei',
  ];

  // 和 Rust 侧 capture_store::normalize_url 必须一致 —— 否则「是否已采集」
  // 的比对两边会给出不同答案。Rust 那份是权威实现，这里是它在页面里的副本。
  function normalizeUrl(raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    if (!s) return '';
    try {
      var u = new URL(s);
      u.hash = '';
      for (var i = 0; i < TRACKING.length; i++) u.searchParams.delete(TRACKING[i]);
      var out = u.toString();
      if (out.endsWith('/') && !out.endsWith('://')) out = out.slice(0, -1);
      return out;
    } catch (e) {
      return s.split('#')[0].trim().replace(/\/+$/, '');
    }
  }

  // ------------------------------------------------------------ 引用收集

  function ReferenceCollector() {
    this.refs = [];
    this.seen = {};
    this.next = 1;
  }
  ReferenceCollector.prototype.add = function (title, rawUrl) {
    var url = normalizeUrl(rawUrl);
    if (!url) return null;
    if (this.seen[url]) {
      var existing = this.refs[this.seen[url] - 1];
      if (existing && !existing.title && title) existing.title = String(title).trim();
      return this.seen[url];
    }
    var num = this.next++;
    this.seen[url] = num;
    this.refs.push({ num: num, title: String(title || '').trim(), url: url });
    return num;
  };

  // --------------------------------------------------------------- 提取

  function token() {
    try {
      return JSON.parse(localStorage.getItem('userToken')).value;
    } catch (e) {
      return '';
    }
  }

  function conversationId() {
    var m = location.pathname.match(/^\/a\/chat\/s\/([^\/?#]+)/);
    return m ? m[1] : null;
  }

  function stripHashes(s) {
    // 深度思考里的 # 会被 markdown 当成标题，破坏文档结构。
    return String(s || '').replace(/^#{1,6}\s/gm, '');
  }

  function buildMarkdown(data, convId) {
    var session = (data && data.chat_session) || {};
    var messages = (data && data.chat_messages) || [];
    var collector = new ReferenceCollector();
    var citeMaps = {};

    // 第一遍：把每条助手消息的引用编号建好，正文里的 [citation:N] 才能
    // 映射到具体的 URL。
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.role !== 'ASSISTANT') continue;
      var frags = msg.fragments || [];
      var byId = {};
      for (var f = 0; f < frags.length; f++) byId[frags[f].id] = frags[f];

      var refMap = {};
      var refs = (byId[findFrag(frags, 'RESPONSE')] || {}).references || msg.references || [];
      for (var r = 0; r < refs.length; r++) {
        var target = byId[refs[r] && refs[r].id];
        var url = target && target.result && target.result.url;
        var t = (target && target.result && target.result.title) || '';
        if (url) refMap[r] = collector.add(t, url);
      }

      var citeMap = {};
      for (var k = 0; k < frags.length; k++) {
        var fr = frags[k];
        if (fr.type !== 'SEARCH' && fr.type !== 'TOOL_SEARCH') continue;
        var results = fr.results || [];
        for (var q = 0; q < results.length; q++) {
          var res = results[q];
          if (res && res.url && res.cite_index !== undefined && res.cite_index !== null && res.cite_index !== '') {
            citeMap[String(res.cite_index)] = collector.add(res.title || '', res.url);
          }
        }
      }
      citeMaps[msg.message_id] = { refMap: refMap, citeMap: citeMap };
    }

    var lines = ['## Conversation', ''];

    for (var m2 = 0; m2 < messages.length; m2++) {
      var message = messages[m2];

      if (message.role === 'USER') {
        var req = fragOf(message, 'REQUEST');
        if (!req || !req.content) continue;
        lines.push('### 🧑‍💻 User', '', stripHashes(req.content), '');
      } else if (message.role === 'ASSISTANT') {
        var resp = fragOf(message, 'RESPONSE');
        if (!resp || !resp.content) continue;

        var thoughts = (message.fragments || [])
          .filter(function (f) { return f.type === 'THINK' && f.content; })
          .map(function (f) { return f.content.trim(); })
          .filter(Boolean);

        var maps = citeMaps[message.message_id] || { refMap: {}, citeMap: {} };
        var text = String(resp.content);
        text = text.replace(/\[reference:(\d+)\]/g, function (_m, n) {
          var num = maps.refMap[parseInt(n, 10)];
          return num ? '[' + num + ']' : '';
        });
        text = text.replace(/\[citation:(\d+)\]/g, function (_m, n) {
          var num = maps.citeMap[String(n)];
          return num ? '[' + num + ']' : '[' + n + ']';
        });
        // [1][1] → [1]
        text = text.replace(/(\[\d+\])(?:\s*\1)+/g, '$1');

        lines.push('### 🤖 Assistant', '');
        if (thoughts.length) {
          lines.push('#### 🤔 Thought Process', '', stripHashes(thoughts.join('\n\n')), '');
          lines.push('#### 💡 Response', '');
        }
        lines.push(stripHashes(text), '');
      }
    }

    if (collector.refs.length) {
      lines.push('## References', '');
      for (var x = 0; x < collector.refs.length; x++) {
        var ref = collector.refs[x];
        var label = ref.title || ref.url;
        lines.push('- [' + ref.num + '] [' + label + '](' + ref.url + ')');
      }
      lines.push('');
    }

    return {
      title: (session.title || '').trim(),
      model: session.model_type || '',
      markdown: lines.join('\n'),
      links: collector.refs.map(function (r) {
        return { href: r.url, text: r.title || r.url };
      }),
    };
  }

  function findFrag(frags, type) {
    for (var i = 0; i < frags.length; i++) {
      if (frags[i].type === type) return frags[i].id;
    }
    return null;
  }

  function fragOf(msg, type) {
    var frags = msg.fragments || [];
    for (var i = 0; i < frags.length; i++) {
      if (frags[i].type === type) return frags[i];
    }
    return null;
  }

  // ------------------------------------------------ DOM 兜底（接口不可用时）

  // 只依赖 innerText 和 a[href]，不依赖 class 名 —— DeepSeek 改版时
  // 接口可能先坏，但页面文字还在。
  function domFallback() {
    var scope = document.querySelector('[class*="ds-markdown"]') || document.body;
    var links = [];
    var seen = {};
    var as = scope.querySelectorAll('a[href]');
    for (var i = 0; i < as.length; i++) {
      var href = as[i].href;
      if (!href || !/^https?:/i.test(href)) continue;
      try {
        if (new URL(href).origin === location.origin) continue;
      } catch (e) { continue; }
      if (href === location.href || seen[href]) continue;
      seen[href] = 1;
      links.push({ href: href, text: (as[i].innerText || '').trim() });
    }
    return {
      title: document.title.replace(/\s*[-–|]\s*DeepSeek\s*$/i, '').trim(),
      model: '',
      markdown: scope.innerText || '',
      links: links,
      via: 'dom',
    };
  }

  // ------------------------------------------------ 对外接口

  window.__solomd = {
    capture: function () {
      var convId = conversationId();
      var tok = token();

      if (!convId || !tok) {
        // 没有会话 id 或没登录 —— 只能走 DOM。
        var fb = domFallback();
        send('capture', {
          url: location.href,
          title: fb.title,
          text: fb.markdown,
          links: fb.links,
          markdown: fb.markdown,
          model: '',
        });
        return;
      }

      fetch('/api/v0/chat/history_messages?chat_session_id=' + convId, {
        headers: {
          authorization: 'Bearer ' + tok,
          'x-client-platform': 'web',
          'x-client-version': '2.2.0',
        },
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (body) {
          var biz = (body && body.data && body.data.biz_data) || {};
          var built = buildMarkdown(biz, convId);
          send('capture', {
            url: 'https://chat.deepseek.com/a/chat/s/' + convId,
            title: built.title,
            text: built.markdown,
            markdown: built.markdown,
            model: built.model,
            links: built.links,
          });
        })
        .catch(function (e) {
          // 接口挂了就退回 DOM —— 拿到的比结构化数据粗糙，但总比什么都没有强。
          var fb = domFallback();
          send('capture', {
            url: location.href,
            title: fb.title,
            text: fb.markdown,
            links: fb.links,
            markdown: fb.markdown,
            model: '',
            error: '接口不可用，已退回页面抓取: ' + String(e),
          });
        });
    },

    // 暴露给 capture_script.test.mjs 做单测。markdown 组装是有分支的
    // 真逻辑（引用映射、思考块、去重），不该只靠肉眼看。
    _test: { buildMarkdown: buildMarkdown, normalizeUrl: normalizeUrl },

    selection: function () {
      send('selection', {
        url: location.href,
        title: document.title,
        text: String(window.getSelection() || ''),
        links: [],
        markdown: '',
      });
    },
  };
})();
