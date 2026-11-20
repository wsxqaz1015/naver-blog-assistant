// 초안 파일(draft.md) 읽기·검사·승인 확인
//
// draft.md 형식:
//   제목: ...
//   카테고리: 카페
//   장소: 네이버 지도 검색어 (없으면 "없음")
//   태그: 태그1, 태그2, ...  (최대 30개)
//   협찬: 없음  또는  업체명 / 받은 것
//   정렬: (선택) 가운데(기본) / 왼쪽 / 오른쪽 / 양끝
//   사진폴더: (선택) 기본값은 config.json의 photoDir
//   사용한 원본: IMG_1.jpg, IMG_2.jpg, IMG_3.mov  (블로그에는 모자이크·편집 사본을 올리고, 성공 후 이 원본들을 '다 쓴 사진'으로)
//   ---
// 사본 위치: drafts/<글>/media/ (절대 경로로 적거나, 사진폴더 기준 파일 이름)
//   본문...
//
// 본문 표시:
//   [소제목]            → 다음 줄을 세로줄 인용구로
//   [사진: a.jpg, b.jpg] → 사진 (여러 장이면 개별사진)
//   [영상: v.mp4 | 영상 제목]
//   [구분선]
//   [장소]              → 머리말의 장소를 지도 첨부
//   빈 줄               → 빈 문단
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CONFIG } from './browser.js';

// 사진 폴더·카테고리·글자 수 기준은 config.json에서 읽어요
export const DEFAULT_PHOTO_DIR = CONFIG.photoDir || '';
export const CATEGORIES = CONFIG.categories || [];
const MAX_CHARS = CONFIG.maxChars || 4000;
const MAX_TAGS = 30;

