// 승인된 초안을 네이버 블로그 편집기에 입력하고 임시저장·검증해요. 발행은 절대 하지 않아요.
// 사용: node src/post.js <초안폴더> [--dry-run] [--headless] [--no-wait]
//   --dry-run : 모두 입력하고 저장 직전에 멈춤 (저장 안 함). 승인 전 초안도 가능
//   --headless: 브라우저 창을 띄우지 않음 (점검용)
//   --no-wait : 테스트 모드에서 창을 바로 닫음
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dataDir } from './browser.js';
import { readDraft, checkDraft, approvalStatus, DEFAULT_PHOTO_DIR } from './draft.js';
import { openEditor, typeText, components, saveCount, norm } from './editor.js';
import { safeClick, allowPublishPanelOpenOnce, blockedClicks } from './guard.js';
import { moveUsed } from './photos.js';

const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '');
const DRY = args.includes('--dry-run');
const HEADLESS = args.includes('--headless');
const NO_WAIT = args.includes('--no-wait') || HEADLESS;
const VERIFY_ONLY = args.includes('--verify-only'); // 이미 임시저장된 글을 다시 열어 검증만

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logDir = path.join(dataDir('logs'), `post-${stamp}${DRY ? '-dryrun' : ''}`);
fs.mkdirSync(logDir, { recursive: true });
const logLines = [];
const log = (...m) => { const s = m.join(' '); logLines.push(`[${new Date().toLocaleTimeString('ko-KR')}] ${s}`); console.log(s); };
let shotNo = 0;
// 편집기는 안쪽 영역이 스크롤돼서 전체 화면 캡처가 안 돼요 → 위에서부터 내려가며 여러 장 저장
const shot = async (page, name, { scroll = false } = {}) => {
  const base = `${String(++shotNo).padStart(2, '0')}-${name}`;
  if (!scroll) { await page.screenshot({ path: path.join(logDir, `${base}.png`) }).catch(() => {}); return; }
  await page.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll('div')].filter((e) => e && e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) || e === document.scrollingElement);
    window.__btScroller = els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    window.__btScroller.scrollTop = 0;
  });
  for (let i = 1; i <= 20; i++) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(logDir, `${base}-${String(i).padStart(2, '0')}.png`) }).catch(() => {});
    const done = await page.evaluate(() => { const s = window.__btScroller; const before = s.scrollTop; s.scrollTop += s.clientHeight - 120; return s.scrollTop === before; });
    if (done) break;
  }
};

// 결과표 (검증된 것만 성공)
const R = {
  제목: { 상태: '실패', 메모: '' },
  '본문 및 서식': { 상태: '실패', 메모: '' },
  사진: { 상태: '해당 없음', 메모: '' },
  영상: { 상태: '해당 없음', 메모: '' },
  태그: { 상태: '실패', 메모: '' },
  '장소 및 지도': { 상태: '해당 없음', 메모: '' },
  카테고리: { 상태: '실패', 메모: '' },
  임시저장: { 상태: DRY ? '테스트 모드(저장 안 함)' : '실패', 메모: '' },
  '최종 검증': { 상태: DRY ? '테스트 모드(저장 안 함)' : '실패', 메모: '' },
};

