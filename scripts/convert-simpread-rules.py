"""Convert SimpRead's website_list.json into SoloMD's extract-rule format.

Only the fields we actually use survive: content container, title selector and
the removal list. SimpRead's `[[{ ... }]]` dynamic expressions are JS and
cannot be evaluated in Rust, so any site whose `include` uses one is dropped --
those URLs fall through to readability/AI extraction instead of failing.
"""
import json, re, sys, collections

SRC = "/Users/duxiaoliang/workspace/Obsidian Vault/05.产品研究/02.笔记助手/website_list.json"
OUT = "/Users/duxiaoliang/workspace/solomd/app/src-tauri/resources/seed-extract-rules.json"

TAG = re.compile(
    r"^<\s*([a-zA-Z][a-zA-Z0-9]*)\s*"
    r"(?:class=['\"]([^'\"]*)['\"])?\s*"
    r"(?:id=['\"]([^'\"]*)['\"])?\s*/?>\s*$"
)

def to_css(snippet):
    """`<div class='a b'>` -> `div.a.b`. Returns None if not a plain tag."""
    s = (snippet or "").strip()
    if not s or s.startswith("[["):
        return None
    m = TAG.match(s)
    if not m:
        return None
    tag, cls, id_ = m.group(1), (m.group(2) or "").strip(), (m.group(3) or "").strip()
    out = tag.lower()
    if id_:
        out += "#" + id_
    for c in cls.split():
        out += "." + c
    return out

sites = json.load(open(SRC, encoding="utf-8"))["sites"]
rules, skipped = {}, collections.Counter()

for e in sites:
    domain = (e.get("name") or "").strip().lower()
    if not domain:
        skipped["no domain"] += 1
        continue

    content = to_css(e.get("include"))
    if not content:
        # JS-expression include: we cannot extract this site from Rust.
        skipped["include needs JS"] += 1
        continue

    title = to_css(e.get("title"))

    remove = []
    for x in (e.get("exclude") or []):
        css = to_css(x)
        if css:
            remove.append(css)

    # First rule for a domain wins; the source list has dupes (e.g. mobile and
    # desktop variants share a name) and later entries are usually narrower.
    if domain in rules:
        skipped["duplicate domain"] += 1
        continue

    r = {"content": content, "source": "seed"}
    if title:
        r["title"] = title
    if remove:
        r["remove"] = remove
    rules[domain] = r

doc = {
    "version": 1,
    "note": (
        "Seed extraction rules converted from SimpRead's website_list.json. "
        "'content'/'title'/'remove' are CSS selectors. Sites whose SimpRead "
        "rule needed a JS expression were dropped and fall through to "
        "readability extraction instead."
    ),
    "rules": dict(sorted(rules.items())),
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
    f.write("\n")

print(f"wrote {len(rules)} rules -> {OUT}")
print("skipped:", dict(skipped))
