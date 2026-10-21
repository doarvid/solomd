# Final package check: table edits survive backdrop and background close commands.
vault_reset
cat > "$VAULT/table-acceptance.md" <<'EOF'
| HeaderAlpha | HeaderBeta |
| --- | --- |
| CellOne | CellTwo |
EOF
cp "$VAULT/table-acceptance.md" "$RG_ROOT/table-original.md"
profile_reset
app_launch "$VAULT/table-acceptance.md" || fail "app did not start"
wait_title 'table-acceptance.md' 20 || fail "test note did not open"
click_editor
key ctrl+Home
shot caret >/dev/null
key ctrl+alt+t
shot opened >/dev/null
wait_ocr "TABLE EDITOR" 8 || fail "table editor did not open"
ocr_click "HeaderAlpha" 1 eng "430x28+300+447" || fail "table header not found"
key ctrl+a; typ "EditedHeader"; sleep 0.5
click 100 800
expect "backdrop preserves table draft" ocr_has "EditedHeader" "$(shot backdrop)" eng "430x28+300+447"
ocr_click "EditedHeader" 1 eng "430x28+300+447" || fail "draft cell not found"
key ctrl+w
wait_ocr "Unsaved Changes" 8 || fail "close shortcut lost table draft"
key ctrl+w; sleep 0.5
expect "repeat close keeps confirmation" ocr_has "Unsaved Changes" "$(shot repeat-close)"
expect "close has not written or removed source" cmp -s "$VAULT/table-acceptance.md" "$RG_ROOT/table-original.md"
# The rig fixes the window to 1440x870. These centres are from the captured
# 400px confirmation; OCR loses its short button labels against the border.
click 665 522
expect "cancel returns to draft" ocr_has "EditedHeader" "$(shot continued)" eng "430x28+300+447"
ocr_click "EditedHeader" 1 eng "430x28+300+447" || fail "draft cell not found"
key Escape
wait_ocr "Unsaved Changes" 8 || fail "Escape has no confirmation"
click 862 522
key ctrl+s; sleep 1
expect "apply writes to the original note" grep -q 'EditedHeader' "$VAULT/table-acceptance.md"
expect "other table cells are preserved" grep -q 'CellOne.*CellTwo' "$VAULT/table-acceptance.md"
finish "table draft retained, guarded close, clickable confirmation, apply to original note"