function finish(code) {
  const lines = ['| 확인 항목 | 처리 결과 | 메모 |', '|---|---|---|', ...Object.entries(R).map(([k, v]) => `| ${k} | ${v.상태} | ${v.메모.replace(/\n/g, ' ')} |`)];
  fs.writeFileSync(path.join(logDir, 'result.md'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(logDir, 'result.json'), JSON.stringify(R, null, 2), 'utf8');
  fs.writeFileSync(path.join(logDir, 'log.txt'), logLines.join('\n'), 'utf8');
  console.log('\n' + lines.join('\n'));
  console.log(`\n[기록] ${logDir}`);
  process.exit(code);
}

// ── 1. 초안 확인 ──
let draft;
try { draft = readDraft(dir); } catch (e) { log('❌ 초안을 읽을 수 없어요:', e.message); finish(1); }
const check = checkDraft(draft);
log(`초안: ${draft.title} (${check.chars}자, 소제목 ${check.quotes}개, 태그 ${draft.tags.length}개)`);
check.warnings.forEach((w) => log('⚠', w));
if (check.problems.length) { check.problems.forEach((p) => log('❌', p)); log('초안 기준에 맞지 않아 중단해요.'); finish(1); }
if (!DRY) {
  const a = approvalStatus(draft);
  if (!a.ok) { log('❌', a.reason, '→ 저장하지 않아요.'); finish(1); }
  log(`✅ 승인 확인 (${new Date(a.approvedAt).toLocaleString('ko-KR')})`);
}
const expectPhotos = draft.blocks.filter((b) => b.type === 'photos').flatMap((b) => b.files);
const expectVideos = draft.blocks.filter((b) => b.type === 'video');
const hasPlace = draft.blocks.some((b) => b.type === 'place');

// ── 2. 편집기 열기 ──
let context, page;
try {
  ({ context, page } = await openEditor({ headless: HEADLESS }));
} catch (e) {
  if (e.message === 'LOGIN_REQUIRED') log('❌ 네이버 로그인이 풀렸어요. "npm run login"으로 다시 로그인해 주세요.');
  else if (e.code === 'UNKNOWN_AUTOSAVE') log('❌', e.message, '\n   네이버 편집기에서 직접 확인한 뒤 다시 실행해 주세요. (프로그램은 이 글을 지우지 않았어요)');
  else log('❌ 편집기를 열지 못했어요:', e.message);
  finish(1);
}
const countBefore = await saveCount(page);
log(`편집기 열림. 현재 임시저장 글 ${countBefore}개`);

// ── 편집 도우미 ──
const lastComp = async () => (await components(page)).at(-1);
async function focusEnd({ newParagraph = true } = {}) {
  const last = await lastComp();
  if (!last || last.type !== 'se-text') {
    const add = page.locator('.se-canvas-bottom-button').first();
    if (!(await add.count())) throw new Error('본문 추가 버튼을 찾지 못했어요 (편집기 화면이 바뀌었을 수 있어요)');
    await safeClick(add);
    await page.waitForTimeout(400);
  }
  const p = page.locator('.se-component.se-text .se-text-paragraph').last();
  // 문단 가운데를 클릭 + End 키는 "화면에 보이는 첫 줄"의 끝으로 가서, 두 줄로 줄바꿈된 긴 문단에서는
  // 중간에 커서가 멈춰 문장이 쪼개졌음. Ctrl+End도 효과 없음 (2026-11-16)
  // → 문단 마지막 글자 바로 뒤 좌표를 계산해서 그 자리를 클릭한 뒤 End
  const pos = await p.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) if (walker.currentNode.textContent.replace(new RegExp('[' + String.fromCharCode(0x200b, 0xfeff) + ']', 'g'), '').length) last = walker.currentNode;
    if (!last) { const r = el.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; }
    const range = document.createRange();
    range.setStart(last, last.textContent.length);
    range.collapse(true);
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] || range.getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  });
  await page.mouse.click(pos.x + 2, pos.y);
  await page.keyboard.press('End');
  const txt = norm(await p.innerText()).trim();
  if (newParagraph && txt) {
    await pressEnterChecked();
  }
}

// 편집기는 입력을 늦게 반영해요. 친 글자가 실제로 다 들어갈 때까지 기다린 뒤 다음 동작을 해야
// 문장이 쪼개지지 않아요 (2026-11-16 첫 글에서 "소|개해드릴게요"가 소제목 앞뒤로 갈라짐)
async function waitCommitted(expected, { where = 'text' } = {}) {
  const want = norm(expected).replace(/\s+$/, '');
  const deadline = Date.now() + 20_000;
  let got = '';
  while (Date.now() < deadline) {
    got = await page.evaluate((w) => {
      const clean = (s) => (s || '').replace(/\xa0/g, ' ').replace(new RegExp('[' + String.fromCharCode(0x200b, 0xfeff) + ']', 'g'), '').replace(/\r/g, '').replace(/\n$/, '').replace(/\s+$/, '');
      if (w === 'quote') {
        const qs = [...document.querySelectorAll('.se-component.se-quotation')];
        const q = qs.at(-1);
        return clean((q?.querySelector('.se-quote') || q?.querySelector('.se-text-paragraph'))?.innerText);
      }
      return clean([...document.querySelectorAll('.se-component.se-text .se-text-paragraph')].at(-1)?.innerText);
    }, where);
    if (got === want) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`입력한 글이 편집기에 그대로 들어가지 않았어요 (원본 "${want.slice(0, 30)}" / 편집기 "${got.slice(0, 30)}")`);
}

