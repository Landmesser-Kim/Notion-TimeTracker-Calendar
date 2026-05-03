# Notion Time Tracker / Calendar

## Notion DB IDs
- Time tracker: `42aa9f36-53fc-8272-8b2d-01e724f065bf`
- Projects Database: `25ea9f36-53fc-8288-a17b-0164c2c37d78`
- Daily Summary: `32ea9f36-53fc-8193-bc82-fd2bebecae98`
- Weekly Summary: `335a9f36-53fc-816f-a0d8-c166837d7394`
- Monthly Summary: `335a9f36-53fc-8145-8a8f-df836e49749e`
- All Time: `336a9f36-53fc-81ad-ad58-e3eed0425791`

## Projects relation 페이지 IDs
- 운동: `354a9f36-53fc-81b7-a57b-cbb8299234ad`
- 적극적 시청: `354a9f36-53fc-8181-9aa3-f8add9861cfc`
- 영상 작품 시청: `354a9f36-53fc-817c-911d-d5856992381b`

## 규칙

### "운동 추가" 요청 시
사용자가 "운동 추가해" 또는 유사한 표현(예: "운동 기록해줘", "운동 넣어줘")으로 요청하면 Time tracker DB에 페이지를 생성한다.

- Projects relation: 위의 '운동' 페이지 ID
- Start time: 오늘 날짜의 00:00 (Asia/Seoul)
- End time: 오늘 날짜의 01:00 (Asia/Seoul)
- Icon: `{type:"icon", icon:{name:"stopwatch", color:"gray"}}` (기존 Time tracker 페이지들과 통일)

`/workout` skill(体.3 DB에 운동 세트 기록)과는 별개의 규칙이므로 혼동하지 말 것.

### Projects 추가 시
1. Projects Database에 페이지 생성 (icon: `{type:"icon", icon:{name:"folder", color:"gray"}}`)
2. `sync-all-time.js`, `sync-daily-time-tracker.js`, `sync-weekly-monthly.js`의 select options에 추가
   - `sync-weekly-monthly.js`는 Weekly/Monthly 두 곳 모두 수정 필요
