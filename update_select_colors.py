"""Recolor Project select options in 4 summary DBs.

Strategy (Notion API forbids in-place color updates):
  1. PATCH each data_source to drop options needing recolor + drop stale options.
  2. PATCH again (combined in one call) to re-add fresh options with target colors.
  3. Pages whose option got dropped end up with Project=null. Archive them.
  4. User must re-run the 3 sync scripts to repopulate.

Meta options (합계/기타/Unknown) are intentionally LEFT ALONE to minimize
disruption — only the 11 real projects are recolored.
"""
import os
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.environ["NOTION_TOKEN"]
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json",
}

DBS = {
    "Daily Summary":   "32ea9f36-53fc-8193-bc82-fd2bebecae98",
    "Weekly Summary":  "335a9f36-53fc-816f-a0d8-c166837d7394",
    "Monthly Summary": "335a9f36-53fc-8145-8a8f-df836e49749e",
    "All Time":        "336a9f36-53fc-81ad-ad58-e3eed0425791",
}

TARGET_COLORS = {
    "프로그래밍": "blue",
    "수학": "red",
    "독서": "green",
    "외국어 - 일본어": "yellow",
    "외국어 - 영어": "yellow",
    "AI 활용": "orange",
    "사람 만남": "pink",
    "학원": "gray",
    "적극적 시청": "brown",
    "영상 작품 시청": "purple",
    "운동": "default",
}

ENSURE_PRESENT = list(TARGET_COLORS.keys())
META_NAMES = {"합계", "기타", "Unknown"}


def is_stale(name: str) -> bool:
    return name.startswith("📊 합계:")


def get_data_source_id(db_id: str) -> str:
    r = requests.get(f"https://api.notion.com/v1/databases/{db_id}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()["data_sources"][0]["id"]


def get_options(ds_id: str):
    r = requests.get(f"https://api.notion.com/v1/data_sources/{ds_id}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()["properties"]["Project"]["select"]["options"]


def patch_options(ds_id: str, new_options):
    return requests.patch(
        f"https://api.notion.com/v1/data_sources/{ds_id}",
        headers=HEADERS,
        json={"properties": {"Project": {"select": {"options": new_options}}}},
        timeout=30,
    )


def query_pages_no_project(ds_id: str):
    pages = []
    cursor = None
    while True:
        body = {
            "page_size": 100,
            "filter": {"property": "Project", "select": {"is_empty": True}},
        }
        if cursor:
            body["start_cursor"] = cursor
        r = requests.post(
            f"https://api.notion.com/v1/data_sources/{ds_id}/query",
            headers=HEADERS,
            json=body,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        pages.extend(data["results"])
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return pages


def archive_page(page_id: str):
    return requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=HEADERS,
        json={"archived": True},
        timeout=30,
    )


def update_db(label: str, db_id: str, dry_run: bool):
    print(f"\n=== {label} ===")
    ds_id = get_data_source_id(db_id)
    existing = get_options(ds_id)

    new_options = []
    drop_recolor = []  # (name, old_color, new_color)
    drop_stale = []
    keep = []

    for o in existing:
        name = o["name"]
        if is_stale(name):
            drop_stale.append(name)
            continue
        target_color = TARGET_COLORS.get(name)
        if target_color is None:
            # Meta or unknown name — keep as is.
            new_options.append({"id": o["id"], "name": name, "color": o["color"]})
            keep.append(f"{name} ({o['color']}, meta/keep)")
            continue
        if target_color == o["color"]:
            new_options.append({"id": o["id"], "name": name, "color": o["color"]})
            keep.append(f"{name} ({o['color']})")
        else:
            drop_recolor.append((name, o["color"], target_color))
            # Don't include in new_options yet; will append fresh below.

    # Add target options that need to be (re-)created.
    existing_kept_names = {opt["name"] for opt in new_options}
    for name in ENSURE_PRESENT:
        if name not in existing_kept_names:
            new_options.append({"name": name, "color": TARGET_COLORS[name]})

    print(f"  keep ({len(keep)}):")
    for s in keep:
        print(f"    - {s}")
    if drop_recolor:
        print(f"  drop+recreate ({len(drop_recolor)}):")
        for n, oc, nc in drop_recolor:
            print(f"    - {n}: {oc} → {nc}")
    if drop_stale:
        print(f"  drop stale ({len(drop_stale)}):")
        for n in drop_stale:
            print(f"    - {n}")

    if dry_run:
        print("  (dry-run; no changes applied)")
        return

    # Notion treats name as identity too: a drop+re-add in a single PATCH is
    # rejected ("Cannot update color of select with name: ..."). So we do it
    # in two passes — first drop everything we're removing/recoloring, then
    # add fresh options.
    options_to_drop = {n for n, _, _ in drop_recolor}
    pass1_options = [o for o in new_options if o["name"] not in options_to_drop]

    r1 = patch_options(ds_id, pass1_options)
    if r1.status_code != 200:
        print(f"  ❌ PATCH pass 1 failed: {r1.status_code} {r1.text[:500]}")
        return
    print(f"  ✅ PATCH pass 1 ok (dropped {len(options_to_drop)} + stale)")
    time.sleep(1)

    # Pass 2: add the recolored options back fresh.
    pass2_options = list(pass1_options)
    for n, _, nc in drop_recolor:
        pass2_options.append({"name": n, "color": nc})
    # Also include any ENSURE_PRESENT names missing.
    pass2_names = {o["name"] for o in pass2_options}
    for n in ENSURE_PRESENT:
        if n not in pass2_names:
            pass2_options.append({"name": n, "color": TARGET_COLORS[n]})

    r2 = patch_options(ds_id, pass2_options)
    if r2.status_code != 200:
        print(f"  ❌ PATCH pass 2 failed: {r2.status_code} {r2.text[:500]}")
        return
    print(f"  ✅ PATCH pass 2 ok ({len(pass2_options)} options final)")

    # Brief pause to let Notion reconcile before querying orphans.
    time.sleep(1)
    orphans = query_pages_no_project(ds_id)
    print(f"  orphan pages (Project=null): {len(orphans)}")
    archived = 0
    for p in orphans:
        ar = archive_page(p["id"])
        if ar.status_code != 200:
            print(f"    ⚠️ archive failed for {p['id']}: {ar.status_code} {ar.text[:200]}")
        else:
            archived += 1
    print(f"  ✅ archived {archived}/{len(orphans)} orphan pages")


def main():
    dry_run = "--apply" not in sys.argv
    if dry_run:
        print(">>> DRY RUN (use --apply to execute)\n")
    for label, db_id in DBS.items():
        update_db(label, db_id, dry_run)


if __name__ == "__main__":
    main()
