// 사용자가 초안을 OK했을 때만 실행: node src/approve.js drafts/<폴더>
import path from 'node:path';
import { approve, readDraft, checkDraft } from './draft.js';

const dir = path.resolve(process.argv[2] || '');
const d = readDraft(dir);
const c = checkDraft(d);
if (c.problems.length) {
  c.problems.forEach((p) => console.log('❌', p));
  console.log('기준에 맞지 않는 초안은 승인할 수 없어요.');
  process.exit(1);
}
const rec = approve(dir);
console.log(`✅ 승인 기록: "${rec.title}" (${new Date(rec.approvedAt).toLocaleString('ko-KR')})`);
