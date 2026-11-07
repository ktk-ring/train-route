// 역 목록 스냅샷(data/stations.json) 갱신: npm run stations
// TAGO에서 전국 역을 다시 받아 덮어쓴다. 역이 새로 생기거나 이름이 바뀌었을 때만 돌리면 된다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const { createTago } = await import('../tago.js');

const tmp = path.join(ROOT, 'cache', 'fresh-' + Date.now()); // 캐시를 거치지 않도록 빈 임시 폴더 사용
const tago = createTago({ key: process.env.TAGO_KEY, cacheDir: tmp });
const list = await tago.stations();
if (list.length < 200) throw new Error(`역이 ${list.length}개뿐이에요. API 응답을 확인하세요.`);
await fs.writeFile(path.join(ROOT, 'data', 'stations.json'), JSON.stringify(list, null, 0).replace(/\},\{/g, '},\n{') + '\n');
await fs.rm(tmp, { recursive: true, force: true });
console.log(`역 ${list.length}개 저장: data/stations.json`);
