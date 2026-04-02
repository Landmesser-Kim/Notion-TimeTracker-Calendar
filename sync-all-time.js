/*
 * 📊 Time Tracker → All Time 동기화 스크립트
 *
 * 사용법:
 *   node sync-all-time.js
 *
 * 처음 실행하면 All Time DB가 자동 생성됩니다.
 * 이후 실행하면 기존 데이터를 비교하여 변경된 항목만 갱신합니다.
 */

const { Client } = require("@notionhq/client");
require("dotenv").config();
const { createLogger } = require("./logs/logger");
const logger = createLogger("sync-all-time");

// ━━━ .env 파일에서 설정을 읽어옵니다 ━━━━━━━━━━━━━━━━━━━
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TIME_TRACKER_DB_ID = process.env.TIME_TRACKER_DB_ID;
const PARENT_PAGE_ID = process.env.PARENT_PAGE_ID;
let ALL_TIME_SUMMARY_DB_ID = process.env.ALL_TIME_SUMMARY_DB_ID || "";
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const notion = new Client({ auth: NOTION_TOKEN });

// ─── Time Tracker에서 모든 항목 가져오기 ─────────────────
async function fetchAllTimeEntries() {
  const entries = [];
  let cursor = undefined;

  while (true) {
    const response = await notion.databases.query({
      database_id: TIME_TRACKER_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const props = page.properties;

      const name =
        props["Name"]?.title?.map((t) => t.plain_text).join("") || "";
      const startTime = props["Start time"]?.date?.start || null;

      let timeMinutes = 0;
      const totalTimeProp = props["Total time "] || props["Total time"];
      if (totalTimeProp) {
        if (totalTimeProp.type === "formula") {
          timeMinutes = totalTimeProp.formula?.number || 0;
        } else if (totalTimeProp.type === "number") {
          timeMinutes = totalTimeProp.number || 0;
        }
      }

      if (
        !timeMinutes &&
        props["Start time"]?.date?.start &&
        props["End time"]?.date?.start
      ) {
        const start = new Date(props["Start time"].date.start);
        const end = new Date(props["End time"].date.start);
        const diffMs = end - start;
        if (diffMs > 0) {
          timeMinutes = Math.round(diffMs / 60000);
        }
      }

      let project = "";
      const projectsProp = props["Projects"];
      if (projectsProp?.relation?.length > 0) {
        project = projectsProp.relation[0].id;
      } else if (projectsProp?.select) {
        project = projectsProp.select.name || "";
      } else if (projectsProp?.multi_select?.length > 0) {
        project = projectsProp.multi_select[0].name || "";
      }

      if (startTime) {
        entries.push({ name, startTime, timeMinutes, project });
      }
    }

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  return entries;
}

// ─── Relation인 경우 프로젝트 이름 가져오기 ──────────────
async function resolveProjectNames(entries) {
  const projectIds = [
    ...new Set(
      entries
        .filter((e) => e.project && e.project.length > 30)
        .map((e) => e.project)
    ),
  ];

  const nameMap = {};
  for (const id of projectIds) {
    try {
      const page = await notion.pages.retrieve({ page_id: id });
      const titleProp = Object.values(page.properties).find(
        (p) => p.type === "title"
      );
      nameMap[id] =
        titleProp?.title?.map((t) => t.plain_text).join("") || "Unknown";
    } catch {
      nameMap[id] = "Unknown";
    }
  }

  return entries.map((e) => ({
    ...e,
    project: nameMap[e.project] || e.project,
  }));
}

// ─── 프로젝트별 누적 합산 ────────────────────────────────
function aggregateByProject(entries) {
  const map = {};

  for (const entry of entries) {
    const project = entry.project || "기타";
    if (!map[project]) {
      map[project] = { project, totalMinutes: 0, sessions: 0, entries: [] };
    }
    map[project].totalMinutes += entry.timeMinutes;
    map[project].sessions += 1;
    map[project].entries.push(entry.name);
  }

  const items = Object.values(map);
  const totalMinutes = items.reduce((sum, item) => sum + item.totalMinutes, 0);
  const totalSessions = items.reduce((sum, item) => sum + item.sessions, 0);

  items.push({
    project: "합계",
    totalMinutes,
    sessions: totalSessions,
    entries: [],
  });

  return items;
}

// ─── All Time DB 자동 생성 ───────────────────────────────
async function createAllTimeSummaryDB() {
  const newDb = await notion.databases.create({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    icon: { type: "emoji", emoji: "🧮" },
    title: [{ type: "text", text: { content: "All Time" } }],
    properties: {
      Name: { title: {} },
      Project: {
        select: {
          options: [
            { name: "프로그래밍", color: "blue" },
            { name: "수학", color: "red" },
            { name: "독서", color: "green" },
            { name: "외국어 - 일본어", color: "yellow" },
            { name: "외국어 - 영어", color: "purple" },
            { name: "기타", color: "brown" },
            { name: "합계", color: "default" },
          ],
        },
      },
      "Total Minutes": { number: { format: "number" } },
      "Time Display": {
        formula: {
          expression:
            'format(floor(prop("Total Minutes") / 60)) + "h " + format(prop("Total Minutes") % 60) + "m"',
        },
      },
      Sessions: { number: { format: "number" } },
      Details: { rich_text: {} },
    },
  });

  logger.log("\n✅ All Time DB 생성 완료!");
  logger.log(`   DB ID: ${newDb.id}`);
  logger.log(`   URL: https://www.notion.so/${newDb.id.replace(/-/g, "")}`);
  logger.log("\n   💡 .env에 아래 값을 추가해두면 다음 실행 때 재사용됩니다:");
  logger.log(`      ALL_TIME_SUMMARY_DB_ID=${newDb.id}`);

  return newDb.id;
}

// ─── All Time DB에 데이터 쓰기 ───────────────────────────
async function writeAllTimeSummaries(dbId, summaries) {
  logger.log("🔍 기존 데이터 확인 중...");
  const existingPages = {};
  const duplicatePages = new Set();
  let cursor = undefined;

  while (true) {
    const response = await notion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const props = page.properties;
      const name =
        props["Name"]?.title?.map((t) => t.plain_text).join("") || "";
      const project = props["Project"]?.select?.name || name;
      const totalMinutes = props["Total Minutes"]?.number || 0;
      const sessions = props["Sessions"]?.number || 0;
      const details =
        props["Details"]?.rich_text?.map((t) => t.plain_text).join("") || "";

      if (!project) continue;

      if (existingPages[project]) {
        duplicatePages.add(page.id);
        continue;
      }

      existingPages[project] = { id: page.id, totalMinutes, sessions, details };
    }

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  logger.log(`   기존 ${Object.keys(existingPages).length}개 항목 발견`);

  const newKeys = new Set();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const s of summaries) {
    const key = s.project;
    const details = [...new Set(s.entries)].join(", ");
    newKeys.add(key);

    const properties = {
      Name: { title: [{ text: { content: s.project } }] },
      Project: { select: { name: s.project } },
      "Total Minutes": { number: s.totalMinutes },
      Sessions: { number: s.sessions },
      Details: { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
    };

    const existing = existingPages[key];
    if (existing) {
      if (
        existing.totalMinutes === s.totalMinutes &&
        existing.sessions === s.sessions &&
        existing.details === details.slice(0, 2000)
      ) {
        skipped++;
        continue;
      }
      await notion.pages.update({
        page_id: existing.id,
        properties,
      });
      updated++;
    } else {
      await notion.pages.create({
        parent: { database_id: dbId },
        properties,
      });
      created++;
    }
  }

  let removed = 0;
  for (const [key, page] of Object.entries(existingPages)) {
    if (!newKeys.has(key)) {
      await notion.pages.update({ page_id: page.id, archived: true });
      removed++;
    }
  }

  for (const pageId of duplicatePages) {
    await notion.pages.update({ page_id: pageId, archived: true });
    removed++;
  }

  logger.log(
    `✅ 동기화 완료: ${created}개 생성, ${updated}개 업데이트, ${skipped}개 변경없음, ${removed}개 삭제`
  );
}

// ─── 메인 ────────────────────────────────────────────────
async function main() {
  try {
    logger.log("═══════════════════════════════════════");
    logger.log("  📊 Time Tracker → All Time 동기화");
    logger.log("═══════════════════════════════════════\n");

    logger.log("🔍 Time Tracker 데이터 가져오는 중...");
    let entries = await fetchAllTimeEntries();
    logger.log(`   ${entries.length}개 항목 발견`);

    if (entries.length === 0) {
      logger.log("⚠️  항목이 없습니다. DB ID와 연결 상태를 확인하세요.");
      return;
    }

    logger.log("🏷️  프로젝트 이름 확인 중...");
    entries = await resolveProjectNames(entries);

    const withTime = entries.filter((e) => e.timeMinutes > 0);
    const zeroTime = entries.filter((e) => e.timeMinutes === 0);
    logger.log(`   ✅ 시간 있는 항목: ${withTime.length}개`);
    if (zeroTime.length > 0) {
      logger.log(`   ⚠️  시간이 0인 항목: ${zeroTime.length}개`);
    }

    logger.log("🧮 프로젝트별 누적 합산 중...");
    const summaries = aggregateByProject(entries);
    logger.log(`   ${summaries.length}개 누적 요약 생성`);

    logger.log("\n📌 누적 데이터 미리보기:");
    summaries
      .sort((a, b) => b.totalMinutes - a.totalMinutes)
      .forEach((s) => {
        const h = Math.floor(s.totalMinutes / 60);
        const m = s.totalMinutes % 60;
        logger.log(
          `   ${s.project.padEnd(15)} ${h}h ${String(m).padStart(2, "0")}m (${s.sessions}회)`
        );
      });

    if (!ALL_TIME_SUMMARY_DB_ID) {
      logger.log("\n🔨 All Time DB 생성 중...");
      ALL_TIME_SUMMARY_DB_ID = await createAllTimeSummaryDB();
    }

    logger.log("");
    await writeAllTimeSummaries(ALL_TIME_SUMMARY_DB_ID, summaries);

    logger.log("\n🎉 동기화 완료!");
    logger.log(
      `   👉 https://www.notion.so/${ALL_TIME_SUMMARY_DB_ID.replace(/-/g, "")}`
    );
  } catch (error) {
    logger.error("\n❌ 오류 발생:", error.message);
    if (error.code === "unauthorized") {
      logger.error("   → 시크릿 키가 올바른지 확인하세요.");
    }
    if (error.code === "object_not_found") {
      logger.error("   → DB ID가 올바른지, 통합이 연결되어 있는지 확인하세요.");
    }
  } finally {
    logger.close();
  }
}

main();
