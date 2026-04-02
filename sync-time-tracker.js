/*
 * 📊 Time Tracker → Daily Summary 동기화 스크립트
 *
 * 사용법:
 *   1. Node.js 설치 (https://nodejs.org)
 *   2. npm install @notionhq/client@2.2.15
 *   3. node sync-time-tracker.js
 *
 * 처음 실행하면 Daily Summary DB가 자동 생성됩니다.
 * 이후 실행하면 기존 데이터를 지우고 최신 데이터로 갱신합니다.
 */

const { Client } = require("@notionhq/client");
require("dotenv").config();
const { createLogger } = require("./logs/logger");
const logger = createLogger("sync-daily");

// ━━━ .env 파일에서 설정을 읽어옵니다 ━━━━━━━━━━━━━━━━━━━
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TIME_TRACKER_DB_ID = process.env.TIME_TRACKER_DB_ID;
const PARENT_PAGE_ID = process.env.PARENT_PAGE_ID;
let DAILY_SUMMARY_DB_ID = process.env.DAILY_SUMMARY_DB_ID || "";
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

      // Name
      const name =
        props["Name"]?.title?.map((t) => t.plain_text).join("") || "";

      // Start time (날짜)
      const startTime = props["Start time"]?.date?.start || null;

      // Total time (formula → number, 분 단위)
      // 속성 이름에 trailing space가 있을 수 있음
      let timeMinutes = 0;
      const totalTimeProp = props["Total time "] || props["Total time"];
      if (totalTimeProp) {
        if (totalTimeProp.type === "formula") {
          timeMinutes = totalTimeProp.formula?.number || 0;
        } else if (totalTimeProp.type === "number") {
          timeMinutes = totalTimeProp.number || 0;
        }
      }

      // fallback: Start time과 End time의 차이로 계산
      if (!timeMinutes && props["Start time"]?.date?.start && props["End time"]?.date?.start) {
        const start = new Date(props["Start time"].date.start);
        const end = new Date(props["End time"].date.start);
        const diffMs = end - start;
        if (diffMs > 0) {
          timeMinutes = Math.round(diffMs / 60000);
        }
      }

      // Projects (relation)
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

// ─── 일별 프로젝트별 합산 ────────────────────────────────
function aggregateByDayAndProject(entries) {
  const map = {};

  for (const entry of entries) {
    const date = entry.startTime.split("T")[0]; // YYYY-MM-DD
    const project = entry.project || "기타";
    const key = `${date}__${project}`;

    if (!map[key]) {
      map[key] = { date, project, totalMinutes: 0, entries: [] };
    }
    map[key].totalMinutes += entry.timeMinutes;
    map[key].entries.push(entry.name);
  }

  const items = Object.values(map);

  // 일별 합계 항목 추가
  const dailyTotals = {};
  for (const item of items) {
    if (!dailyTotals[item.date]) {
      dailyTotals[item.date] = 0;
    }
    dailyTotals[item.date] += item.totalMinutes;
  }

  for (const [date, totalMinutes] of Object.entries(dailyTotals)) {
    items.push({
      date,
      project: "합계",
      totalMinutes,
      entries: [],
    });
  }

  return items;
}

