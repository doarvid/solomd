/**
 * #370 — a table wider than the page. The reporter's file: one cell is a
 * single 211-character run with no break opportunity, plus the "screenshot"
 * variant (long latin runs next to short CJK cells), a long inline-code cell
 * and a long URL. A normal small table and a code block ride along to show
 * they are unchanged. Every long run ends in a marker so `pdftotext` can prove
 * the whole run made it onto the page.
 */
export function wideTableFixture(): string {
  const fives = '5'.repeat(205) + 'END370A';
  const sss = 'ssdds' + 's'.repeat(40) + 'd'.repeat(14) + 'g'.repeat(14) + 'f'.repeat(12) + 'd'.repeat(60) + 'END370B';
  const code = '`' + 'very_long_identifier_'.repeat(8) + 'END370C`';
  const url = 'https://example.com/' + 'path/segment/'.repeat(12) + 'END370D';
  return `# test file

---

## head2

### head3

- 无序列表
- 1

\`\`\`c
uint32_t app_get_SN(void)
{
    for(int i=0;i<12;i++)
    {
    }
    return i;
}
\`\`\`

#### 这个是标题4 表格内容

| ee  | 33  | 44 |
| --- | --- | --- |
|     |     | ${fives} |
|     |     |  |

| 项目号 | 内容 | 备注 |
| --- | --- | --- |
| 1 | 版本更新记录1 | ssddsssssssssssssssssssssssssssssssssssssssss |
| 2 | 版本更新记录2 | ${sss} |
| 3 | 代码 | ${code} |
| 4 | 链接 | ${url} |

#### Normal table

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| \`amount\` | 以最小货币单位计 | CNY 用「分」 |
| \`fee\` | 渠道手续费 | 含税，不参与分成 |

LAST-LINE-MARKER
`;
}