// 본문 정렬: 사용자 기본은 가운데 (기존 글도 90% 이상 가운데, 2026-11-16 요청). 한 번 맞추면 다음 문단도 이어짐
// 소제목·사진·지도 뒤에 새로 생긴 본문은 왼쪽으로 돌아갈 수 있어서 본문 블록마다 확인
async function ensureAlign() {
  const want = draft.align;
  const cls = (await page.locator('.se-component.se-text .se-text-paragraph').last().getAttribute('class')) || '';
  if (cls.includes(`se-text-paragraph-align-${want}`) || (want === 'left' && !/align-(center|right|justify)/.test(cls))) return;
  await safeClick(page.locator('button[data-name="align-drop-down-with-justify"].se-property-toolbar-drop-down-button').first());
  await page.waitForTimeout(300);
  const opt = page.locator(`button[data-name="align-drop-down-with-justify"][data-value="${want}"]`).filter({ visible: true }).first();
  if (!(await opt.count())) throw new Error(`정렬(${want}) 버튼을 찾지 못했어요`);
  await safeClick(opt);
  await page.waitForTimeout(300);
}

// Enter 후 문단 수가 실제로 1 늘었는지 확인. 안 늘었으면 한 번 더 (2026-11-16 빈 줄 하나가 빠졌던 문제)
async function pressEnterChecked() {
  const paras = () => page.locator('.se-component.se-text .se-text-paragraph').count();
  const before = await paras();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const n = await paras();
      if (n === before + 1) { await waitCommitted(''); return; }
      if (n > before + 1) throw new Error('Enter가 두 번 들어갔어요 (빈 줄이 하나 더 생김)');
      await page.waitForTimeout(150);
    }
  }
  throw new Error('Enter를 눌렀는데 새 문단이 생기지 않았어요');
}

async function addText(lines) {
  await focusEnd();
  await ensureAlign();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      await typeText(page, lines[i]);
      await waitCommitted(lines[i]);
    }
    if (i < lines.length - 1) {
      await pressEnterChecked(); // 새 문단이 실제로 하나 생겼는지 확인 (빈 줄 누락 방지)
    }
  }
  await page.waitForTimeout(300);
}

async function addQuote(text) {
  await focusEnd({ newParagraph: true });
  await safeClick(page.locator('button[data-name="quotation"].se-document-toolbar-select-option-button').first());
  await page.waitForTimeout(400);
  const opt = page.locator('button[data-value="quotation_line"]').filter({ visible: true }).first();
  if (!(await opt.count())) throw new Error('세로줄 인용구 버튼을 찾지 못했어요');
  await safeClick(opt);
  await page.waitForTimeout(600);
  await typeText(page, text);
  await waitCommitted(text, { where: 'quote' });
  await page.waitForTimeout(300);
}

async function addHr() {
  await focusEnd({ newParagraph: false });
  await safeClick(page.locator('button[data-name="horizontal-line"].se-document-toolbar-select-option-button').first());
  await page.waitForTimeout(400);
  const opt = page.locator('button[data-value="line5"]').filter({ visible: true }).first();
  if (!(await opt.count())) throw new Error('구분선(line5) 버튼을 찾지 못했어요');
  await safeClick(opt);
  await page.waitForTimeout(500);
}

// 편집기는 화면에서 멀어진 사진을 다시 임시 그림(data:svg)으로 바꿔요 (사진이 많을 때).
// 그래서 문서 전체의 src로 세면 숫자가 오락가락함 → 사진마다 화면에 보일 때 실제 주소(pstatic)를 확인하고
// data-bt-ok 표시를 붙여 둠. 한 번 확인된 사진은 다시 임시 그림이 되어도 업로드 완료로 셈 (2026-11-16)
const markLoaded = () => page.evaluate(() => {
  for (const i of document.querySelectorAll('.se-component.se-image img')) {
    if (/^https:\/\/[^/]*pstatic\.net\//.test(i.getAttribute('src') || '')) i.setAttribute('data-bt-ok', '1');
  }
});
const imgCount = () => page.locator('.se-component.se-image img').count();
const okCount = async (from = 0) => {
  await markLoaded();
  return page.evaluate((f) => [...document.querySelectorAll('.se-component.se-image img')].slice(f).filter((i) => i.getAttribute('data-bt-ok') === '1').length, from);
};

async function addPhotos(files) {
  await focusEnd({ newParagraph: false });
  const before = await imgCount();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), safeClick(page.locator('button[data-name="image"]').first())]);
  await chooser.setFiles(files);
  if (files.length > 1) {
    const label = page.locator('label.se-image-type-label', { hasText: '개별사진' });
    await label.waitFor({ timeout: 15000 });
    await safeClick(label);
  }
  const deadline = Date.now() + 120_000 + files.length * 60_000; // 큰 사진은 업로드가 오래 걸림
  // 새로 넣은 사진들(before 이후)을 하나씩 화면에 보이게 하며 실제 주소가 들어오는지 확인
  while ((await imgCount()) < before + files.length || (await okCount(before)) < files.length) {
    if (Date.now() > deadline) throw new Error(`사진 업로드가 끝나지 않았어요 (${await okCount(before)}/${files.length}장)`);
    const imgs = page.locator('.se-component.se-image img');
    const n = await imgs.count();
    for (let i = before; i < n; i++) {
      await imgs.nth(i).scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);
      await markLoaded();
    }
    await page.waitForTimeout(1000);
  }
}