// ─── Daily Summary DB 자동 생성 ──────────────────────────
async function createDailySummaryDB() {
  const newDb = await notion.databases.create({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    icon: { type: "emoji", emoji: "📊" },
    title: [{ type: "text", text: { content: "Daily Summary" } }],
    properties: {
      Name: { title: {} },
      Date: { date: {} },
      Project: {
        select: {
          options: [
            { name: "프로그래밍", color: "blue" },
            { name: "수학", color: "red" },
            { name: "독서", color: "green" },
            { name: "외국어 - 일본어", color: "yellow" },
            { name: "외국어 - 영어", color: "purple" },
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
      Details: { rich_text: {} },
    },
  });

  logger.log(`\n✅ Daily Summary DB 생성 완료!`);
  logger.log(`   DB ID: ${newDb.id}`);
  logger.log(`   URL: https://www.notion.so/${newDb.id.replace(/-/g, "")}`);
  logger.log(`\n   💡 다음 실행부터는 스크립트 상단의 DAILY_SUMMARY_DB_ID에`);
  logger.log(`      "${newDb.id}" 를 넣어주세요.\n`);

  return newDb.id;
}

// ─── Daily Summary DB에 데이터 쓰기 (업데이트 방식) ──────
async function writeSummaries(dbId, summaries) {
  // 1. 기존 페이지를 날짜+프로젝트 키로 매핑
  logger.log("🔍 기존 데이터 확인 중...");
  const existingPages = {};
  let cursor = undefined;
  while (true) {
    const response = await notion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const props = page.properties;
      const date = props["Date"]?.date?.start || "";
      const project = props["Name"]?.title?.map((t) => t.plain_text).join("") || "";
      const totalMinutes = props["Total Minutes"]?.number || 0;
      const details = props["Details"]?.rich_text?.map((t) => t.plain_text).join("") || "";
      if (date && project) {
        existingPages[`${date}__${project}`] = { id: page.id, totalMinutes, details };
      }
    }

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }
  logger.log(`   기존 ${Object.keys(existingPages).length}개 항목 발견`);

  // 2. 변경된 항목만 처리
  const newKeys = new Set();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const s of summaries) {
    const key = `${s.date}__${s.project}`;
    newKeys.add(key);
    const details = s.entries.join(", ");

    const existing = existingPages[key];
    if (existing) {
      // 값이 같으면 건너뜀
      if (existing.totalMinutes === s.totalMinutes && existing.details === details.slice(0, 2000)) {
        skipped++;
        continue;
      }
      await notion.pages.update({
        page_id: existing.id,
        properties: {
          Name: { title: [{ text: { content: s.project } }] },
          Date: { date: { start: s.date } },
          Project: { select: { name: s.project } },
          "Total Minutes": { number: s.totalMinutes },
          Details: { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
        },
      });
      updated++;
    } else {
      await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          Name: { title: [{ text: { content: s.project } }] },
          Date: { date: { start: s.date } },
          Project: { select: { name: s.project } },
          "Total Minutes": { number: s.totalMinutes },
          Details: { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
        },
      });
      created++;
    }
  }

  // 3. 더 이상 없는 항목만 삭제
  let removed = 0;
  for (const [key, page] of Object.entries(existingPages)) {
    if (!newKeys.has(key)) {
      await notion.pages.update({ page_id: page.id, archived: true });
      removed++;
    }
  }

  logger.log(`✅ 동기화 완료: ${created}개 생성, ${updated}개 업데이트, ${skipped}개 변경없음, ${removed}개 삭제`);
}

// ─── 메인 ────────────────────────────────────────────────
async function main() {
  try {
    logger.log("═══════════════════════════════════════");
    logger.log("  📊 Time Tracker → Daily Summary 동기화");
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

    logger.log("📊 일별 프로젝트별 합산 중...");
    const summaries = aggregateByDayAndProject(entries);
    logger.log(`   ${summaries.length}개 일별 요약 생성\n`);

    logger.log("📅 최근 데이터 미리보기:");
    summaries
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10)
      .forEach((s) => {
        const h = Math.floor(s.totalMinutes / 60);
        const m = s.totalMinutes % 60;
        logger.log(
          `   ${s.date}  ${s.project.padEnd(15)} ${h}h ${String(m).padStart(2, "0")}m`
        );
      });

    if (!DAILY_SUMMARY_DB_ID) {
      logger.log("\n🔨 Daily Summary DB 생성 중...");
      DAILY_SUMMARY_DB_ID = await createDailySummaryDB();
    }

    logger.log("");
    await writeSummaries(DAILY_SUMMARY_DB_ID, summaries);

    logger.log("\n🎉 동기화 완료!");
    logger.log(
      `   👉 https://www.notion.so/${DAILY_SUMMARY_DB_ID.replace(/-/g, "")}`
    );
    logger.log("\n📌 캘린더 뷰 설정:");
    logger.log('   1. Daily Summary DB → "+" 새 뷰 추가 → 캘린더');
    logger.log('   2. 레이아웃 → 캘린더 표시 기준 → "Date"');
    logger.log('   3. 속성 표시 → "Project", "Time Display" 켜기');
    logger.log("   4. 조건부 색상 → Project별 색상 지정하면 완성!");
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
