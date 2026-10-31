"""
Take an already-uploaded build to "Waiting for Review".

`submit-ios.sh` / `submit-mas.sh` put a binary in App Store Connect. That is
not a submission: the version has to exist, the build has to be attached to
it, the release notes have to be written, and the whole thing has to be handed
to review. That is what this does, and it is the part that used to mean
logging into a browser.
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asc_api import DRY_ID, Client, make_token  # noqa: E402

PLATFORMS = {"ios": "IOS", "macos": "MAC_OS", "mac": "MAC_OS"}


def wait_for_build(client, app, platform, cf_version, timeout_s):
    """A freshly uploaded build is PROCESSING for a while and cannot be
    attached to a version until it is VALID. Polling here is the difference
    between this script working right after an upload and only working if you
    happen to run it late enough."""
    deadline = time.time() + timeout_s
    reported = None
    while True:
        build = client.find_build(app, platform, cf_version)
        if build:
            state = build["attributes"].get("processingState")
            if state != reported:
                print(f"    build {cf_version}: {state}")
                reported = state
            if state == "VALID":
                return build
            if state in ("FAILED", "INVALID"):
                raise RuntimeError(
                    f"build {cf_version} came back {state} — check the email "
                    f"from Apple; it will not be attachable"
                )
        elif reported is None:
            print(f"    build {cf_version}: not visible yet")
            reported = "absent"
        if time.time() > deadline:
            raise RuntimeError(
                f"build {cf_version} was still {reported or 'absent'} after "
                f"{timeout_s}s. Uploads usually appear within 5-15 minutes; "
                f"raise --wait-build or re-run later."
            )
        time.sleep(20)


#: App Store Connect rejects a longer whatsNew outright.
WHATS_NEW_LIMIT = 4000


def read_notes(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read().strip()
    if not text:
        sys.exit(f"ERROR: {path} is empty")
    if len(text) > WHATS_NEW_LIMIT:
        sys.exit(f"ERROR: {path} is {len(text)} characters; Apple's limit is "
                 f"{WHATS_NEW_LIMIT}. Apple would reject the whole submission.")
    return text


def notes_for_locales(notes_dir, locales):
    """Map each locale Apple lists on the version to the file that should fill
    it. Resolved for every locale up front, because finding out halfway through
    that one has no notes leaves the version half-written."""
    chosen, missing = {}, []
    for locale in locales:
        for name in (locale, locale.split("-")[0], "default"):
            path = os.path.join(notes_dir, f"{name}.txt")
            if os.path.exists(path):
                chosen[locale] = path
                break
        else:
            missing.append(locale)
    if missing:
        sys.exit(f"ERROR: no release notes in {notes_dir} for: {', '.join(missing)}.\n"
                 f"       Add <locale>.txt for each, or a default.txt to cover the rest.")
    return {locale: read_notes(path) for locale, path in chosen.items()}


def main():
    p = argparse.ArgumentParser(description="Submit an uploaded build for App Store review.")
    p.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    p.add_argument("--version", required=True, help="marketing version, e.g. 4.12.0")
    p.add_argument("--build", help="CFBundleVersion of the upload (default: --version)")
    p.add_argument("--bundle-id", default=os.environ.get("ASC_BUNDLE_ID", "app.solomd"))
    p.add_argument("--notes-file", help="release notes; applied to every locale on the version")
    p.add_argument("--notes-dir",
                   help="a directory of per-locale release notes, named for the App Store "
                        "locale (zh-Hans.txt, de-DE.txt, ja.txt ...). A locale with no file "
                        "falls back to its language (de-DE.txt -> de.txt) and then to "
                        "default.txt; if none of those exist the run stops rather than "
                        "quietly shipping English to a storefront that is not English.")
    p.add_argument("--wait-build", type=int, default=1800,
                   help="seconds to wait for the build to finish processing (default 1800)")
    p.add_argument("--release-type", default="AFTER_APPROVAL",
                   choices=("AFTER_APPROVAL", "MANUAL"),
                   help="when an approved version goes on sale (default AFTER_APPROVAL, "
                        "matching every release so far); only applies to a version this "
                        "run creates")
    p.add_argument("--uses-non-exempt-encryption", action="store_true",
                   help="declare that the build uses encryption beyond what Apple exempts. "
                        "The default answer is no, which is what SoloMD has always declared: "
                        "it speaks HTTPS through the OS and ships no cryptography of its own.")
    p.add_argument("--dry-run", action="store_true",
                   help="read the real state, print every write instead of making it")
    p.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = p.parse_args()

    platform = PLATFORMS[args.platform]
    cf_version = args.build or args.version

    key_id = os.environ.get("ASC_KEY_ID")
    issuer = os.environ.get("ASC_ISSUER_ID")
    key_path = os.environ.get("ASC_KEY_PATH")
    if not (key_id and issuer and key_path):
        sys.exit("ERROR: ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH must be set "
                 "(submitting for review has no Apple ID fallback — it is API-only).")

    if args.notes_file and args.notes_dir:
        sys.exit("ERROR: pass --notes-file or --notes-dir, not both.")

    notes = None
    if args.notes_file:
        notes = read_notes(args.notes_file)

    client = Client(make_token(key_path, key_id, issuer), dry_run=args.dry_run)

    print(f"==> App {args.bundle_id}")
    app = client.app_id(args.bundle_id)
    print(f"    id {app}")

    print(f"==> Waiting for build {cf_version} ({platform}) to be processed")
    build = wait_for_build(client, app, platform, cf_version, args.wait_build)
    print(f"    build id {build['id']}")

    # An unanswered export-compliance question leaves the build in "Missing
    # Export Compliance" and review will not accept it. macOS uploads arrive
    # that way whenever the bundle has not declared the answer itself.
    if build["attributes"].get("usesNonExemptEncryption") is None:
        answer = bool(args.uses_non_exempt_encryption)
        print(f"==> Export compliance unanswered -> usesNonExemptEncryption = {answer}")
        client.set_export_compliance(build["id"], answer)

    print(f"==> Version {args.version}")
    version = client.find_version(app, platform, args.version)
    if version:
        state = version["attributes"].get("appStoreState") or \
                version["attributes"].get("state")
        print(f"    exists, state {state}")
        if state in ("WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE",
                     "READY_FOR_SALE"):
            sys.exit(f"ERROR: {args.version} is already {state} — nothing to do.")
    else:
        editable = client.find_editable_version(app, platform)
        if editable:
            old_ver = editable["attributes"].get("versionString")
            state = editable["attributes"].get("appStoreState") or \
                    editable["attributes"].get("state")
            print(f"    reusing editable version {old_ver} ({state}) -> {args.version}")
            version = client.update_version_string(editable["id"], args.version)
        else:
            version = client.create_version(app, platform, args.version,
                                            release_type=args.release_type)
            print(f"    created {version['id']} ({args.release_type})")

    if notes or args.notes_dir:
        locs = client.localizations(version["id"])
        if not locs and version["id"] == DRY_ID:
            # The version was invented a moment ago, so it has no localizations
            # to list. A real run finds the set Apple copies from the last
            # released version — fourteen of them, as of 4.11.19.
            print("==> Release notes: the version does not exist yet, so its "
                  "locales cannot be listed.")
            if args.notes_dir:
                have = sorted(f[:-4] for f in os.listdir(args.notes_dir)
                              if f.endswith(".txt"))
                print(f"    {args.notes_dir} covers: {', '.join(have)}")
            else:
                print(f"    {len(notes)} chars would go to every locale")
        elif not locs:
            sys.exit("ERROR: the version has no localizations, so there is nowhere "
                     "to put the release notes. App Store Connect normally copies "
                     "them from the previous version — check the version in the web "
                     "UI before re-running.")
        else:
            locales = [l["attributes"].get("locale") for l in locs]
            per_locale = notes_for_locales(args.notes_dir, locales) \
                if args.notes_dir else {loc: notes for loc in locales}
            print(f"==> Release notes -> {len(locs)} locale(s)")
            for loc in locs:
                locale = loc["attributes"].get("locale")
                client.set_whats_new(loc["id"], per_locale[locale])
                print(f"    {locale} ({len(per_locale[locale])} chars)")
    else:
        print("==> Release notes: left as-is (no --notes-file/--notes-dir given)")

    print("==> Attaching build to version")
    client.attach_build(version["id"], build["id"])

    if not args.yes and not args.dry_run:
        ans = input(f"\nSubmit {args.bundle_id} {args.version} ({platform}) "
                    f"for Apple review? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            sys.exit("Aborted — the version and build are still linked, nothing submitted.")

    print("==> Submitting for review")
    client.submit_for_review(app, platform, version["id"])
    where = ("https://appstoreconnect.apple.com/apps/"
             f"{app}/distribution/{'ios' if platform == 'IOS' else 'macos'}")
    if args.dry_run:
        print(f"\nDry run — nothing above was sent. Re-run without --dry-run "
              f"to submit.\nThe result would show up at {where}")
    else:
        print(f"\nSubmitted. Track it at {where}")


if __name__ == "__main__":
    main()
