/*
 * 📊 Time Tracker → Weekly / Monthly Summary 동기화 스크립트
 *
 * 사용법:
 *   node sync-weekly-monthly.js
 *
 * 처음 실행하면 Weekly Summary DB와 Monthly Summary DB가 자동 생성됩니다.
 * 이후 실행하면 기존 데이터를 비교하여 변경된 항목만 갱신합니다.
 */

const { Client } = require("@notionhq/client");
require("dotenv").config();
const { createLogger } = require("./logs/logger");
const logger = createLogger("sync-weekly-monthly");

// ━━━ .env 파일에서 설정을 읽어옵니다 ━━━━━━━━━━━━━━━━━━━
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TIME_TRACKER_DB_ID = process.env.TIME_TRACKER_DB_ID;
const PARENT_PAGE_ID = process.env.PARENT_PAGE_ID;
let WEEKLY_SUMMARY_DB_ID = process.env.WEEKLY_SUMMARY_DB_ID || "";
let MONTHLY_SUMMARY_DB_ID = process.env.MONTHLY_SUMMARY_DB_ID || "";
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

      if (!timeMinutes && props["Start time"]?.date?.start && props["End time"]?.date?.start) {
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

// ─── 날짜 유틸리티 ──────────────────────────────────────
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getMonday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // 월요일 기준
  d.setDate(d.getDate() + diff);
  return toLocalDateStr(d);
}

function getSunday(mondayStr) {
  const d = new Date(mondayStr + "T00:00:00");
  d.setDate(d.getDate() + 6);
  return toLocalDateStr(d);
}

function formatDateShort(dateStr) {
  // "2026-03-23" → "03/23"
  return dateStr.slice(5).replace("-", "/");
}

function getISOWeekNumber(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 4);
  yearStart.setDate(yearStart.getDate() - ((yearStart.getDay() + 6) % 7));
  return Math.round((d - yearStart) / 604800000) + 1;
}

// ─── 주별 프로젝트별 합산 ───────────────────────────────
// 주가 월 경계를 넘는 경우에도, 해당 주의 월은 Week Start 기준으로 고정합니다.
// 예: 2026-03-30 주차의 4월 1일 작업도 Month는 2026-03으로 집계됩니다.
function aggregateByWeekAndProject(entries) {
  const map = {};

  for (const entry of entries) {
    const date = entry.startTime.split("T")[0];
    const monday = getMonday(date);
    const month = monday.slice(0, 7);
    const project = entry.project || "기타";
    const key = `${monday}__${month}__${project}`;

    if (!map[key]) {
      map[key] = { weekStart: monday, month, project, totalMinutes: 0, entries: [] };
    }
    map[key].totalMinutes += entry.timeMinutes;
    map[key].entries.push(entry.name);
  }

  return Object.values(map);
}

// ─── 월별 프로젝트별 합산 ───────────────────────────────
function aggregateByMonthAndProject(entries) {
  const map = {};

  for (const entry of entries) {
    const date = entry.startTime.split("T")[0];
    const month = date.slice(0, 7); // "YYYY-MM"
    const project = entry.project || "기타";
    const key = `${month}__${project}`;

    if (!map[key]) {
      map[key] = { month, project, totalMinutes: 0, entries: [] };
    }
    map[key].totalMinutes += entry.timeMinutes;
    map[key].entries.push(entry.name);
  }

  return Object.values(map);
}

