// Dev-only IME tracer, served by the vite dev server only (not in public/, so
// never bundled); main.ts loads it when ?imetrace is in a DEV build's URL.
// Logs keyboard / composition / input events on textareas and the editor's
// own composing flag, and posts them to a receiver on the Mac.
(function () {
  const RECV = 'http://192.168.64.1:8765/imelog';
  const buf = [];
  const t0 = performance.now();
  const val = (el) => (el && 'value' in el ? el.value : (el && el.textContent) || '');
  function log(type, e) {
    const el = e.target;
    buf.push({
      t: Math.round(performance.now() - t0), type,
      key: e.key, code: e.code, kc: e.keyCode, comp: e.isComposing,
      data: e.data, it: e.inputType, dp: e.defaultPrevented,
      tag: el && el.tagName, cls: el && String(el.className).slice(0, 40),
      tail: JSON.stringify(val(el).slice(-12)),
      ae: document.activeElement && document.activeElement.tagName,
    });
  }
  for (const ty of ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    document.addEventListener(ty, (e) => log(ty, e), true);
    // also after app handlers ran, to see defaultPrevented
    if (ty === 'keydown' || ty === 'beforeinput') document.addEventListener(ty, (e) => log(ty + ':after', e), false);
  }
  setInterval(() => {
    if (!buf.length) return;
    const batch = buf.splice(0, buf.length);
    fetch(RECV, { method: 'POST', mode: 'no-cors', body: JSON.stringify(batch) }).catch(() => {});
  }, 500);
  // fresh empty tab in live edit, once the app has mounted
  const ready = setInterval(() => {
    const app = document.querySelector('#app');
    const pin = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$pinia;
    if (!pin || !pin._s.get('tabs')) return;
    clearInterval(ready);
    const st = pin._s.get('settings'); const tabs = pin._s.get('tabs');
    st.setViewMode('liveEdit'); tabs.newTab();
    buf.push({ t: 0, type: 'tracer-ready', ua: navigator.userAgent.slice(-60), plat: navigator.platform });
  }, 300);
})();
