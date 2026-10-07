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

  // 每片的大小。
  //
  // 曾经是 200000，长对话必超时 —— 那个尺寸的 URL 交给 webview 会被截断，
  // 截断后的 base64 解不出来，Rust 侧只能静默丢弃，于是分片永远凑不齐。
  // 32000 留了很大的安全余量，代价只是片数变多（每片之间要让出一帧）。
  var CHUNK = 32000;

  // 分片之间让出的时间。
  //
  // 同一 tick 内连续给 location.href 赋值会被浏览器折叠成一次导航 ——
  // 那样除了最后一片，其余全部丢失。必须逐片让出。
  var CHUNK_GAP_MS = 25;

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

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // 逐片发送，**片与片之间必须让出事件循环**。
  function send(kind, payload) {
    var enc;
    try {
      enc = toB64(JSON.stringify(payload));
    } catch (e) {
      return Promise.resolve();
    }
    var total = Math.max(1, Math.ceil(enc.length / CHUNK));

    var chain = Promise.resolve();
    for (var n = 0; n < total; n++) {
      (function (idx) {
        chain = chain.then(function () {
          location.href =
            SENTINEL + '/' + kind + '/' + idx + '/' + total + '#' +
            enc.slice(idx * CHUNK, (idx + 1) * CHUNK);
          return sleep(CHUNK_GAP_MS);
        });
      })(n);
    }
    return chain;
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

  /**
   * 把正文里的标题**对齐到从 `base` 级起**。
   *
   * 这里以前是删掉 `#`（stripHashes），后来改成固定 +1 平移 —— 都不对。
   * 固定平移的问题：DeepSeek 有的回答用 `#` 开节、有的用 `##`，平移之后
   * 前者落在 h2、后者落在 h3，同一份笔记里字号不一致，看着就是"正文怎么
   * 还是从 h3 开始的"。
   *
   * 所以先看正文自己最浅的一级，整体对齐到 `base`，深的依次往下排 ——
   * 无论原文从哪一级起，正文都从 `base` 开始。（原文只有很深的标题时就
   * 是整体上提，那是想要的：它毕竟是这一节里唯一的层次。）
   *
   * 代码块里的 `#` 不是标题，跳过 —— 顺手修掉旧版的另一个毛病：```python
   * 里的 `# 注释` 会被删成一个光秃秃的行。
   */
  function rebaseHeadings(s, base) {
    var lines = String(s || '').split('\n');
    var shallowest = 7;
    var inFence = false;
    var i;
    var m;
    for (i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) inFence = !inFence;
      if (inFence) continue;
      m = /^(#{1,6})(\s)/.exec(lines[i]);
      if (m && m[1].length < shallowest) shallowest = m[1].length;
    }
    // 整段没有标题：原样返回，别做无谓的复制。
    if (shallowest > 6) return lines.join('\n');

    var by = base - shallowest;
    if (by === 0) return lines.join('\n');

    inFence = false;
    for (i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) inFence = !inFence;
      if (inFence) continue;
      m = /^(#{1,6})(\s)/.exec(lines[i]);
      if (!m) continue;
      var level = Math.max(1, Math.min(m[1].length + by, 6));
      lines[i] = new Array(level + 1).join('#') + lines[i].slice(m[1].length);
    }
    return lines.join('\n');
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

    // 层级：每轮提问是 h1（文档的根就是它），「深度思考」是唯一的 h2 标签，
    // 正文标题从 h2 起 —— 见 rebaseHeadings。
    var lines = [];

    for (var m2 = 0; m2 < messages.length; m2++) {
      var message = messages[m2];

      if (message.role === 'USER') {
        var req = fragOf(message, 'REQUEST');
        if (!req || !req.content) continue;
        lines = lines.concat(questionAsHeading(req.content));
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

        // 助手这一侧只留「深度思考」一个标签：`## 🤖 Assistant` 和
        // `## 💡 Response` 都不含信息，白占一层把正文越推越深、字号越小。
        if (thoughts.length) {
          lines.push('## 🤔 Thought Process', '', rebaseHeadings(thoughts.join('\n\n'), BODY_HEADING_BASE), '');
          // 思考和正文之间加一道分隔线：深度思考是过程、正文是结论，中间
          // 没有界线时阅读视图里两段是连在一起的。
          //
          // 上面那个空串不能省 —— `先说结论。` 紧跟一行 `---` 会被 markdown
          // 当成 setext 标题（把上一行变成 h2），正好是这文件最不想要的效果。
          lines.push('---', '');
        }
        lines.push(rebaseHeadings(text, BODY_HEADING_BASE), '');
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

  /**
   * 用户提问 → 这一轮的标题。
   *
   * 文档的根就是提问本身。原来这里是 `## 🧑‍💻 User` 加一段正文、顶上还压着
   * 一个 `# Conversation`，代价是根节点永远是那个什么信息都没有的词，大纲里
   * 看不出这份对话在谈什么。提问既有信息量，又天然是轮次的分隔。
   *
   * h1 只能是一行：提问是多段时取第一段当标题，剩下的仍作正文。
   */
  function questionAsHeading(s) {
    var text = String(s || '').trim();
    var nl = text.indexOf('\n');
    var head = (nl < 0 ? text : text.slice(0, nl)).trim();
    var rest = nl < 0 ? '' : rebaseHeadings(text.slice(nl + 1), BODY_HEADING_BASE).trim();
    var out = ['# ' + head, ''];
    if (rest) out.push(rest, '');
    return out;
  }

  /** 正文标题统一从这一级起（h1 只留给用户的提问）。 */
  var BODY_HEADING_BASE = 2;

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
        return send('capture', {
          url: location.href,
          title: fb.title,
          text: fb.markdown,
          links: fb.links,
          markdown: fb.markdown,
          model: '',
        });
        return;
      }

      return fetch('/api/v0/chat/history_messages?chat_session_id=' + convId, {
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
      return send('selection', {
        url: location.href,
        title: document.title,
        text: String(window.getSelection() || ''),
        links: [],
        markdown: '',
      });
    },
  };
})();
