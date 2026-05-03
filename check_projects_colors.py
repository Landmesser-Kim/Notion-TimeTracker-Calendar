"""Check select option colors of Projects-like properties in Daily/Weekly/Monthly/AllTime DBs."""
import os
from collections import defaultdict

import requests
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.environ["NOTION_TOKEN"]

DBS = {
    "Daily Summary":   "32ea9f36-53fc-8193-bc82-fd2bebecae98",
    "Weekly Summary":  "335a9f36-53fc-816f-a0d8-c166837d7394",
    "Monthly Summary": "335a9f36-53fc-8145-8a8f-df836e49749e",
    "All Time":        "336a9f36-53fc-81ad-ad58-e3eed0425791",
}

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2022-06-28",
}


def get_db(db_id):
    r = requests.get(f"https://api.notion.com/v1/databases/{db_id}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def main():
    for label, db_id in DBS.items():
        print(f"\n========== {label} ({db_id}) ==========")
        db = get_db(db_id)
        for prop_name, prop in db["properties"].items():
            ptype = prop["type"]
            if ptype not in ("select", "multi_select", "status"):
                continue
            opts = prop[ptype].get("options", [])
            if not opts:
                continue
            print(f"\n  [{prop_name}]  type={ptype}")
            by_color = defaultdict(list)
            for o in opts:
                by_color[o["color"]].append(o["name"])
                print(f"    - {o['name']:<25} color={o['color']}")
            dups = {c: ns for c, ns in by_color.items() if len(ns) > 1}
            if dups:
                print(f"    ⚠️ 중복 색상:")
                for c, ns in dups.items():
                    print(f"       [{c}] → {ns}")


if __name__ == "__main__":
    main()