async function addVideo(file, title) {
  await focusEnd({ newParagraph: false });
  const before = await page.locator('.se-component.se-video').count();
  await safeClick(page.locator('button[data-name="video"]').first());
  await page.locator('.nvu_btn_append.nvu_local').waitFor({ timeout: 15000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), safeClick(page.locator('.nvu_btn_append.nvu_local'))]);
  await chooser.setFiles([file]);
  const deadline = Date.now() + 10 * 60_000;
  while (!(await page.locator('.nvu_btn_select', { hasText: '업로드 완료' }).count())) {
    if (Date.now() > deadline) throw new Error('영상 업로드가 10분 안에 끝나지 않았어요');
    await page.waitForTimeout(2000);
  }
  await page.locator('input.nvu_inp').filter({ visible: true }).first().fill(title);
  await safeClick(page.locator('button.nvu_btn_submit').filter({ visible: true }).first());
  const d2 = Date.now() + 60_000;
  while ((await page.locator('.se-component.se-video').count()) <= before) {
    if (Date.now() > d2) throw new Error('영상이 본문에 들어가지 않았어요');
    await page.waitForTimeout(1000);
  }
}

let placeChosen = null;
async function addPlace(query) {
  await focusEnd({ newParagraph: false });
  await safeClick(page.locator('button[data-name="map"]').first());
  const input = page.locator('input[placeholder="장소명을 입력하세요."]').first();
  await input.waitFor({ timeout: 15000 });
  await input.click();
  await typeText(page, query);
  await safeClick(page.locator('.se-place-search-button').first());
  const items = page.locator('li.se-place-map-search-result-item');
  await items.first().waitFor({ timeout: 15000 }).catch(() => {});
  const n = await items.count();
  if (!n) throw new Error(`장소 검색 결과가 없어요: "${query}"`);
  const titles = await page.locator('li.se-place-map-search-result-item .se-place-map-search-result-title').allInnerTexts();
  const q = query.replace(/\s+/g, '');
  let idx = titles.findIndex((t) => t.replace(/\s+/g, '') === q);
  if (idx < 0) idx = titles.findIndex((t) => t.replace(/\s+/g, '').includes(q) || q.includes(t.replace(/\s+/g, '')));
  if (idx < 0) idx = 0;
  placeChosen = { name: titles[idx], exact: titles[idx].replace(/\s+/g, '') === q, candidates: titles.slice(0, 5) };
  await items.nth(idx).hover();
  await safeClick(items.nth(idx).locator('button.se-place-add-button'));
  await page.waitForTimeout(600);
  await safeClick(page.locator('.se-popup-button-confirm').filter({ visible: true }).first());
  await page.waitForTimeout(1500);
}

async function openPanel() {
  const panel = page.locator('[class^="layer_popup__"]').filter({ visible: true }).first();
  if (await panel.count()) return panel;
  await allowPublishPanelOpenOnce(page);
  await safeClick(page.locator('button[class^="publish_btn__"]').first(), { allowTopPublish: true });
  await panel.waitFor({ timeout: 10000 });
  return panel;
}
async function closePanel() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}
async function readPanel() {
  const panel = await openPanel();
  const category = (await panel.locator('button[class^="selectbox_button__"]').first().innerText()).trim();
  const text = await panel.innerText();
  const tagPart = text.split('태그 편집')[1]?.split('발행 시간')[0] || '';
  const tags = tagPart.split('#').map((t) => t.trim()).filter(Boolean);
  await closePanel();
  return { category, tags };
}

