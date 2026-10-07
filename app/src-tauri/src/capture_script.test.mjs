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
  // 用锚点断言层级：不锚的话 `/## 🤖 Assistant/` 会连 `### 🤖 Assistant`
  // 一起匹配上，层级改了也照样绿。
  //
  // 提问就是文档的根：`# Conversation` 那种占着根节点却没有信息的写法去掉了。
  assert.match(markdown, /^# 你好$/m);
  assert.doesNotMatch(markdown, /Conversation/, '根节点又回到那个没信息量的词了');
  // `## 🤖 Assistant` 这一层去掉了：提问是 h1，助手那侧直接是「思考/回答」。
  assert.doesNotMatch(markdown, /Assistant/, 'Assistant 那一层又回来了');
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
  // 「深度思考」是助手那侧唯一保留的标签；回答不再有 `💡 Response`，
  // 正文标题直接跟在后面，从 h2 起。
  assert.match(markdown, /^## 🤔 Thought Process$/m);
  assert.match(markdown, /先想一下……/);
  assert.doesNotMatch(markdown, /💡 Response/, 'Response 标签没移除干净');
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

test('the answer keeps its own h1/h2/h3, demoted so they nest under the turn', () => {
  // 以前这些 `#` 是被**删掉**的，于是笔记只剩 Conversation / User /
  // Assistant 三层空壳，大纲视图里看不到答案的任何结构。
  //
  // 现在降级保留，而且只降一级：一级→h2、二级→h3、三级→h4。降太多
  // （h4/h5/h6）渲染出来小得没法看 —— 而 `💡 Response` 那个标签本身不
  // 含信息，不该占着一级把答案顶下去，所以它改成正文。
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [user('q'), assistant('m1', '# 一、总览\n\n## 1.1 细节\n\n### 1.1.1 更细\n\n正文')],
    },
    'abc',
  );
  assert.match(markdown, /^## 一、总览$/m, '答案的一级标题没有留下来');
  assert.match(markdown, /^### 1\.1 细节$/m, '答案的二级标题没有留下来');
  assert.match(markdown, /^#### 1\.1\.1 更细$/m, '答案的三级标题没有留下来');
  // 关键：绝不能跑到顶层 —— 那正是当初删掉它们的原因。h1 只留给用户提问。
  assert.doesNotMatch(markdown, /^# (一、总览|1\.1 细节)/m, '答案的标题跑到文档根层级了');
});

test('content headings are aligned to h2 whichever level the answer used', () => {
  // 固定平移会让用 `##` 开节的回答整体掉到 h3/h4/h5 —— 用户看到的就是
  // "正文怎么还是从 h3 开始"。改成按内容自己最浅的一级对齐到 h2。
  const { api } = loadScript();
  const deep = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '##### 五级\n\n###### 六级')] },
    'abc',
  ).markdown;
  // 整段只有很深的标题 → 整体上提到 h2/h3。
  assert.match(deep, /^## 五级$/m);
  assert.match(deep, /^### 六级$/m);

  const shallow = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '# 一级\n\n## 二级')] },
    'abc',
  ).markdown;
  // 用 `#` 开节的同样落在 h2/h3。
  assert.match(shallow, /^## 一级$/m);
  assert.match(shallow, /^### 二级$/m);
});

test('the h6 ceiling still holds when the answer nests deep', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '# 一级\n\n###### 六级')] },
    'abc',
  );
  // 一级对齐到 h2（+1），六级再 +1 就超出 6 —— 封顶在 h6，不能逃出文档。
  assert.match(markdown, /^## 一级$/m);
  assert.match(markdown, /^###### 六级$/m);
});

test('a # inside a fenced code block is left alone', () => {
  // 代码块里的 `# 注释` 不是标题：降级会把它改成 `#### 注释`，旧版则是
  // 直接把 `#` 删掉 —— 两种都把代码改坏了。
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '```python\n# 这是注释\nx = 1\n```')] },
    'abc',
  );
  assert.match(markdown, /^# 这是注释$/m, '代码块里的注释被当成标题处理了');
});

test('# in the model output cannot break the document outline', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '# 一级标题\n正文')] },
    'abc',
  );
  // 不再要求删掉，而是要求它别占 h1 —— 文档的 h1 只留给用户的提问。
  assert.doesNotMatch(markdown, /^# 一级标题$/m, '模型输出的 # 顶到了文档根层级');
  assert.match(markdown, /^## 一级标题$/m);
});

test('a separator sits between the reasoning and the answer', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('q'),
        assistant('m1', '## 结论\n\n答案正文', [{ id: 't1', type: 'THINK', content: '先想一下' }]),
      ],
    },
    'abc',
  );
  // 深度思考是过程、正文是结论，中间得有界线，否则阅读视图里两段连在一起。
  const rules = markdown.split('\n').filter((l) => l.trim() === '---');
  assert.equal(rules.length, 1, `分隔线数量不对:\n${markdown}`);
  assert.ok(
    markdown.indexOf('先想一下') < markdown.indexOf('---') &&
      markdown.indexOf('---') < markdown.indexOf('## 结论'),
    `分隔线不在思考和正文之间:\n${markdown}`,
  );
  // `---` 紧跟一段文字会被当成 setext 标题（把上一行变成 h2）——前面必须有空行。
  assert.match(markdown, /\n\n---\n/, '分隔线前面缺空行，会被解析成 setext 标题');
});

test('no separator when there is no reasoning', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), assistant('m1', '## 结论\n\n答案')] },
    'abc',
  );
  assert.doesNotMatch(markdown, /^---$/m, '没有思考过程却出现了分隔线');
});

test('empty turns are skipped rather than emitting bare headings', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('q'), { message_id: 'm1', role: 'ASSISTANT', fragments: [] }] },
    'abc',
  );
  // 助手那侧一个标题都不该输出（h1 是用户的提问，本来就该在）。
  assert.doesNotMatch(markdown, /^## /m, '空轮次也输出了标题');
});

test('a conversation with no messages produces an empty body', () => {
  // 没有提问就没有根标题可写（原来这里固定输出 `# Conversation`）。
  // 空正文不会落盘：前端 saveConversation 见 body 为空就拒绝写。
  const { api } = loadScript();
  const { markdown, links } = api._test.buildMarkdown({ chat_session: {}, chat_messages: [] }, 'abc');
  assert.equal(markdown.trim(), '');
  assert.equal(links.length, 0);
});

test('a multi-paragraph question keeps its first line as the heading', () => {
  // h1 只能是一行，剩下的仍作正文 —— 不能因为截标题把问题内容吞了。
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    { chat_session: {}, chat_messages: [user('先看这个\n\n再看那段'), assistant('m1', '答案')] },
    'abc',
  );
  assert.match(markdown, /^# 先看这个$/m);
  assert.match(markdown, /再看那段/, '提问的第二段被吞掉了');
});

test('each turn opens a new h1', () => {
  const { api } = loadScript();
  const { markdown } = api._test.buildMarkdown(
    {
      chat_session: {},
      chat_messages: [
        user('第一问'),
        assistant('m1', '第一个答案'),
        { message_id: 'u2', role: 'USER', fragments: [{ id: 'u2-r', type: 'REQUEST', content: '第二问' }] },
        assistant('m2', '第二个答案'),
      ],
    },
    'abc',
  );
  assert.match(markdown, /^# 第一问$/m);
  assert.match(markdown, /^# 第二问$/m);
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
