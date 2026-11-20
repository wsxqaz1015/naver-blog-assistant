// 네이버 로그인 도우미.
// 브라우저를 열어주면 사용자가 직접 로그인해요. 아이디·비밀번호는 이 프로그램이 보거나 저장하지 않아요.
import { openBrowser, isLoggedIn } from './browser.js';

const WAIT_MINUTES = 10;

const context = await openBrowser();
let finished = false;
context.on('close', () => {
  if (finished) return;
  console.log('[로그인] 브라우저 창이 닫혔어요. 로그인을 마치기 전에 닫혔다면 다시 실행해 주세요.');
  process.exit(2);
});
const page = context.pages()[0] ?? (await context.newPage());

if (await isLoggedIn(context)) {
  console.log('[로그인] 이미 로그인되어 있어요.');
} else {
  await page.goto('https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fblog.naver.com%2F');
  console.log(`[로그인] 열린 브라우저에서 네이버에 직접 로그인해 주세요. (최대 ${WAIT_MINUTES}분 기다려요)`);
  console.log('[로그인] "로그인 상태 유지"를 체크하면 다음부터 다시 로그인할 필요가 줄어들어요.');
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  while (!(await isLoggedIn(context))) {
    if (Date.now() > deadline) {
      console.log('[로그인] 시간이 지나서 종료해요. 다시 실행해 주세요.');
      await context.close();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('[로그인] 로그인 확인됐어요!');
}

// "로그인 상태 유지"를 안 하면 창을 닫는 순간 로그인이 사라져요 (세션 쿠키).
const aut = (await context.cookies('https://www.naver.com')).find((c) => c.name === 'NID_AUT');
if (!aut || aut.expires <= 0) {
  console.log('[로그인] ⚠ "로그인 상태 유지"가 꺼져 있어서 창을 닫으면 로그아웃돼요.');
  console.log('[로그인] 네이버에서 로그아웃한 뒤 "로그인 상태 유지"를 체크하고 다시 로그인해 주세요.');
  finished = true;
  await context.close();
  process.exit(3);
}
console.log('[로그인] "로그인 상태 유지" 확인됐어요. 다음부터는 로그인 없이 사용할 수 있어요.');

// 블로그 아이디 확인 (내 블로그 주소로 이동되는지)
await page.goto('https://blog.naver.com/MyBlog.naver', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
console.log('[로그인] 내 블로그 주소:', page.url());
finished = true;
await context.close();
