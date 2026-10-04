// Tests for capture_script.js — the injected DeepSeek extractor.
//
// It is plain JS embedded into the Rust binary via include_str!, so `node
// --test` can evaluate it directly against a stub window. Worth testing
// because the markdown assembly is real branching logic (citation index
// mapping, thought blocks, dedup) that would otherwise only ever be checked
// by eye on a live page.
//
//   node --test src/capture_script.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'capture_script.js'), 'utf8');

/** A DOM node stub good enough for the fallback path. */
const emptyNode = (text = '') => ({
  innerText: text,
  querySelectorAll: () => [],
  querySelector: () => null,
});

/**
 * Evaluate the script against a minimal page-like sandbox.
 *
 * Returns the whole sandbox plus the script's own `__solomd` handle, because
 * the tests need both: `__solomd._test` for the pure functions, and
 * `sandbox.location.href` to decode what was actually sent.
 */
function loadScript(overrides = {}) {
  const sandbox = {
    location: (() => {
      const hrefs = [];
      let current = 'https://chat.deepseek.com/a/chat/s/abc';
      return {
        get href() { return current; },
        set href(v) { current = v; hrefs.push(v); },
        pathname: '/a/chat/s/abc',
        origin: 'https://chat.deepseek.com',
        __hrefs: hrefs,
      };
    })(),
    document: {
      title: 'DeepSeek',
      querySelector: () => emptyNode('页面文字'),
      body: emptyNode('页面文字'),
    },
    localStorage: { getItem: () => null },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    URL,
    // send() paces its chunks with setTimeout, so the sandbox needs a clock.
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error('no network in tests');
    },
    ...overrides,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, api: sandbox.__solomd };
}

const assistant = (messageId, content, frags = []) => ({
  message_id: messageId,
  role: 'ASSISTANT',
  fragments: [{ id: messageId + '-r', type: 'RESPONSE', content }, ...frags],
});

const user = (content) => ({
  message_id: 'u1',
  role: 'USER',
  fragments: [{ id: 'u1-r', type: 'REQUEST', content }],
});

test('builds a two-turn conversation with roles', () => {
  const { api } = loadScript();
  const { markdown, title, model } = api._test.buildMarkdown(
    {
      chat_session: { title: '测试对话', model_type: 'chat' },
      chat_messages: [user('你好'), assistant('m1', '你好，有什么可以帮你？')],
    },
    'abc',
  );
  assert.equal(title, '测试对话');
  assert.equal(model, 'chat');
  assert.match(markdown, /### 🧑‍💻 User/);
  assert.match(markdown, /### 🤖 Assistant/);
  assert.match(markdown, /你好，有什么可以帮你？/);
});

test('renders the THINK fragment, which DOM scraping cannot reach', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('q'),
        assistant('m1', '答案', [{ id: 't1', type: 'THINK', content: '先想一下……' }]),
      ],
    },
    'abc',
  );
  assert.match(markdown, /#### 🤔 Thought Process/);
  assert.match(markdown, /先想一下……/);
  assert.match(markdown, /#### 💡 Response/);
});

test('maps [citation:N] onto numbered references', () => {
  const { api } = loadScript();
  const { markdown, links } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('q'),
        assistant('m1', '见 [citation:7]。', [
          { id: 's1', type: 'SEARCH', results: [{ cite_index: 7, url: 'https://example.com/a', title: 'A 站点' }] },
        ]),
      ],
    },
    'abc',
  );
  assert.match(markdown, /见 \[1\]/, 'citation 没有被替换成编号');
  assert.doesNotMatch(markdown, /\[citation:7\]/, '原始 citation 标记泄漏了');
  assert.match(markdown, /## References/);
  assert.match(markdown, /\[1\] \[A 站点\]\(https:\/\/example\.com\/a\)/);
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/a');
});

test('an unknown citation index falls through unchanged rather than vanishing', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '见 [citation:3]。')] },
    'abc',
  );
  assert.match(markdown, /见 \[3\]/);
});

test('collapses repeated citation markers', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('q'),
        assistant('m1', '看这里 [citation:1][citation:1] 和这里 [citation:1]。', [
          { id: 's1', type: 'SEARCH', results: [{ cite_index: 1, url: 'https://example.com/a', title: 'A' }] },
        ]),
      ],
    },
    'abc',
  );
  assert.doesNotMatch(markdown, /\[1\]\[1\]/, '连续重复的引用标记没有合并');
});

test('the same URL cited twice gets one number', () => {
  const { api } = loadScript();
  const { links } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('q'),
        assistant('m1', 'a', [{ id: 's1', type: 'SEARCH', results: [{ cite_index: 1, url: 'https://example.com/x', title: 'X' }] }]),
        assistant('m2', 'b', [{ id: 's2', type: 'SEARCH', results: [{ cite_index: 1, url: 'https://example.com/x', title: 'X' }] }]),
      ],
    },
    'abc',
  );
  assert.equal(links.length, 1, '同一 URL 被登记了两次');
});

test('tracking params do not split one page into two references', () => {
  const { api } = loadScript();
  const { links } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('q'),
        assistant('m1', 'a', [
          {
            id: 's1',
            type: 'SEARCH',
            results: [
              { cite_index: 1, url: 'https://example.com/p?utm_source=x', title: 'P' },
              { cite_index: 2, url: 'https://example.com/p', title: 'P' },
            ],
          },
        ]),
      ],
    },
    'abc',
  );
  assert.equal(links.length, 1, 'URL 没有归一化，同一页面被当成两条');
  assert.equal(links[0].href, 'https://example.com/p');
});