export function readDraft(dir) {
  const file = path.join(dir, 'draft.md');
  const raw = fs.readFileSync(file, 'utf8').replace(/^\s+/, '').replace(/\r\n/g, '\n');
  const sep = raw.indexOf('\n---\n');
  if (sep < 0) throw new Error('draft.md에 머리말과 본문을 나누는 "---" 줄이 없어요');
  const head = raw.slice(0, sep);
  const body = raw.slice(sep + 5);

  const meta = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const none = (v) => !v || v === '없음';
  const photoDir = meta['사진폴더'] || DEFAULT_PHOTO_DIR;
  const draft = {
    dir,
    file,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    title: meta['제목'] || '',
    category: meta['카테고리'] || '',
    place: none(meta['장소']) ? null : meta['장소'],
    tags: (meta['태그'] || '').split(/[,#\n]/).map((t) => t.trim().replace(/\s+/g, '')).filter(Boolean),
    sponsor: none(meta['협찬']) ? null : meta['협찬'],
    // 정렬: 가운데(기본) / 왼쪽 / 오른쪽 / 양끝
    align: ({ '가운데': 'center', '왼쪽': 'left', '오른쪽': 'right', '양끝': 'justify' })[meta['정렬'] || '가운데'] || 'center',
    photoDir,
    // 블로그에 올린 사본(모자이크·편집본)의 원래 파일들. 저장·검증 성공 후 '다 쓴 사진'으로 옮길 대상
    originals: none(meta['사용한 원본']) ? [] : meta['사용한 원본'].split(',').map((f) => f.trim()).filter(Boolean).map((f) => resolveMedia(f, photoDir, dir)),
    blocks: parseBody(body, photoDir, dir),
  };
  return draft;
}

function resolveMedia(name, photoDir, draftDir) {
  if (path.isAbsolute(name)) return name;
  if (draftDir && /^media[\\/]/.test(name)) return path.join(draftDir, name); // drafts/<글>/media/ 사본
  return path.join(photoDir, name);
}

export function parseBody(body, photoDir, draftDir) {
  const lines = body.split('\n');
  const blocks = [];
  let text = [];
  const flush = () => {
    while (text.length && !text[0].trim()) text.shift();
    while (text.length && !text.at(-1).trim()) text.pop();
    if (text.length) blocks.push({ type: 'text', lines: text.map((l) => l.replace(/\s+$/, '')) });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    let m;
    if (t === '[소제목]') {
      flush();
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      blocks.push({ type: 'quote', text: (lines[j] || '').trim() });
      i = j;
    } else if ((m = t.match(/^\[사진\s*:\s*(.+)\]$/))) {
      flush();
      blocks.push({ type: 'photos', files: m[1].split(',').map((f) => resolveMedia(f.trim(), photoDir, draftDir)) });
    } else if ((m = t.match(/^\[영상\s*:\s*(.+)\]$/))) {
      // [영상: 파일 | 영상 제목 | 원본: 원본파일]
      flush();
      const parts = m[1].split('|').map((s) => s.trim());
      const orig = parts.find((p) => /^원본\s*:/.test(p));
      blocks.push({
        type: 'video',
        file: resolveMedia(parts[0], photoDir, draftDir),
        title: parts.slice(1).find((p) => !/^원본\s*:/.test(p)) || '',
        original: orig ? resolveMedia(orig.replace(/^원본\s*:\s*/, ''), photoDir) : null,
      });
    } else if (t === '[구분선]') {
      flush();
      blocks.push({ type: 'hr' });
    } else if (t === '[장소]') {
      flush();
      blocks.push({ type: 'place' });
    } else {
      text.push(line);
    }
  }
  flush();
  return blocks;
}

// 본문 글자 수 (표시 줄 제외, 줄바꿈 제외)
export function charCount(draft) {
  let n = 0;
  for (const b of draft.blocks) {
    if (b.type === 'text') n += b.lines.join('').length;
    if (b.type === 'quote') n += b.text.length;
  }
  return n;
}

// 저장 전에 지켜야 할 기준 검사. problems가 있으면 저장하지 않아요.
export function checkDraft(draft) {
  const problems = [];
  const warnings = [];
  if (!draft.title) problems.push('제목이 비어 있어요');
  if (!CATEGORIES.includes(draft.category)) problems.push(`카테고리 "${draft.category}"가 블로그에 없어요 (${CATEGORIES.join(', ')})`);
  if (draft.tags.length > MAX_TAGS) problems.push(`태그가 ${draft.tags.length}개예요 (최대 ${MAX_TAGS}개)`);
  if (draft.tags.length < MAX_TAGS) warnings.push(`태그가 ${draft.tags.length}개예요 (기준 ${MAX_TAGS}개)`);
  if (new Set(draft.tags).size !== draft.tags.length) problems.push('중복된 태그가 있어요');
  const chars = charCount(draft);
  if (chars > MAX_CHARS) problems.push(`본문이 ${chars}자예요 (최대 ${MAX_CHARS}자)`);
  const quotes = draft.blocks.filter((b) => b.type === 'quote');
  if (quotes.length < 2 || quotes.length > 4) warnings.push(`소제목이 ${quotes.length}개예요 (기준 2~4개)`);
  quotes.forEach((q) => { if (!/[?？]/.test(q.text)) warnings.push(`질문형이 아닌 소제목: "${q.text}"`); });
  if (draft.blocks.some((b) => b.type === 'place') && !draft.place) problems.push('[장소] 표시가 있는데 머리말에 장소가 없어요');
  for (const f of draft.originals) {
    if (fs.existsSync(f)) continue;
    // 이미 저장에 성공해 '다 쓴 사진'으로 옮겨진 원본이면 문제 아님 (같은 글을 다시 저장할 때)
    const rel = path.relative(draft.photoDir, f);
    if (fs.existsSync(path.join(draft.photoDir, '다 쓴 사진', rel))) warnings.push(`이미 다 쓴 사진으로 옮겨진 원본: ${rel}`);
    else problems.push(`사용한 원본 파일이 없어요: ${f}`);
  }
  // 모자이크 규칙: 사진 폴더의 원본 사진을 그대로 올리지 않음 (모자이크 사본 사용)
  const rawFromPhotoDir = draft.blocks.filter((b) => b.type === 'photos').flatMap((b) => b.files).filter((f) => path.resolve(path.dirname(f)) === path.resolve(DEFAULT_PHOTO_DIR));
  if (rawFromPhotoDir.length) warnings.push(`모자이크 처리 안 된 원본 사진 ${rawFromPhotoDir.length}장을 그대로 올려요 (사람이 없는 사진인지 확인)`);
  for (const b of draft.blocks) {
    const files = b.type === 'photos' ? b.files : b.type === 'video' ? [b.file] : [];
    for (const f of files) if (!fs.existsSync(f)) problems.push(`파일이 없어요: ${f}`);
    if (b.type === 'video' && b.original && !fs.existsSync(b.original)) problems.push(`영상 원본 파일이 없어요: ${b.original}`);
    if (b.type === 'video' && !b.title) problems.push(`영상 제목이 없어요: ${b.file}`);
    if (b.type === 'video' && fs.existsSync(b.file)) {
      try {
        const pf = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', b.file], { encoding: 'utf8' }).trim();
        if (pf !== 'yuv420p') problems.push(`영상 색 형식이 ${pf}예요 → yuv420p로 다시 만들어야 해요 (네이버에서 깨져 보임): ${b.file}`);
      } catch {}
    }
    if (b.type === 'video' && b.title.length > 40) problems.push(`영상 제목이 40자를 넘어요: ${b.title}`);
  }
  if (draft.sponsor) {
    const first = draft.blocks[0];
    const top = first?.type === 'text' ? first.lines.join(' ') : '';
    if (!/제공받|협찬|광고|원고료|지원받/.test(top)) problems.push('협찬 글인데 본문 맨 처음에 광고 표시 문구가 없어요');
    const all = draft.blocks.filter((b) => b.type === 'text').map((b) => b.lines.join(' ')).join(' ');
    for (const bad of ['신중히', '신중하게 고려', '단점도 생각', '단점을 생각']) if (all.includes(bad)) warnings.push(`협찬 글에 구매를 망설이게 하는 표현: "${bad}"`);
  }
  warnings.push(...styleWarnings(draft));
  return { problems, warnings, chars, quotes: quotes.length };
}

// 글 품질 점검 (2026-11-16 노션 'AI로 블로그 포스팅 15분' 발행 전 체크리스트 반영) — 경고만, 저장은 막지 않음
//   AI가 지어내기 쉬운 표현 / 같은 감상 반복 / 제목에 핵심 검색어
const AI_PHRASES = ['고스란히', '선사', '마음 한켠', '마음 한편', '사르르 녹', '입안 가득', '육즙이 풍부', '오감을', '완벽한 조화', '환상의 조합', '눈과 입이 즐거', '특별한 경험', '잊지 못할', '말이 필요 없', '두말할 필요', '감성 가득', '설렘 가득'];
const REPEAT_PHRASES = ['좋았어요', '만족스러웠어요', '만족스러웠', '추천드려요', '추천드립니다', '추천해요', '맛있었어요', '인상적이었어요', '최고였어요', '분위기 좋'];
const squash = (s) => s.replace(/\s+/g, '');
export function styleWarnings(draft) {
  const w = [];
  const text = draft.blocks.filter((b) => b.type === 'text' || b.type === 'quote').map((b) => (b.type === 'text' ? b.lines.join('\n') : b.text)).join('\n');
  for (const p of AI_PHRASES) if (text.includes(p)) w.push(`AI식 표현 "${p}" — 사용자가 실제로 그렇게 느꼈는지 확인 (아니면 사용자 말로 바꾸기)`);
  for (const p of REPEAT_PHRASES) {
    const n = text.split(p).length - 1;
    if (n >= 3) w.push(`"${p}"가 ${n}번 나와요 — 같은 감상 반복. 문단마다 새로운 정보 하나씩`);
  }
  const t = squash(draft.title || '');
  const shop = squash((draft.place || '').split(/\s+/)[0] || '');
  if (shop && !t.includes(shop)) w.push(`제목에 가게 이름 "${shop}"이 없어요`);
  if (draft.tags[0] && !t.includes(squash(draft.tags[0]))) w.push(`제목에 대표 검색어(첫 번째 태그) "${draft.tags[0]}"가 없어요`);
  return w;
}

// 승인: 사용자가 OK한 순간의 draft.md 내용을 지문(hash)으로 기록
export function approve(dir) {
  const d = readDraft(dir);
  const rec = { approvedAt: new Date().toISOString(), hash: d.hash, title: d.title };
  fs.writeFileSync(path.join(dir, 'approved.json'), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

// 승인 후 내용이 바뀌었으면 승인 무효
export function approvalStatus(draft) {
  const f = path.join(draft.dir, 'approved.json');
  if (!fs.existsSync(f)) return { ok: false, reason: '아직 승인되지 않은 초안이에요' };
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (rec.hash !== draft.hash) return { ok: false, reason: '승인한 뒤에 초안 내용이 바뀌었어요. 다시 승인이 필요해요' };
  return { ok: true, approvedAt: rec.approvedAt };
}
