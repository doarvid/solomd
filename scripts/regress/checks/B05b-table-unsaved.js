// id: B5
// title: closing a modified table offers apply, discard or continue; accidental backdrop clicks preserve edits
const R = checks();
await fresh('table-unsaved.md', '| Name | Qty |\n| --- | ---: |\n| Apple | 3 |\n');
async function showTable() {
  V().dispatch({ selection: { anchor: doc().indexOf('Apple') + 1 } });
  act('editor.tableEditor');
  return await waitFor(() => $('.tbl__cell[data-cell="0:0"]'));
}
async function edit() {
  const cell = await showTable();
  cell.textContent = 'Banana';
  cell.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(100);
}
await edit();
$('.tbl__backdrop').click();
await sleep(150);
R.t(vis('.tbl'), 'backdrop leaves table open');
R.eq($('.tbl__cell[data-cell="0:0"]')?.textContent, 'Banana', 'working copy retained');
$('.tbl__x')?.click();
await sleep(150);
R.t(vis('[data-table-close="cancel"]'), 'close asks before discarding edits');
const cancel = $('[data-table-close="cancel"]');
if (cancel) {
  const rect = cancel.getBoundingClientRect();
  R.t(cancel.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), 'confirmation is above the table and receives real clicks');
  R.t($('.tbl').inert, 'table cannot be edited behind the confirmation');
}
$('[data-table-close="cancel"]')?.click();
await sleep(150);
R.eq($('.tbl__cell[data-cell="0:0"]')?.textContent, 'Banana', 'continue retains working copy');
key($('.tbl__cell'), 'Escape');
await sleep(150);
$('[data-table-close="discard"]')?.click();
await sleep(150);
R.t(!vis('.tbl'), 'discard closes table');
R.t(doc().includes('Apple') && !doc().includes('Banana'), 'discard keeps original document');
await edit();
$('.tbl__x')?.click();
await sleep(150);
$('[data-table-close="apply"]')?.click();
await sleep(150);
R.t(!vis('.tbl') && doc().includes('Banana'), 'apply on close writes edits');
V().dispatch({ selection: { anchor: doc().indexOf('Banana') + 1 } });
act('editor.tableEditor');
await waitFor(() => $('.tbl__x'));
$('.tbl__x')?.click();
await sleep(100);
R.t(!vis('.tbl') && !vis('[data-table-close="cancel"]'), 'unmodified table closes without a prompt');
return R.done();
