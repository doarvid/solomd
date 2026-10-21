# A GFM URL-valued link label must remain visible in the packaged WebKit app.
vault_reset
cat > "$VAULT/url-acceptance.md" <<'EOF'
# URL acceptance

Website: [https://example.com](https://example.com)

Anchor: [PlainLabel](https://target.invalid)

EOF
cp "$VAULT/url-acceptance.md" "$RG_ROOT/url-original.md"
profile_reset
app_launch "$VAULT/url-acceptance.md" || fail "app did not start"
wait_title 'url-acceptance.md' 20 || fail "test note did not open"
key ctrl+Home; sleep 1
img=$(shot live-url)
expect "URL label visible in live view" ocr_has "example.com" "$img"
expect "ordinary label visible" ocr_has "PlainLabel" "$img"
expect "ordinary link target remains hidden" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng target.invalid"
expect "rendering leaves file unchanged" cmp -s "$VAULT/url-acceptance.md" "$RG_ROOT/url-original.md"
finish "URL-valued label visible; destination hidden; file unchanged"
