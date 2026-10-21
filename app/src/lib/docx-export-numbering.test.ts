import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';

const { markdownToDocxBlob } = await import('./docx-export.ts');

async function readDocxXml(src: string): Promise<{ docXml: string; numXml: string }> {
  const blob = await markdownToDocxBlob(src, '测试文档');
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return {
    docXml: strFromU8(zip['word/document.xml']),
    numXml: strFromU8(zip['word/numbering.xml']),
  };
}

test('separate ordered lists across sections get distinct numId instances with startOverride=1 (#427)', async () => {
  const md = [
    '## 第一节',
    '',
    '1. 第一节第一项',
    '2. 第一节第二项',
    '3. 第一节第三项',
    '',
    '## 第二节',
    '',
    '1. 第二节第一项',
    '2. 第二节第二项',
  ].join('\n');

  const { docXml, numXml } = await readDocxXml(md);

  const numIdMatches = [...docXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
  assert.equal(numIdMatches.length, 5);

  const section1NumId = numIdMatches[0];
  const section2NumId = numIdMatches[3];
  assert.deepEqual(numIdMatches.slice(0, 3), [section1NumId, section1NumId, section1NumId]);
  assert.deepEqual(numIdMatches.slice(3, 5), [section2NumId, section2NumId]);
  assert.notEqual(
    section2NumId,
    section1NumId,
    'second ordered list must not reuse first ordered list numId',
  );
  assert.ok(numXml.includes('<w:startOverride w:val="1"/>'));
});

test('continuation paragraphs inside a single list item do not consume extra list numbers (#427)', async () => {
  const md = [
    '1. 第一项第一段',
    '',
    '   第一项第二段（缩进延续）',
    '',
    '2. 第二项',
  ].join('\n');

  const { docXml } = await readDocxXml(md);
  const numIdMatches = [...docXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)];
  assert.equal(numIdMatches.length, 2);
});
