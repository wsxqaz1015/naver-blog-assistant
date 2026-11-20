// 사진 폴더 확인: 새 사진·영상 목록, 열 수 있는지, 클라우드에서 다 내려받아졌는지 검사
// 사용: node src/photos.js            → 목록 출력 (JSON은 logs/photos-latest.json)
//       node src/photos.js move <draft폴더> → 그 초안에 쓴 사진을 '다 쓴 사진'으로 이동 (post.js가 검증 성공 후에만 호출)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PHOTO_DIR } from './draft.js';
import { ROOT, dataDir } from './browser.js';

export const USED_DIR_NAME = '다 쓴 사진';
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.avi', '.wmv', '.mkv'];

function kind(file) {
  const e = path.extname(file).toLowerCase();
  if (IMAGE_EXT.includes(e)) return '사진';
  if (VIDEO_EXT.includes(e)) return '영상';
  return null;
}

// 파일 끝까지 실제로 읽혀야 "내려받아진 것"으로 봐요 (클라우드 전용 파일은 읽다가 멈추거나 실패)
function readable(file, size) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(65536, size || 1));
    let pos = 0;
    let total = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      total += n;
    }
    fs.closeSync(fd);
    return total === size;
  } catch {
    return false;
  }
}

function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format_tags=creation_time:stream_tags=rotate', '-of', 'json', file], { encoding: 'utf8', timeout: 20000 });
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    return v ? { ok: true, width: v.width, height: v.height, duration: v.duration ? Number(v.duration) : null, created: j.format?.tags?.creation_time || null } : { ok: false };
  } catch (e) {
    // FFmpeg(ffprobe)가 설치되지 않았으면 검사를 건너뛰어요 (FFmpeg는 선택 사항)
    if (e.code === 'ENOENT') return { ok: true, noProbe: true };
    return { ok: false };
  }
}

export function scanPhotos(dir = DEFAULT_PHOTO_DIR) {
  if (!dir) return { dir, error: 'config.json에 photoDir(사진 폴더 위치)를 적어 주세요', items: [] };
  if (!fs.existsSync(dir)) return { dir, error: `사진 폴더가 없어요: ${dir}`, items: [] };
  const items = [];
  // 사진 폴더 바로 아래 파일 + 하위 폴더(글 하나 = 폴더 하나) 안의 파일. '다 쓴 사진'은 제외
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === USED_DIR_NAME || name.startsWith('.')) continue;
      for (const sub of fs.readdirSync(full)) entries.push({ name: sub, full: path.join(full, sub), folder: name });
    } else entries.push({ name, full, folder: '' });
  }
  for (const { name, full, folder } of entries) {
    const st = fs.statSync(full);
    if (st.isDirectory() || name.startsWith('.') || name.startsWith('~') || name.toLowerCase() === 'desktop.ini') continue;
    const k = kind(name);
    const item = { name, folder, path: full, kind: k || '기타', size: st.size, modified: st.mtime.toISOString(), problems: [] };
    if (!k) item.problems.push('사진·영상 파일이 아니에요');
    else if (st.size === 0) item.problems.push('크기가 0이에요 (아직 동기화 중일 수 있어요)');
    else if (!readable(full, st.size)) item.problems.push('끝까지 읽히지 않아요 (클라우드에서 아직 내려받지 않았을 수 있어요)');
    else {
      const p = probe(full);
      if (!p.ok) item.problems.push('파일을 열 수 없어요 (손상되었거나 지원하지 않는 형식)');
      else Object.assign(item, { width: p.width, height: p.height, duration: p.duration, created: p.created });
      if (path.extname(name).toLowerCase().startsWith('.hei')) item.note = 'HEIC 사진 → 업로드 전에 JPG로 변환 필요할 수 있음';
    }
    item.usable = item.problems.length === 0;
    items.push(item);
  }
  items.sort((a, b) => (a.folder + '/' + a.name).localeCompare(b.folder + '/' + b.name, 'ko', { numeric: true }));
  return { dir, items };
}

// 사진 이동 (복사 → 크기 확인 → 원본 삭제가 아니라, 같은 드라이브 안 이름 바꾸기로 이동 후 확인)
export function moveUsed(files, dir = DEFAULT_PHOTO_DIR) {
  const usedDir = path.join(dir, USED_DIR_NAME);
  fs.mkdirSync(usedDir, { recursive: true });
  const results = [];
  for (const src of files) {
    const r = { file: path.basename(src), ok: false };
    try {
      const rel = path.relative(path.resolve(dir), path.resolve(src));
      const parts = rel.split(path.sep);
      // 사진 폴더 바로 아래 또는 하위 폴더 한 단계까지만 (다 쓴 사진 안의 파일, 폴더 밖 파일은 안 옮김)
      if (rel.startsWith('..') || path.isAbsolute(rel) || parts.length > 2 || parts[0] === USED_DIR_NAME) { r.reason = '사진 폴더 밖의 파일이라 옮기지 않음'; results.push(r); continue; }
      const targetDir = parts.length === 2 ? path.join(usedDir, parts[0]) : usedDir; // 하위 폴더 이름 유지
      fs.mkdirSync(targetDir, { recursive: true });
      const size = fs.statSync(src).size;
      let dest = path.join(targetDir, path.basename(src));
      if (fs.existsSync(dest)) {
        const ext = path.extname(dest);
        dest = path.join(targetDir, `${path.basename(dest, ext)}_${Date.now()}${ext}`);
      }
      fs.renameSync(src, dest);
      r.ok = fs.existsSync(dest) && fs.statSync(dest).size === size && !fs.existsSync(src);
      r.dest = dest;
      if (!r.ok) r.reason = '이동 후 확인 실패';
    } catch (e) {
      r.reason = e.message;
    }
    results.push(r);
  }
  return results;
}

// 직접 실행했을 때만 (한글·띄어쓰기 폴더 이름에서도 맞게 비교)
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const res = scanPhotos(process.argv[2] && process.argv[2] !== 'move' ? process.argv[2] : undefined);
  fs.mkdirSync(dataDir('logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir('logs'), 'photos-latest.json'), JSON.stringify(res, null, 2), 'utf8');
  if (res.error) console.log('❌', res.error);
  console.log(`사진 폴더: ${res.dir}`);
  console.log(`파일 ${res.items.length}개 (사용 가능 ${res.items.filter((i) => i.usable).length}개)`);
  for (const i of res.items) {
    console.log(`${i.usable ? '✅' : '⚠️'} ${i.kind} ${i.folder ? i.folder + "/" : ""}${i.name} ${i.width ? `${i.width}x${i.height}` : ''}${i.kind === '영상' && i.duration ? ` ${i.duration.toFixed(1)}초` : ''} ${i.problems.join(', ')}${i.note ? ' / ' + i.note : ''}`);
  }
}
