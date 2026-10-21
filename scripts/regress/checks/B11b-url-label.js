// id: B11
// title: URL-valued Markdown link labels remain visible away from the caret (#395)
const R = checks();
const text = '- 官网：[https://solomd.app/zh/](https://solomd.app/zh/)\n\n[Example](https://example.com/target)\n\n<https://example.org/>\n\nCaret here\n';
await fresh('url-label.md', text);
settings.setViewMode('liveEdit');
setDoc(text, text.indexOf('Caret'));
await sleep(300);
const lines = $$('.cm-line').filter(vis);
R.t(lines.some((line) => line.textContent.includes('https://solomd.app/zh/')), 'URL label rendered when caret is elsewhere: ' + lines.map((l) => l.textContent).join('|'));
const rendered = lines.map((line) => line.textContent).join('\n');
R.eq((rendered.match(/https:\/\/solomd\.app\/zh\//g) || []).length, 1, 'destination hidden, label shown once');
R.t(rendered.includes('Example') && !rendered.includes('https://example.com/target'), 'ordinary link shows label only');
R.t(rendered.includes('https://example.org/'), 'autolink remains visible');
V().dispatch({ selection: { anchor: text.indexOf('solomd') } });
await sleep(150);
R.t($$('.cm-line').some((line) => line.textContent.includes('[https://solomd.app/zh/](https://solomd.app/zh/)')), 'caret reveals editable link source');
R.eq(doc(), text, 'rendering never changes the document');
return R.done();
