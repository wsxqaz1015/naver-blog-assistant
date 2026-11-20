// 네이버 스마트에디터 공통 동작 모음
import fs from 'node:fs';
import path from 'node:path';
import { installGuard, safeClick } from './guard.js';
import { openBrowser, isLoggedIn, ROOT, dataDir, CONFIG } from './browser.js';

export const BLOG_ID = CONFIG.blogId;
if (!BLOG_ID) throw new Error('config.json에 blogId(네이버 블로그 아이디)를 적어 주세요');

export const graphemes = (s) => [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
export const norm = (s) => (s ?? '').replace(/\xa0/g, ' ').replace(new RegExp('[' + String.fromCharCode(0x200b, 0xfeff) + ']', 'g'), '').replace(/\r/g, '');

// 한 글자씩 insertText (CLAUDE.md "한글 입력 방식" 참고)
// 줄 맨 앞이 "1. ", "- " 같으면 편집기가 자동 목록으로 바꿔 글자가 사라져요.
// → 앞부분(짧은 기호/번호 + 공백)을 한 번에 넣으면 변환되지 않아요 (2026-11-15 시험)
// 줄 앞부분: 공백·이모지가 아닌 1~4글자 + 공백 (예: "1. ", "- ")
const HEAD_RE = new RegExp('^[^' + String.fromCharCode(92) + 's' + String.fromCharCode(0xd800) + '-' + String.fromCharCode(0xdfff) + String.fromCharCode(0xfe0f) + ']{1,4}' + String.fromCharCode(92) + 's');
export async function typeText(page, text) {
  const head = text.match(HEAD_RE)?.[0];
  if (head) {
    await page.keyboard.insertText(head);
    text = text.slice(head.length);
  }
  for (const g of graphemes(text)) {
    await page.keyboard.insertText(g);
    await page.waitForTimeout(8);
  }
}

// ── 프로그램이 편집기를 연 시간 기록 (자동 저장 글이 프로그램 것인지 구분용) ──
const SESSIONS_FILE = path.join(dataDir('logs'), 'automation-sessions.json');
const readSessions = () => { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return []; } };
const writeSessions = (s) => { fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true }); fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s.slice(-200), null, 2), 'utf8'); };

// "15일 오후 11시 14분" → Date (이번 달 또는 지난달 기준)
function parseAutosaveTime(text) {
  const m = text.match(/(\d+)일\s*(오전|오후)\s*(\d+)시\s*(\d+)분/);
  if (!m) return null;
  let h = +m[3] % 12;
  if (m[2] === '오후') h += 12;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), +m[1], h, +m[4]);
  if (d > now) d.setMonth(d.getMonth() - 1);
  return d;
}

function isOurSession(date) {
  const t = date.getTime();
  return readSessions().some((s) => {
    const start = new Date(s.start).getTime() - 60_000;
    const end = s.end ? new Date(s.end).getTime() + 60_000 : start + 30 * 60_000;
    return t >= start && t <= end;
  });
}

