const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "active");

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * 로그 파일에 기록하면서  동시에 콘솔에도 출력하는 로거를 생성합니다.
 *
 * @param {string} name - 로그 파일 이름 (예: "sync-daily" → sync-daily.log, sync-daily-error.log)
 * @returns {{ log, error, close }}
 */
function createLogger(name) {
  const logFile = path.join(LOGS_DIR, `${name}.log`);
  const errorFile = path.join(LOGS_DIR, `${name}-error.log`);

  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const errorStream = fs.createWriteStream(errorFile, { flags: "a" });

  const timestamp = () => new Date().toISOString();

  // 시작 구분선
  const separator = `\n${"─".repeat(50)}\n[${timestamp()}] 실행 시작\n`;
  logStream.write(separator);

  function log(...args) {
    const msg = args.map(String).join(" ");
    console.log(...args);
    logStream.write(`[${timestamp()}] ${msg}\n`);
  }

  function error(...args) {
    const msg = args.map(String).join(" ");
    console.error(...args);
    errorStream.write(`[${timestamp()}] ${msg}\n`);
    logStream.write(`[${timestamp()}] [ERROR] ${msg}\n`);
  }

  function close() {
    logStream.end();
    errorStream.end();
  }

  return { log, error, close };
}

module.exports = { createLogger };
