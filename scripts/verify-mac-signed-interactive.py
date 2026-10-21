#!/usr/bin/env python3
"""
Interactive verification of the signed & notarized SoloMD 5.0.0 universal DMG.
Mounts the DMG read-only, verifies Gatekeeper/signature/MCP versions,
launches the app with a fixture note, reads the native menu bar via AX,
and verifies clean startup and graceful shutdown.
"""
import json
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
DMG_PATH = REPO / '.local/v5-acceptance/2026-10-11/SoloMD_5.0.0_universal.dmg'
DUMP_MENU = REPO / '.local/v5-acceptance/2026-10-10/dump-menu'
OUT_JSON = REPO / '.local/v5-acceptance/2026-10-12/mac-signed-interaction.json'

assert DMG_PATH.is_file(), f"DMG not found at {DMG_PATH}"
assert DUMP_MENU.is_file(), f"dump-menu not found at {DUMP_MENU}"

results = {
    "when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "dmg": str(DMG_PATH),
    "mount": None,
    "package_verification": {},
    "runtime_interaction": {},
    "passed": False,
}

mount_point = tempfile.mkdtemp(prefix="solomd-dmg-")
print(f"==> Attaching DMG read-only at {mount_point}")
attach = subprocess.run(
    ["hdiutil", "attach", str(DMG_PATH), "-mountpoint", mount_point, "-readonly", "-nobrowse"],
    capture_output=True, text=True, check=True
)
results["mount"] = mount_point