// ─── Weekly Summary DB 자동 생성 ────────────────────────
async function createWeeklySummaryDB() {
  const newDb = await notion.databases.create({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    icon: { type: "emoji", emoji: "📅" },
    title: [{ type: "text", text: { content: "Weekly Summary" } }],
    properties: {
      Name: { title: {} },
      "Week Start": { date: {} },
      Week: { rich_text: {} },
      Month: { rich_text: {} },
      Project: {
        select: {
          options: [
            { name: "프로그래밍", color: "blue" },
            { name: "수학", color: "red" },
            { name: "독서", color: "green" },
            { name: "외국어 - 일본어", color: "yellow" },
            { name: "외국어 - 영어", color: "yellow" },
            { name: "AI 활용", color: "orange" },
            { name: "사람 만남", color: "pink" },
            { name: "학원", color: "gray" },
            { name: "적극적 시청", color: "brown" },
            { name: "영상 작품 시청", color: "purple" },
            { name: "운동", color: "default" },
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

  logger.log(`\n✅ Weekly Summary DB 생성 완료!`);
  logger.log(`   DB ID: ${newDb.id}`);
  logger.log(`   URL: https://www.notion.so/${newDb.id.replace(/-/g, "")}`);

  return newDb.id;
}

// ─── Monthly Summary DB 자동 생성 ───────────────────────
async function createMonthlySummaryDB() {
  const newDb = await notion.databases.create({
    parent: { type: "page_id", page_id: PARENT_PAGE_ID },
    icon: { type: "emoji", emoji: "📆" },
    title: [{ type: "text", text: { content: "Monthly Summary" } }],
    properties: {
      Name: { title: {} },
      Month: { rich_text: {} },
      "Month Start": { date: {} },
      Project: {
        select: {
          options: [
            { name: "프로그래밍", color: "blue" },
            { name: "수학", color: "red" },
            { name: "독서", color: "green" },
            { name: "외국어 - 일본어", color: "yellow" },
            { name: "외국어 - 영어", color: "yellow" },
            { name: "AI 활용", color: "orange" },
            { name: "사람 만남", color: "pink" },
            { name: "학원", color: "gray" },
            { name: "적극적 시청", color: "brown" },
            { name: "영상 작품 시청", color: "purple" },
            { name: "운동", color: "default" },
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

  logger.log(`\n✅ Monthly Summary DB 생성 완료!`);
  logger.log(`   DB ID: ${newDb.id}`);
  logger.log(`   URL: https://www.notion.so/${newDb.id.replace(/-/g, "")}`);

  return newDb.id;
}

// ─── Weekly Summary DB에 데이터 쓰기 ────────────────────
async function writeWeeklySummaries(dbId, summaries) {
  // 기존 DB에 Month 속성이 없을 수 있으므로 추가 시도
  try {
    await notion.databases.update({
      database_id: dbId,
      properties: { Month: { rich_text: {} } },
    });
  } catch {
    // 이미 존재하면 무시
  }

  logger.log("🔍 Weekly: 기존 데이터 확인 중...");
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
      const weekStart = props["Week Start"]?.date?.start || "";
      const name = props["Name"]?.title?.map((t) => t.plain_text).join("") || "";
      const month = props["Month"]?.rich_text?.map((t) => t.plain_text).join("") || "";
      const project = props["Project"]?.select?.name || name;
      const totalMinutes = props["Total Minutes"]?.number || 0;
      const details = props["Details"]?.rich_text?.map((t) => t.plain_text).join("") || "";
      if (weekStart && project) {
        const pageKey = month
          ? `${weekStart}__${month}__${project}`
          : `${weekStart}__${project}`;

        if (existingPages[pageKey]) {
          duplicatePages.add(page.id);
          continue;
        }

        existingPages[pageKey] = {
          id: page.id,
          name,
          totalMinutes,
          details,
          hasMonth: !!month,
        };
      }
    }

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }
  logger.log(`   기존 ${Object.keys(existingPages).length}개 항목 발견`);

  const newKeys = new Set();
  const consumedPageIds = new Set();
  let created = 0, updated = 0, skipped = 0;

  // 날짜순 정렬 (같은 주 내에서는 월 → 프로젝트명 순)
  const sorted = [...summaries].sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart) ||
    (a.month || "").localeCompare(b.month || "") ||
    a.project.localeCompare(b.project)
  );

  // 같은 주의 첫 행만 날짜 표시
  const seenWeeks = new Set();

  for (const s of sorted) {
    const month = s.month || s.weekStart.slice(0, 7);
    const key = `${s.weekStart}__${month}__${s.project}`;
    newKeys.add(key);

    const sunday = getSunday(s.weekStart);
    const weekLabel = `${formatDateShort(s.weekStart)} ~ ${formatDateShort(sunday)}`;
    const year = s.weekStart.slice(0, 4);
    const weekNum = getISOWeekNumber(s.weekStart);
    const weekDisplay = `${year} W${String(weekNum).padStart(2, "0")} (${weekLabel})`;
    const details = [...new Set(s.entries)].join(", ");

    const isFirst = !seenWeeks.has(s.weekStart);
    seenWeeks.add(s.weekStart);
    const nameValue = isFirst ? weekDisplay : "\u3164";

    const props = {
      Name: { title: [{ text: { content: nameValue } }] },
      "Week Start": { date: { start: s.weekStart, end: sunday } },
      Week: { rich_text: [{ text: { content: weekDisplay } }] },
      Month: { rich_text: [{ text: { content: month } }] },
      Project: { select: { name: s.project } },
      "Total Minutes": { number: s.totalMinutes },
      Details: { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
    };

    const legacyKey = `${s.weekStart}__${s.project}`;
    let existing = existingPages[key];
    let matchedKey = key;

    if (!existing || consumedPageIds.has(existing.id)) {
      existing = existingPages[legacyKey];
      matchedKey = legacyKey;
    }

    if (existing && consumedPageIds.has(existing.id)) {
      existing = null;
    }

    if (existing) {
      consumedPageIds.add(existing.id);
      newKeys.add(matchedKey);

      if (
        existing.hasMonth &&
        existing.name === nameValue &&
        existing.totalMinutes === s.totalMinutes &&
        existing.details === details.slice(0, 2000)
      ) {
        skipped++;
        continue;
      }
      await notion.pages.update({ page_id: existing.id, properties: props });
      updated++;
    } else {
      await notion.pages.create({ parent: { database_id: dbId }, properties: props });
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

  logger.log(`✅ Weekly 동기화 완료: ${created}개 생성, ${updated}개 업데이트, ${skipped}개 변경없음, ${removed}개 삭제`);
}

// ─── Monthly Summary DB에 데이터 쓰기 ───────────────────
async function writeMonthlySummaries(dbId, summaries) {
  logger.log("🔍 Monthly: 기존 데이터 확인 중...");
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
      const monthStart = props["Month Start"]?.date?.start || "";
      const name = props["Name"]?.title?.map((t) => t.plain_text).join("") || "";
      const project = props["Project"]?.select?.name || name;
      const totalMinutes = props["Total Minutes"]?.number || 0;
      const details = props["Details"]?.rich_text?.map((t) => t.plain_text).join("") || "";
      if (monthStart && project) {
        existingPages[`${monthStart}__${project}`] = { id: page.id, name, totalMinutes, details };
      }
    }

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }
  logger.log(`   기존 ${Object.keys(existingPages).length}개 항목 발견`);

  const newKeys = new Set();
  let created = 0, updated = 0, skipped = 0;

  const monthNames = {
    "01": "1월", "02": "2월", "03": "3월", "04": "4월",
    "05": "5월", "06": "6월", "07": "7월", "08": "8월",
    "09": "9월", "10": "10월", "11": "11월", "12": "12월",
  };

  // 날짜순 정렬 (같은 월 내에서는 프로젝트명 순)
  const sorted = [...summaries].sort((a, b) =>
    a.month.localeCompare(b.month) || a.project.localeCompare(b.project)
  );

  const seenMonths = new Set();

  for (const s of sorted) {
    const monthStart = `${s.month}-01`;
    const key = `${monthStart}__${s.project}`;
    newKeys.add(key);

    const year = s.month.slice(0, 4);
    const mm = s.month.slice(5, 7);
    const monthDisplay = `${year}년 ${monthNames[mm]}`;
    const details = [...new Set(s.entries)].join(", ");

    // 같은 월의 첫 행만 날짜 표시, 나머지는 비움
    const isFirst = !seenMonths.has(s.month);
    seenMonths.add(s.month);
    const nameValue = isFirst ? monthDisplay : "\u3164";

    const props = {
      Name: { title: [{ text: { content: nameValue } }] },
      "Month Start": { date: { start: monthStart } },
      Month: { rich_text: [{ text: { content: monthDisplay } }] },
      Project: { select: { name: s.project } },
      "Total Minutes": { number: s.totalMinutes },
      Details: { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
    };

    const existing = existingPages[key];
    if (existing) {
      if (existing.name === nameValue && existing.totalMinutes === s.totalMinutes && existing.details === details.slice(0, 2000)) {
        skipped++;
        continue;
      }
      await notion.pages.update({ page_id: existing.id, properties: props });
      updated++;
    } else {
      await notion.pages.create({ parent: { database_id: dbId }, properties: props });
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

  logger.log(`✅ Monthly 동기화 완료: ${created}개 생성, ${updated}개 업데이트, ${skipped}개 변경없음, ${removed}개 삭제`);
}

// ─── 메인 ────────────────────────────────────────────────
async function main() {
  try {
    logger.log("═══════════════════════════════════════════");
    logger.log("  📊 Time Tracker → Weekly / Monthly Summary");
    logger.log("═══════════════════════════════════════════\n");

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

    // ── Weekly Summary ──
    logger.log("\n📅 주별 프로젝트별 합산 중...");
    const weeklySummaries = aggregateByWeekAndProject(entries);
    logger.log(`   ${weeklySummaries.length}개 주별 요약 생성`);

    logger.log("\n📅 최근 주별 데이터 미리보기:");
    weeklySummaries
      .filter((s) => s.project !== "합계")
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
      .slice(0, 10)
      .forEach((s) => {
        const h = Math.floor(s.totalMinutes / 60);
        const m = s.totalMinutes % 60;
        const sunday = getSunday(s.weekStart);
        const label = `${formatDateShort(s.weekStart)}~${formatDateShort(sunday)}`;
        const monthTag = s.month ? ` [${s.month}]` : "";
        logger.log(
          `   ${label}${monthTag}  ${s.project.padEnd(15)} ${h}h ${String(m).padStart(2, "0")}m`
        );
      });

    // ── Monthly Summary ──
    logger.log("\n📆 월별 프로젝트별 합산 중...");
    const monthlySummaries = aggregateByMonthAndProject(entries);
    logger.log(`   ${monthlySummaries.length}개 월별 요약 생성`);

    logger.log("\n📆 월별 데이터 미리보기:");
    monthlySummaries
      .filter((s) => s.project !== "합계")
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 10)
      .forEach((s) => {
        const h = Math.floor(s.totalMinutes / 60);
        const m = s.totalMinutes % 60;
        logger.log(
          `   ${s.month}     ${s.project.padEnd(15)} ${h}h ${String(m).padStart(2, "0")}m`
        );
      });

    // ── DB 생성 (최초 실행 시) ──
    if (!WEEKLY_SUMMARY_DB_ID) {
      logger.log("\n🔨 Weekly Summary DB 생성 중...");
      WEEKLY_SUMMARY_DB_ID = await createWeeklySummaryDB();
    }

    if (!MONTHLY_SUMMARY_DB_ID) {
      logger.log("\n🔨 Monthly Summary DB 생성 중...");
      MONTHLY_SUMMARY_DB_ID = await createMonthlySummaryDB();
    }

    // ── 동기화 ──
    logger.log("");
    await writeWeeklySummaries(WEEKLY_SUMMARY_DB_ID, weeklySummaries);
    logger.log("");
    await writeMonthlySummaries(MONTHLY_SUMMARY_DB_ID, monthlySummaries);

    logger.log("\n🎉 동기화 완료!");
    logger.log(`   📅 Weekly:  https://www.notion.so/${WEEKLY_SUMMARY_DB_ID.replace(/-/g, "")}`);
    logger.log(`   📆 Monthly: https://www.notion.so/${MONTHLY_SUMMARY_DB_ID.replace(/-/g, "")}`);

    // DB ID 저장 안내
    if (!process.env.WEEKLY_SUMMARY_DB_ID || !process.env.MONTHLY_SUMMARY_DB_ID) {
      logger.log("\n   💡 .env 파일에 아래 ID를 추가하세요:");
      if (!process.env.WEEKLY_SUMMARY_DB_ID) {
        logger.log(`      WEEKLY_SUMMARY_DB_ID=${WEEKLY_SUMMARY_DB_ID}`);
      }
      if (!process.env.MONTHLY_SUMMARY_DB_ID) {
        logger.log(`      MONTHLY_SUMMARY_DB_ID=${MONTHLY_SUMMARY_DB_ID}`);
      }
    }

    logger.log("\n📌 Notion에서 보기 설정:");
    logger.log('   1. 테이블 뷰 → Project로 그룹화하면 프로젝트별 시간 한눈에 확인');
    logger.log('   2. 차트 뷰 → Total Minutes 기준으로 프로젝트별 비교 가능');
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