// "작성 중인 글이 있습니다" 창 처리: 프로그램이 만든 자동 저장이면 취소, 아니면 멈춤
async function handleRestorePopup(page) {
  const popup = page.locator('.se-popup-alert-confirm, .se-popup-alert, [class*="se-popup"]').filter({ hasText: '작성 중인 글이 있습니다' }).filter({ visible: true }).first();
  if (!(await popup.isVisible().catch(() => false))) return null;
  const text = await popup.innerText();
  const when = parseAutosaveTime(text);
  const ours = when ? isOurSession(when) : false; // 참고용 (프로그램 실행 중 생긴 자동 저장이라도 내용은 반드시 확인)

  // 항상 "확인"으로 내용을 열어 보기만 하고, 버려도 되는 글일 때만 취소해요
  await safeClick(popup.locator('button', { hasText: '확인' }).first());
  await page.waitForTimeout(2500);
  const content = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(new RegExp('[' + String.fromCharCode(0x200b, 0xfeff, 0xa0) + ']', 'g'), ' ').trim();
    const title = clean(document.querySelector('.se-documentTitle')?.innerText);
    const comps = [...document.querySelectorAll('.se-component')].filter((el) => !el.classList.contains('se-documentTitle') && !el.parentElement.closest('.se-component'));
    const body = clean(comps.map((c) => c.innerText).join(' '));
    const media = comps.filter((c) => !c.classList.contains('se-text')).length;
    return { title, body: body.slice(0, 80), bodyLen: body.length, media };
  });
  const isEmpty = !content.title && !content.bodyLen && !content.media;
  const isTest = /^\[(테스트|기능 점검|한글 입력 테스트)\]/.test(content.title);
  // 프로그램이 입력하던 초안(drafts 폴더)과 제목이 같으면 원본이 drafts에 있으니 버려도 됨
  const isOurDraft = !!content.title && draftTitles().includes(content.title);
  if (isEmpty || isTest || isOurDraft) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.se-documentTitle', { timeout: 30000 });
    await page.waitForTimeout(2500);
    const again = page.locator('[class*="se-popup"]').filter({ hasText: '작성 중인 글이 있습니다' }).filter({ visible: true }).first();
    if (await again.isVisible().catch(() => false)) {
      await safeClick(again.locator('button', { hasText: '취소' }).first());
      await page.waitForTimeout(800);
    }
    return { 처리: isEmpty ? '내용이 빈 자동 저장이라 취소함' : isTest ? '테스트 글 자동 저장이라 취소함' : '프로그램 초안(drafts)의 자동 저장이라 취소함', 시각: when?.toLocaleString('ko-KR'), 프로그램실행중: ours, 내용: content };
  }
  // 임시저장 목록에 같은 제목이 있으면, 원본은 목록에 안전하게 있으니 자동 저장본만 백업 후 취소
  const saved = await tempListTitles(page).catch(() => []);
  if (content.title && saved.includes(content.title)) {
    const bdir = path.join(dataDir('logs'), `autosave-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
    fs.mkdirSync(bdir, { recursive: true });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(bdir, 'autosave.png'), fullPage: true }).catch(() => {});
    const html = await page.evaluate(() => document.querySelector('.se-content, .se-main-container, #SE-root, body')?.innerHTML || '');
    const textAll = await page.evaluate(() => [...document.querySelectorAll('.se-component')].map((c) => c.innerText).join('\n'));
    fs.writeFileSync(path.join(bdir, 'autosave.html'), html, 'utf8');
    fs.writeFileSync(path.join(bdir, 'autosave.txt'), `시각: ${when?.toLocaleString('ko-KR')}\n제목: ${content.title}\n\n${textAll}`, 'utf8');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.se-documentTitle', { timeout: 30000 });
    await page.waitForTimeout(2500);
    const again = page.locator('[class*="se-popup"]').filter({ hasText: '작성 중인 글이 있습니다' }).filter({ visible: true }).first();
    if (await again.isVisible().catch(() => false)) {
      await safeClick(again.locator('button', { hasText: '취소' }).first());
      await page.waitForTimeout(800);
    }
    return { 처리: '임시저장 목록에 같은 제목이 있는 글의 자동 저장본이라 백업 후 취소함', 시각: when?.toLocaleString('ko-KR'), 제목: content.title, 백업: bdir };
  }

  const err = new Error(`UNKNOWN_AUTOSAVE: 사용자가 쓰던 글일 수 있는 자동 저장이 있어요 (${when ? when.toLocaleString('ko-KR') : ''}, 제목 "${content.title || '(없음)'}", 본문 "${content.body}")`);
  err.code = 'UNKNOWN_AUTOSAVE';
  err.content = content;
  throw err;
}

// drafts 폴더에 있는 초안 제목들
function draftTitles() {
  const root = dataDir('drafts');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((d) => {
    try {
      const m = fs.readFileSync(path.join(root, d, 'draft.md'), 'utf8').match(/^\s*제목\s*:\s*(.+)$/m);
      return m ? m[1].trim() : null;
    } catch { return null; }
  }).filter(Boolean);
}

// 임시저장 목록의 글 제목들 (목록을 열어 읽고 닫아요. 글을 열거나 지우지 않음)
export async function tempListTitles(page) {
  await safeClick(page.locator('button[class^="save_count_btn__"]').first());
  await page.waitForTimeout(1500);
  const titles = await page.locator('li[class^="item__"] button[class^="article_button__"] strong').allInnerTexts();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const stillOpen = page.locator('li[class^="item__"]').filter({ visible: true });
  if (await stillOpen.count()) await safeClick(page.locator('button[class^="save_count_btn__"]').first());
  return titles.map((t) => t.trim());
}

export async function openEditor({ headless = true } = {}) {
  const context = await openBrowser({ headless });
  await installGuard(context);
  const page = context.pages()[0] ?? (await context.newPage());
  // "페이지를 나가시겠습니까?"(beforeunload)는 수락해야 새로고침이 돼요. 그 밖의 창은 닫기(취소)
  page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
  if (!(await isLoggedIn(context))) {
    await context.close();
    throw new Error('LOGIN_REQUIRED');
  }
  const sessions = readSessions();
  const session = { start: new Date().toISOString(), script: path.basename(process.argv[1] || '') };
  sessions.push(session);
  writeSessions(sessions);
  context.on('close', () => {
    const all = readSessions();
    const mine = all.find((s) => s.start === session.start);
    if (mine) { mine.end = new Date().toISOString(); writeSessions(all); }
  });

  await page.goto(`https://blog.naver.com/${BLOG_ID}/postwrite`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.se-documentTitle', { timeout: 30000 });
  await page.waitForTimeout(2500);
  let restore = null;
  try {
    restore = await handleRestorePopup(page);
  } catch (e) {
    await context.close();
    throw e;
  }
  const help = page.locator('.se-help-panel-close-button');
  if (await help.isVisible().catch(() => false)) await safeClick(help);
  return { context, page, restore };
}

export async function saveCount(page) {
  return (await page.locator('[class^="save_count_btn"]').first().innerText().catch(() => '?')).trim();
}

// 편집기 본문의 최상위 구성요소 목록 (종류 + 글자)
export async function components(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.se-component')]
      .filter((el) => !el.parentElement.closest('.se-component'))
      .map((el) => {
        const type = [...el.classList].find((c) => c.startsWith('se-') && c !== 'se-component' && !c.startsWith('se-l-') && !c.startsWith('se-component-')) || '?';
        const imgs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || '');
        return { type, text: (el.innerText || '').replace(new RegExp(String.fromCharCode(0x200b), 'g'), '').trim().slice(0, 80), imgs: imgs.length, imgSrc: imgs.slice(0, 2).map((s) => s.slice(0, 70)) };
      })
      .filter((c) => c.type !== 'se-documentTitle'),
  );
}

// 화면에 보이는 버튼·입력칸 목록 (새로 생긴 창을 찾을 때 비교용)
export async function visibleControls(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    return [...document.querySelectorAll('button, input, textarea, [role=button], [contenteditable=true], a[class*=btn], label')]
      .filter(vis)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        cls: String(el.className || '').slice(0, 90),
        ph: el.getAttribute('placeholder') || '',
        aria: el.getAttribute('aria-label') || '',
        dataName: el.getAttribute('data-name') || '',
      }));
  });
}

export function diffControls(before, after) {
  const key = (c) => `${c.tag}|${c.cls}|${c.text}|${c.ph}`;
  const old = new Set(before.map(key));
  return after.filter((c) => !old.has(key(c)));
}
