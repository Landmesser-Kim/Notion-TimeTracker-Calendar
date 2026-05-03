# Notion Time Tracker → Daily Summary 자동 동기화

Notion의 Time Tracker 데이터베이스를 읽어서, 일별/프로젝트별 시간 합산 결과를 Daily Summary DB에 자동으로 동기화하는 스크립트.

## 기능

- Time Tracker의 항목을 **일별 + 프로젝트별**로 합산
- 각 날짜마다 **합계** 항목 자동 생성
- **변경된 데이터만** 업데이트 (불필요한 API 호출 최소화)
- macOS **launchd**로 10분마다 자동 실행 (맥북 잠자기 후 깨어나면 즉시 실행)

## 설치

```bash
npm install @notionhq/client dotenv
```

## 설정

### 1. Notion Integration 연결

- [Notion Integrations](https://www.notion.so/my-integrations)에서 Integration 생성
- Time Tracker DB 페이지 → `···` → 연결 → 생성한 Integration 추가

### 2. .env 파일 생성

```env
NOTION_TOKEN=your_notion_token
TIME_TRACKER_DB_ID=your_time_tracker_db_id
PARENT_PAGE_ID=your_parent_page_id
DAILY_SUMMARY_DB_ID=처음 실행 후 자동 생성된 ID 입력
ALL_TIME_SUMMARY_DB_ID=처음 실행 후 자동 생성된 ID 입력
```

### 3. 수동 실행

```bash
node sync-daily-time-tracker.js
```

첫 실행 시 Daily Summary DB가 자동 생성됩니다. 콘솔에 출력되는 DB ID를 `.env`의 `DAILY_SUMMARY_DB_ID`에 입력하세요.

프로젝트별 누적 시간을 위한 All Time DB를 만들 때는 아래 명령어를 실행하세요.

```bash
node sync-all-time.js
```

첫 실행 시 All Time DB가 자동 생성됩니다. 콘솔에 출력되는 DB ID를 `.env`의 `ALL_TIME_SUMMARY_DB_ID`에 입력하세요.

## 자동 실행 (launchd)

`~/Library/LaunchAgents/com.soohwan.notion-sync.plist`로 등록되어 있으며, **10분마다** 자동 실행됩니다.

- VSCode를 닫아도 동작
- 맥북 재부팅 후 자동 시작
- 맥북 잠자기 후 깨어나면 밀린 실행 자동 수행

### launchd 관리 명령어

```bash
# 중지
launchctl unload ~/Library/LaunchAgents/com.soohwan.notion-sync.plist

# 시작
launchctl load ~/Library/LaunchAgents/com.soohwan.notion-sync.plist

# 상태 확인
launchctl list | grep notion
```

### 로그 확인

```bash
# 실행 로그
cat logs/active/sync-daily.log

# 에러 로그
cat logs/active/sync-daily-error.log

# All Time 실행 로그
cat logs/active/sync-all-time.log

# All Time 에러 로그
cat logs/active/sync-all-time-error.log

# Weekly/Monthly 실행 로그
cat logs/active/sync-weekly-monthly.log

# Weekly/Monthly 에러 로그
cat logs/active/sync-weekly-monthly-error.log
```

## Notion 캘린더 뷰 설정

1. Daily Summary DB → "+" 새 뷰 추가 → 캘린더
2. 레이아웃 → 캘린더 표시 기준 → "Date"
3. 속성 표시 → "Project", "Time Display" 켜기
4. 조건부 색상 → Project별 색상 지정

## 파일 구조

| 파일 | 설명 |
|------|------|
| `sync-daily-time-tracker.js` | 메인 동기화 스크립트 |
| `sync-all-time.js` | 프로젝트별 누적 시간 동기화 스크립트 |
| `find-databases.js` | 접근 가능한 DB 목록 조회 (유틸리티) |
| `inspect-time.js` | Time Tracker 속성 구조 확인 (유틸리티) |
| `.env` | 토큰, DB ID 등 환경변수 (git 제외) |
| `.gitignore` | .env, 로그 파일 등 git 제외 설정 |
