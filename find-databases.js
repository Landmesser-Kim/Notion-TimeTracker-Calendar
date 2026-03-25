const { Client } = require("@notionhq/client");
require("dotenv").config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function findDatabases() {
  console.log("🔍 접근 가능한 모든 데이터베이스 검색 중...\n");

  const response = await notion.search({
    filter: { property: "object", value: "database" },
    page_size: 50,
  });

  if (response.results.length === 0) {
    console.log("❌ 접근 가능한 데이터베이스가 없습니다.");
    console.log("   통합이 올바르게 연결되어 있는지 확인하세요.");
    return;
  }

  console.log(`✅ ${response.results.length}개 데이터베이스 발견:\n`);

  for (const db of response.results) {
    const title = db.title?.map((t) => t.plain_text).join("") || "(제목 없음)";
    const id = db.id;
    const props = Object.keys(db.properties || {}).join(", ");

    console.log(`📌 ${title}`);
    console.log(`   ID: ${id}`);
    console.log(`   속성: ${props}`);
    console.log("");
  }
}

findDatabases().catch((err) => console.error("❌ 오류:", err.message));