async function setTagsAndCategory() {
  const panel = await openPanel();
  // 카테고리
  const sel = panel.locator('button[class^="selectbox_button__"]').first();
  if ((await sel.innerText()).trim() !== draft.category) {
    await safeClick(sel);
    await page.waitForTimeout(500);
    const opt = panel.locator('li, [role=option]').filter({ hasText: new RegExp(`^\\s*${draft.category.replace(/[[\]]/g, '\\$&')}\\s*$`) }).filter({ visible: true }).first();
    if (!(await opt.count())) throw new Error(`카테고리 "${draft.category}"를 목록에서 찾지 못했어요`);
    await safeClick(opt.locator('label, button, a, span').first().or(opt).first());
    await page.waitForTimeout(500);
  }
  // 태그 (이미 들어있는 태그는 건너뜀)
  const existing = new Set((await panel.innerText()).split('태그 편집')[1]?.split('발행 시간')[0]?.split('#').map((t) => t.trim()).filter(Boolean) || []);
  await panel.locator('#tag-input').click();
  for (const t of draft.tags) {
    if (existing.has(t)) continue;
    await typeText(page, t);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }
  await closePanel();
}

// ── 편집기 내용 읽기 (문서 순서대로) ──
async function readEditor() {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\xa0/g, ' ').replace(new RegExp('[' + String.fromCharCode(0x200b, 0xfeff) + ']', 'g'), '').replace(/\r/g, '');
    const title = clean(document.querySelector('.se-documentTitle')?.innerText || '').trim();
    const items = [];
    const comps = [...document.querySelectorAll('.se-component')].filter((el) => !el.parentElement.closest('.se-component') && !el.classList.contains('se-documentTitle'));
    for (const el of comps) {
      const c = el.classList;
      if (c.contains('se-text')) {
        for (const p of el.querySelectorAll('.se-text-paragraph')) items.push({ type: 'text', text: clean(p.innerText).replace(/\n$/, '').replace(/\s+$/, ''), align: (p.className.match(/se-text-paragraph-align-(\w+)/) || [])[1] || 'left' });
      } else if (c.contains('se-quotation')) {
        const q = el.querySelector('.se-quote') || el.querySelector('.se-text-paragraph');
        items.push({ type: 'quote', text: clean(q?.innerText || '').trim(), layout: [...c].find((x) => x.startsWith('se-l-')) });
      } else if (c.contains('se-image')) {
        for (const img of el.querySelectorAll('img')) items.push({ type: 'image', uploaded: img.getAttribute('data-bt-ok') === '1' || /^https:\/\/[^/]*pstatic\.net\//.test(img.getAttribute('src') || '') });
      } else if (c.contains('se-video')) {
        items.push({ type: 'video' });
      } else if (c.contains('se-horizontalLine')) {
        items.push({ type: 'hr', layout: [...c].find((x) => x.startsWith('se-l-')) });
      } else if (c.contains('se-placesMap')) {
        items.push({ type: 'place', text: clean(el.innerText).trim().split('\n')[0] });
      } else {
        items.push({ type: 'other', cls: el.className.slice(0, 60), text: clean(el.innerText).slice(0, 60) });
      }
    }
    return { title, items };
  });
}

function expectedItems() {
  const out = [];
  for (const b of draft.blocks) {
    if (b.type === 'text') b.lines.forEach((l) => out.push({ type: 'text', text: norm(l).replace(/\s+$/, '') }));
    if (b.type === 'quote') out.push({ type: 'quote', text: b.text });
    if (b.type === 'photos') b.files.forEach(() => out.push({ type: 'image' }));
    if (b.type === 'video') out.push({ type: 'video' });
    if (b.type === 'hr') out.push({ type: 'hr' });
    if (b.type === 'place') out.push({ type: 'place' });
  }
  return out;
}

// 원본과 비교해 결과표 채우기
// 화면 밖 사진은 늦게 불러와요(임시 그림) → 사진마다 화면에 보이게 해서 실제 주소가 들어올 때까지 기다림
async function loadLazyImages() {
  const n = await page.locator('.se-component.se-image img').count();
  for (let i = 0; i < n; i++) {
    const img = page.locator('.se-component.se-image img').nth(i);
    await img.scrollIntoViewIfNeeded().catch(() => {});
    for (let t = 0; t < 20; t++) {
      const src = (await img.getAttribute('src').catch(() => '')) || '';
      if (!src.startsWith('data:')) break;
      await page.waitForTimeout(250);
    }
    await markLoaded(); // 다음 사진으로 넘어가면 이 사진이 다시 임시 그림이 될 수 있어 표시를 남김
  }
}