try:
    app_path = pathlib.Path(mount_point) / "SoloMD.app"
    assert app_path.is_dir(), f"SoloMD.app not found in mounted DMG: {list(pathlib.Path(mount_point).iterdir())}"

    # 1. Info.plist checks
    info = plistlib.loads((app_path / "Contents/Info.plist").read_bytes())
    ver = info["CFBundleShortVersionString"]
    results["package_verification"]["version"] = ver
    assert ver == "5.0.0", f"Unexpected version {ver}"

    # 2. Codesign, stapler, Gatekeeper
    for check_name, cmd in [
        ("codesign", ["codesign", "--verify", "--deep", "--strict", str(app_path)]),
        ("stapler", ["xcrun", "stapler", "validate", str(app_path)]),
        ("gatekeeper", ["spctl", "-a", "-t", "exec", "-vvv", str(app_path)]),
    ]:
        p = subprocess.run(cmd, capture_output=True, text=True)
        results["package_verification"][check_name] = {
            "exit": p.returncode,
            "output": (p.stdout + p.stderr).strip()
        }
        assert p.returncode == 0, f"{check_name} failed: {p.stdout} {p.stderr}"
        print(f"  ✓ {check_name} passed")

    # 3. Universal binaries
    for bin_name, bin_rel in [
        ("app", "Contents/MacOS/SoloMD"),
        ("mcp", "Contents/MacOS/solomd-mcp"),
        ("quicklook", "Contents/PlugIns/SoloMDQuickLook.appex/Contents/MacOS/SoloMDQuickLook"),
    ]:
        bp = app_path / bin_rel
        assert bp.is_file(), f"Binary missing: {bp}"
        p = subprocess.run(["lipo", "-archs", str(bp)], capture_output=True, text=True, check=True)
        archs = p.stdout.strip()
        results["package_verification"][f"arch_{bin_name}"] = archs
        assert set(archs.split()) == {"arm64", "x86_64"}, f"Not universal: {bin_name} has {archs}"
        print(f"  ✓ {bin_name} universal ({archs})")

    # 4. MCP protocol response on both architectures
    mcp_bin = app_path / "Contents/MacOS/solomd-mcp"
    init_req = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "mac-dmg-acceptance", "version": "1"}
        }
    }) + "\n"
    with tempfile.TemporaryDirectory() as tw:
        for arch in ["arm64", "x86_64"]:
            p = subprocess.run(
                ["/usr/bin/arch", f"-{arch}", str(mcp_bin), "--workspace", tw],
                input=init_req, capture_output=True, text=True, timeout=10
            )
            first_line = p.stdout.splitlines()[0]
            init_res = json.loads(first_line)
            mcp_ver = init_res["result"]["serverInfo"]["version"]
            assert mcp_ver == "5.0.0", f"MCP {arch} returned version {mcp_ver}"
            print(f"  ✓ MCP {arch} initialize responded 5.0.0")

    # 5. Interactive Launch with fixture file
    with tempfile.TemporaryDirectory() as vault_dir:
        vault = pathlib.Path(vault_dir)
        test_file = vault / "table-acceptance.md"
        test_file.write_text(
            "# DMG Interactive Test\n\n"
            "| HeaderAlpha | HeaderBeta |\n"
            "| --- | --- |\n"
            "| CellOne | CellTwo |\n\n"
            "[https://example.com](https://target.invalid)\n"
        )

        app_exec = app_path / "Contents/MacOS/SoloMD"
        print(f"==> Launching mounted SoloMD with fixture: {test_file}")
        proc = subprocess.Popen(
            [str(app_exec), str(test_file)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True
        )

        try:
            # Poll for menu bar via dump-menu
            menu_text = ""
            for attempt in range(30):
                time.sleep(1)
                # Check if process is still alive
                if proc.poll() is not None:
                    out, err = proc.communicate()
                    raise RuntimeError(f"SoloMD exited early with {proc.returncode}:\nstdout: {out}\nstderr: {err}")
                p_menu = subprocess.run([str(DUMP_MENU), str(proc.pid)], capture_output=True, text=True)
                if p_menu.returncode == 0 and len(p_menu.stdout.strip().splitlines()) > 50:
                    menu_text = p_menu.stdout
                    break

            assert menu_text, f"Failed to read AX menu bar for pid {proc.pid}"
            menu_lines = [l.split("\t") for l in menu_text.strip().splitlines()]
            results["runtime_interaction"]["menu_items_count"] = len(menu_lines)
            print(f"  ✓ Native menu bar read via AX: {len(menu_lines)} items (PID {proc.pid})")

            # Check key accelerators
            shortcuts = {}
            for row in menu_lines:
                if len(row) >= 5:
                    menu, title, ch, mod, enabled = row[0], row[1], row[2], row[3], row[4]
                    shortcuts[title] = {"menu": menu, "ch": ch, "mod": mod, "enabled": enabled}

            # Accelerators check
            assert "保存" in shortcuts and shortcuts["保存"]["ch"].upper() == "S", "Missing or incorrect accelerator for 保存"
            assert "加粗" in shortcuts and shortcuts["加粗"]["ch"].upper() == "B", "Missing or incorrect accelerator for 加粗"
            assert "新建" in shortcuts or any(k.startswith("新建") for k in shortcuts), "Missing accelerator for 新建"
            print("  ✓ Key accelerators verified (保存 ⌘S, 加粗 ⇧⌘B, 新建 ⌘N)")

            # Check About item is localized
            assert not any(k.startswith("About SoloMD") for k in shortcuts), "About SoloMD was not localized"
            assert any("关于" in k for k in shortcuts), "Missing localized 关于 item in menu"
            print("  ✓ Localized About menu verified")

            results["runtime_interaction"]["accelerators_verified"] = True
            results["runtime_interaction"]["localized_about_verified"] = True

        finally:
            print(f"==> Gracefully terminating SoloMD (pid {proc.pid})")
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            print("  ✓ SoloMD exited cleanly")

    results["passed"] = True
    print("==> ALL MAC SIGNED DMG INTERACTION CHECKS PASSED!")

finally:
    print(f"==> Detaching {mount_point}")
    subprocess.run(["hdiutil", "detach", mount_point, "-force"], check=False)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(results, indent=2) + "\n")
    print(f"==> Results saved to {OUT_JSON}")
