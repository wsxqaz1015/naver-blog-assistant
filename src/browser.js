// 브라우저를 여는 공통 코드.
// 로그인 정보는 작업 폴더의 .naver-profile 폴더에만 저장돼요 (사진 폴더와 분리).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(ROOT, '.naver-profile');

// 설정: config.json (blogId, photoDir, dataDir, categories, maxChars)
export const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } })();
// 초안·기록(drafts, logs) 저장 위치. 기본은 작업 폴더 안.
// (선택) C 드라이브 공간이 부족하면 config.json의 dataDir에 외장하드 등 다른 폴더를 적어요.
export const DATA_DIR = CONFIG.dataDir || ROOT;
export function dataDir(...sub) {
  const drive = path.parse(DATA_DIR).root;
  if (CONFIG.dataDir && !fs.existsSync(drive)) {
    const e = new Error(`데이터 저장 드라이브(${drive})가 연결되어 있지 않아요. 외장하드를 꽂은 뒤 다시 실행해 주세요.`);
    e.code = 'DATA_DRIVE_MISSING';
    throw e;
  }
  const p = path.join(DATA_DIR, ...sub);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export async function openBrowser({ headless = false } = {}) {
  // 설치된 크롬을 사용하고, 로그인 상태를 PROFILE_DIR에 유지해요 (persistent context).
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: headless ? { width: 1400, height: 900 } : null,
    locale: 'ko-KR',
    args: ['--start-maximized'],
  });
  return context;
}

// 네이버 로그인 쿠키가 있는지로 로그인 상태를 판단해요.
export async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.naver.com');
  return cookies.some((c) => c.name === 'NID_AUT') && cookies.some((c) => c.name === 'NID_SES');
}