async function verify(stage) {
  await loadLazyImages();
  const got = await readEditor();
  const want = expectedItems();
  const res = { ok: true, details: {} };

  // 제목
  const titleOk = got.title === draft.title;
  res.details.제목 = titleOk ? '' : `입력됨: "${got.title}"`;

  // 본문 (빈 문단 제외하고 순서·내용 비교)
  const ne = (arr) => arr.filter((x) => !(x.type === 'text' && !x.text));
  const g = ne(got.items);
  const w = ne(want);
  const diffs = [];
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    const a = w[i];
    const b = g[i];
    if (!a || !b || a.type !== b.type || ((a.type === 'text' || a.type === 'quote') && a.text !== b.text)) {
      diffs.push(`${i + 1}번째: 원본 ${a ? `${a.type} "${(a.text || '').slice(0, 30)}"` : '(없음)'} / 편집기 ${b ? `${b.type} "${(b.text || '').slice(0, 30)}"` : '(없음)'}`);
      if (diffs.length >= 3) break;
    }
  }
  const emptyWant = want.filter((x) => x.type === 'text' && !x.text).length;
  const emptyGot = got.items.filter((x) => x.type === 'text' && !x.text).length;
  if (emptyGot < emptyWant) diffs.push(`빈 줄이 부족해요 (원본 ${emptyWant}개 / 편집기 ${emptyGot}개)`);
  const badAlign = got.items.filter((x) => x.type === 'text' && x.text && x.align !== draft.align).length;
  if (badAlign) diffs.push(`정렬이 "${draft.align}"가 아닌 문단 ${badAlign}개`);
  const badQuote = got.items.filter((x) => x.type === 'quote' && x.layout !== 'se-l-quotation_line').length;
  if (badQuote) diffs.push(`세로줄이 아닌 인용구 ${badQuote}개`);
  const others = got.items.filter((x) => x.type === 'other');
  if (others.length) diffs.push(`예상하지 못한 요소 ${others.length}개 (${others[0].cls})`);
  res.details.본문 = diffs.join(' / ');

  // 사진
  const imgs = got.items.filter((x) => x.type === 'image');
  res.details.사진 = imgs.length === expectPhotos.length && imgs.every((x) => x.uploaded) ? '' : `원본 ${expectPhotos.length}장 / 편집기 ${imgs.length}장 (업로드 완료 ${imgs.filter((x) => x.uploaded).length}장)`;
  // 영상
  const vids = got.items.filter((x) => x.type === 'video').length;
  res.details.영상 = vids === expectVideos.length ? '' : `원본 ${expectVideos.length}개 / 편집기 ${vids}개`;
  // 장소
  const places = got.items.filter((x) => x.type === 'place');
  res.details.장소 = !hasPlace ? (places.length ? `원하지 않은 장소 ${places.length}개` : '') : places.length === 1 && (!placeChosen || places[0].text === placeChosen.name) ? '' : `장소 ${places.length}개 (${places.map((p) => p.text).join(', ')})`;
  // 태그·카테고리
  const panel = await readPanel();
  const missing = draft.tags.filter((t) => !panel.tags.includes(t));
  const extra = panel.tags.filter((t) => !draft.tags.includes(t));
  res.details.태그 = !missing.length && !extra.length ? '' : `빠진 태그 ${missing.length}개${missing.length ? ` (${missing.slice(0, 3).join(', ')}…)` : ''}, 추가된 태그 ${extra.length}개`;
  res.details.카테고리 = panel.category === draft.category ? '' : `편집기: "${panel.category}" / 원본: "${draft.category}"`;

  for (const [k, v] of Object.entries(res.details)) if (v) res.ok = false;
  fs.writeFileSync(path.join(logDir, `verify-${stage}.json`), JSON.stringify({ got, want, panel, placeChosen, res }, null, 2), 'utf8');
  return res;
}

function applyVerify(v, stageLabel) {
  const set = (key, detailKey, applicable = true) => {
    if (!applicable) { R[key] = { 상태: '해당 없음', 메모: '' }; return; }
    const d = v.details[detailKey];
    R[key] = { 상태: d ? '실패' : '성공', 메모: d ? `[${stageLabel}] ${d}` : '' };
  };
  set('제목', '제목');
  set('본문 및 서식', '본문');
  set('사진', '사진', expectPhotos.length > 0);
  set('영상', '영상', expectVideos.length > 0);
  set('태그', '태그');
  set('장소 및 지도', '장소', hasPlace);
  set('카테고리', '카테고리');
  if (hasPlace && placeChosen && !placeChosen.exact && R['장소 및 지도'].상태 === '성공') R['장소 및 지도'].메모 = `검색어와 정확히 같은 이름이 없어 "${placeChosen.name}"을 골랐어요. 맞는지 확인해 주세요`;
}