test('# in the model output cannot break the document outline', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '# 一级标题\n正文')] },
    'abc',
  );
  assert.doesNotMatch(markdown, /^# 一级标题$/m, '模型输出的 # 把标题层级带歪了');
});

test('empty turns are skipped rather than emitting bare headings', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), { message_id: 'm1', role: 'ASSISTANT', fragments: [] }] },
    'abc',
  );
  assert.doesNotMatch(markdown, /### 🤖 Assistant/, '空轮次也输出了标题');
});

test('a conversation with no messages still produces valid markdown', () => {
  const { api } = loadScript();
  const { markdown, links } = api._test.buildMarkdown({ chat_session: {}, chat_messages: [] }, 'abc');
  assert.match(markdown, /## Conversation/);
  assert.equal(links.length, 0);
  assert.doesNotMatch(markdown, /## References/, '没有引用时不该出现 References 段');
});

test('normalizeUrl matches the Rust implementation', () => {
  const { api } = loadScript();
  const n = api._test.normalizeUrl;
  assert.equal(n('https://example.com/a/?utm_source=x#frag'), 'https://example.com/a');
  assert.equal(n('https://example.com/p?id=42'), 'https://example.com/p?id=42');
  assert.equal(n(''), '');
  assert.equal(n('not a url#frag'), 'not a url');
});

/** Decode the payload a capture() call wrote into location.href. */
function sentPayload(sandbox) {
  const href = String(sandbox.location.href);
  assert.ok(href.startsWith('https://solomd.invalid/capture/'), `没有走哨兵 URL: ${href}`);
  const b64 = href.slice(href.indexOf('#') + 1);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

test('capture() with no token falls back to the DOM and still sends', async () => {
  const { sandbox, api } = loadScript({
    localStorage: { getItem: () => null },
    document: {
      // 站点的标题后缀要被剥掉。
      title: '标题 - DeepSeek',
      querySelector: () => ({ innerText: '页面文字', querySelectorAll: () => [] }),
      body: {},
    },
  });
  await api.capture();
  const payload = sentPayload(sandbox);
  assert.equal(payload.markdown, '页面文字');
  assert.equal(payload.title, '标题', '标题后缀没有被剥掉');
});

test('the sentinel URL carries a complete, decodable payload', async () => {
  const { sandbox, api } = loadScript();
  await api.capture(); // no token -> DOM path, but the send path is what matters
  const payload = sentPayload(sandbox);
  // 服务端要求这几个字段始终存在，哪怕为空。
  for (const key of ['url', 'title', 'text', 'links', 'markdown']) {
    assert.ok(key in payload, `payload 缺少字段 ${key}`);
  }
  assert.ok(Array.isArray(payload.links));
});

// ---------------------------------------------------------------- 分片

test('a large payload is split into ordered chunks, none of them oversized', async () => {
  // 长对话曾经必超时：片太大，URL 被 webview 截断，截断后的 base64 解不
  // 出来，Rust 侧只能静默丢弃，分片永远凑不齐。这条盯着片长和序号。
  const big = '这是一段很长的正文。'.repeat(8000); // ~80k chars -> >1 chunk
  const { sandbox, api } = loadScript({
    document: {
      title: '长对话',
      querySelector: () => ({ innerText: big, querySelectorAll: () => [] }),
      body: { innerText: big, querySelectorAll: () => [] },
    },
  });

  await api.capture();

  const sent = sandbox.location.__hrefs;
  assert.ok(sent.length > 1, `长内容应该分片，实际只发了 ${sent.length} 片`);

  const indices = sent.map((h) => Number(h.match(/\/capture\/[a-z]+\/(\d+)\/\d+#/)[1]));
  const totals = new Set(sent.map((h) => Number(h.match(/\/capture\/[a-z]+\/\d+\/(\d+)#/)[1])));
  assert.equal(totals.size, 1, '各片声称的 total 不一致');
  assert.equal([...totals][0], sent.length, 'total 与实际片数不符');
  assert.deepEqual(
    indices,
    Array.from({ length: sent.length }, (_, i) => i),
    '分片序号不是从 0 起的连续序列 —— 有片丢了或乱序',
  );

  // 每片的 URL 都要在安全长度内。
  for (const h of sent) {
    assert.ok(h.length < 60000, `单片 URL 过长（${h.length}），会被截断`);
  }
});

test('chunks reassemble into the original payload byte for byte', async () => {
  const text = '中文与 emoji 😀 和 %2F + / = 一起出现。'.repeat(3000);
  const { sandbox, api } = loadScript({
    document: {
      title: 't',
      querySelector: () => ({ innerText: text, querySelectorAll: () => [] }),
      body: { innerText: text, querySelectorAll: () => [] },
    },
  });

  await api.capture();

  const sent = sandbox.location.__hrefs;
  const parts = sent.map((h) => h.slice(h.indexOf('#') + 1));
  const joined = parts.join('');
  const decoded = Buffer.from(joined, 'base64').toString('utf8');
  const payload = JSON.parse(decoded);

  assert.equal(payload.markdown, text, '分片重组后与原文不一致');
});
