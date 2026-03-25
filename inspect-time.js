const { Client } = require("@notionhq/client");
require("dotenv").config();

const TIME_TRACKER_DB_ID = process.env.TIME_TRACKER_DB_ID;
const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function inspect() {
  // DB 속성 타입 확인
  const db = await notion.databases.retrieve({ database_id: TIME_TRACKER_DB_ID });
  console.log("📋 속성 타입:");
  for (const [key, val] of Object.entries(db.properties)) {
    console.log(`   ${key}: ${val.type}`);
  }

  // 첫 항목의 실제 값 확인
  const query = await notion.databases.query({
    database_id: TIME_TRACKER_DB_ID,
    page_size: 1,
  });

  if (query.results.length > 0) {
    const props = query.results[0].properties;
    console.log("\n🔎 첫 번째 항목의 시간 관련 속성:");
    for (const [key, val] of Object.entries(props)) {
      if (
        key.toLowerCase().includes("time") ||
        key.toLowerCase().includes("total") ||
        key.toLowerCase().includes("daily") ||
        key.toLowerCase().includes("weekly") ||
        key.toLowerCase().includes("monthly")
      ) {
        console.log(`\n   ${key} (${val.type}):`);
        console.log(`   ${JSON.stringify(val, null, 4)}`);
      }
    }
  }
}

inspect().catch((err) => console.error("❌ 오류:", err.message));