let savedUrl = '';
if (VERIFY_ONLY) {
  log('검증만 하기: 입력·저장 없이 임시저장된 글을 다시 열어 원본과 비교해요');
  try { placeChosen = JSON.parse(fs.readFileSync(path.join(draft.dir, 'saved.json'), 'utf8')).placeChosen || null; } catch {}
} else {
// ── 3. 입력 ──
try {
  log('제목 입력');
  await page.locator('.se-documentTitle .se-text-paragraph').first().click();
  await typeText(page, draft.title);
  for (const [i, b] of draft.blocks.entries()) {
    log(`본문 ${i + 1}/${draft.blocks.length}: ${b.type}${b.type === 'photos' ? ` ${b.files.length}장` : ''}`);
    if (b.type === 'text') await addText(b.lines);
    if (b.type === 'quote') await addQuote(b.text);
    if (b.type === 'hr') await addHr();
    if (b.type === 'photos') await addPhotos(b.files);
    if (b.type === 'video') await addVideo(b.file, b.title);
    if (b.type === 'place') await addPlace(draft.place);
  }
  log('태그·카테고리 입력');
  await setTagsAndCategory();
} catch (e) {
  log('❌ 입력 중 문제:', e.message);
  await shot(page, '입력-오류');
  const blocked = await blockedClicks(page);
  if (blocked.length) log('안전장치가 막은 클릭:', JSON.stringify(blocked));
  try { applyVerify(await verify('입력오류'), '입력 중'); } catch {}
  R.임시저장 = { 상태: DRY ? '테스트 모드(저장 안 함)' : '실패', 메모: '입력 중 오류로 저장하지 않았어요' };
  if (!NO_WAIT) { log('브라우저 창에서 화면을 확인한 뒤 창을 닫아 주세요.'); await page.waitForEvent('close', { timeout: 0 }).catch(() => {}); }
  await context.close().catch(() => {});
  finish(1);
}

// ── 4. 저장 전 검증 ──
log('저장 전 검증: 편집기에 들어간 내용을 다시 읽어 원본과 비교');
const v1 = await verify('저장전');
applyVerify(v1, '저장 전');
await page.evaluate(() => window.scrollTo(0, 0));
await shot(page, '저장전-화면', { scroll: true });
const blocked = await blockedClicks(page);
if (blocked.length) log('안전장치가 막은 클릭:', JSON.stringify(blocked));

if (DRY) {
  log(v1.ok ? '✅ 테스트 모드: 모든 항목이 원본과 일치해요. 저장 버튼은 누르지 않았어요.' : '⚠ 테스트 모드: 원본과 다른 부분이 있어요 (아래 표 참고). 저장 버튼은 누르지 않았어요.');
  if (!NO_WAIT) {
    log('👉 브라우저 창에서 글을 직접 확인해 보세요. 확인이 끝나면 창을 닫아 주세요. (저장·발행 버튼은 누르지 마세요)');
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  }
  await context.close().catch(() => {});
  finish(v1.ok ? 0 : 2);
}

if (!v1.ok) {
  log('❌ 저장 전 검증에서 원본과 다른 부분이 있어 저장하지 않아요.');
  R.임시저장 = { 상태: '실패', 메모: '저장 전 검증 실패로 저장하지 않음' };
  await context.close().catch(() => {});
  finish(1);
}

// ── 5. 임시저장 ──
log('임시저장 버튼 클릭');
await safeClick(page.locator('button[class^="save_btn__"]').first());
let countAfter = countBefore;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  countAfter = await saveCount(page);
  if (Number(countAfter) > Number(countBefore)) break;
}
await shot(page, '저장후-화면');
if (!(Number(countAfter) > Number(countBefore))) {
  R.임시저장 = { 상태: '실패', 메모: `임시저장 개수가 늘지 않았어요 (${countBefore} → ${countAfter})` };
  await context.close().catch(() => {});
  finish(1);
}
R.임시저장 = { 상태: '성공', 메모: `임시저장 글 ${countBefore} → ${countAfter}개` };
log(`✅ 임시저장 개수 ${countBefore} → ${countAfter}`);
savedUrl = page.url();
} // VERIFY_ONLY가 아닐 때 끝

