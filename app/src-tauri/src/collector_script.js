// SoloMD collector 注入脚本 —— 只在隐藏的 `browser-collector` webview 里运行。
//
// 和 capture_script.js 一样：**不调用任何 Tauri API**，数据经哨兵 URL
// 回传。分片发送直接复用 `window.__solomd._send`（两个初始化脚本按声明
// 顺序注入，capture 在前）。
//
// 这里只做页面驱动和原始候选收集；URL 白名单、去重、条数上限在 Rust 侧
// 的 `filter_toutiao_items` 里 —— 那边能写单测，页面里不能。

(function () {
  if (window.__solomdCollector) return;

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function send(kind, payload) {
    if (window.__solomd && window.__solomd._send) {
      return window.__solomd._send(kind, payload);
    }
    return Promise.resolve();
  }

  // 登录态是启发式的：头条没有可读的登录标志，HttpOnly cookie 也拿不到。
  // 三个信号同时成立才算已登录 —— 宁可在登录后多问一次，也不要把未登录
  // 页面当成"没有新收藏"。
  function probe() {
    var onLoginPage = /sso\.|passport|login/i.test(location.host + location.pathname);
    var loginLink = document.querySelector(
      'a[href*="sso."], a[href*="login"], button[class*="login"], [class*="login-btn"]'
    );
    var avatar = document.querySelector(
      '[class*="avatar"], [class*="user-info"], img[class*="head"]'
    );
    var loggedIn = !onLoginPage && !loginLink && !!avatar;
    var reason = onLoginPage
      ? "login-page"
      : loginLink
        ? "login-link-visible"
        : !avatar
          ? "no-avatar"
          : "";
    send("probe", { loggedIn: loggedIn, reason: reason });
  }

  // 只收原始候选：不判断 URL 形态，也不去重 —— Rust 侧统一做。
  function candidates(seen) {
    var out = [];
    var anchors = document.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.closest("header, nav, footer")) continue;
      var href = a.href;
      if (!href || !/^https?:/i.test(href)) continue;
      if (seen[href]) continue;
      var title = (a.innerText || a.getAttribute("title") || "").trim();
      out.push({ url: href, title: title });
    }
    return out;
  }

  var MAX_RAW = 600;

  async function harvest() {
    var all = [];
    var seen = {};
    var stable = 0;

    for (var round = 0; round < 40; round++) {
      var fresh = candidates(seen);
      for (var i = 0; i < fresh.length; i++) {
        seen[fresh[i].url] = 1;
        all.push(fresh[i]);
      }
      if (all.length >= MAX_RAW) break;

      var before = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      window.scrollTo(0, before);
      if (document.scrollingElement) document.scrollingElement.scrollTop = before;
      await sleep(800);

      var after = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      if (after === before) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
    }

    send("collect", { items: all.slice(0, MAX_RAW), hasMore: all.length >= MAX_RAW });
  }

  // page load Finished 之后由 Rust 调；50 ms 让 hydration 的收尾工作再跑一步。
  function render() {
    setTimeout(function () {
      send("render", { html: document.documentElement.outerHTML });
    }, 50);
  }

  window.__solomdCollector = {
    probe: probe,
    harvest: harvest,
    render: render,
  };
})();