// ── 6. 저장된 글 다시 열어서 검증 ──
log('저장된 글을 임시저장 목록에서 다시 여는 중');
let reopened = false;
try {
  await context.close();
  ({ context, page } = await openEditor({ headless: HEADLESS }));
  await safeClick(page.locator('button[class^="save_count_btn__"]').first());
  await page.waitForTimeout(1500);
  await shot(page, '임시저장-목록');
  // 같은 제목이 여러 개면 알림 (사진이 많아 작업이 길면 네이버가 중간에 자동 임시저장해서 하나 더 생김, 2026-11-16)
  const same = (await page.locator('li[class^="item__"]').allInnerTexts())
    .map((t) => t.split('\n').map((x) => x.trim()).filter(Boolean))
    .filter((p) => p[0] === draft.title)
    .map((p) => p[1] || '');
  if (same.length > 1) {
    R.임시저장.메모 += ` / ⚠ 같은 제목 ${same.length}개 (${same.join(', ')}). 맨 위 ${same[0]}가 검증한 최신본이고 나머지는 작업 중 자동 저장된 것으로 보여요 → 지워주세요`;
    log(`⚠ 임시저장 목록에 같은 제목이 ${same.length}개: ${same.join(', ')}`);
  }
  const item = page.getByText(draft.title, { exact: true }).filter({ visible: true }).first();
  if (!(await item.count())) throw new Error('임시저장 목록에서 이 글 제목을 찾지 못했어요');
  await safeClick(item);
  await page.waitForTimeout(1500);
  // "불러오시겠습니까" 같은 확인 창이 뜨면 확인
  const confirm = page.locator('.se-popup-alert-confirm button, [class*="popup"] button').filter({ hasText: /^확인$/ }).filter({ visible: true }).first();
  if (await confirm.count()) { await safeClick(confirm); await page.waitForTimeout(1500); }
  await page.waitForFunction((t) => document.querySelector('.se-documentTitle')?.innerText.trim() === t, draft.title, { timeout: 30000 });
  await page.waitForTimeout(3000);
  reopened = true;
  if (VERIFY_ONLY) R.임시저장 = { 상태: '성공', 메모: '임시저장 목록에서 이 글을 찾아 열었어요' };
} catch (e) {
  log('❌ 저장된 글을 다시 열지 못했어요:', e.message);
  await shot(page, '다시열기-오류');
  R['최종 검증'] = { 상태: '실패', 메모: `저장된 글을 다시 열지 못함: ${e.message}` };
}

if (reopened) {
  const v2 = await verify('저장후');
  applyVerify(v2, '저장 후');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '다시연-글', { scroll: true });
  R['최종 검증'] = { 상태: v2.ok ? '성공' : '실패', 메모: v2.ok ? `저장된 글을 다시 열어 원본과 일치 확인 (${savedUrl})` : '다시 연 글이 원본과 달라요 (위 항목 참고)' };
}
await context.close().catch(() => {});

// ── 7. 사진 이동 (모든 검증 성공 시에만) ──
const allOk = Object.values(R).every((v) => v.상태 === '성공' || v.상태 === '해당 없음');
// 옮길 대상: '사용한 원본'이 있으면 그것 + 영상 원본. 없으면 본문에 직접 쓴 사진 폴더 파일
const media = [...new Set(draft.originals.length || expectVideos.some((v) => v.original)
  ? [...draft.originals, ...expectVideos.map((v) => v.original).filter(Boolean)]
  : [...expectPhotos, ...expectVideos.map((v) => v.file)])];
const isMainPhotoDir = path.resolve(draft.photoDir) === path.resolve(DEFAULT_PHOTO_DIR);
if (allOk && media.length && !isMainPhotoDir) {
  log(`사진 폴더가 기본 블로그사진 폴더가 아니라서(${draft.photoDir}) 사진을 옮기지 않았어요.`);
} else if (allOk && media.length) {
  const moved = moveUsed(media, draft.photoDir);
  const bad = moved.filter((m) => !m.ok);
  log(`사진 이동: ${moved.length - bad.length}/${moved.length}개 '다 쓴 사진'으로 이동`);
  bad.forEach((m) => log(`  ⚠ ${m.file}: ${m.reason}`));
  fs.writeFileSync(path.join(logDir, 'moved.json'), JSON.stringify(moved, null, 2), 'utf8');
} else if (media.length) {
  log('검증이 모두 성공하지 않아 사진을 옮기지 않았어요.');
}
fs.writeFileSync(path.join(draft.dir, 'saved.json'), JSON.stringify({ savedAt: new Date().toISOString(), allOk, result: R, placeChosen, log: logDir }, null, 2), 'utf8');
finish(allOk ? 0 : 1);
