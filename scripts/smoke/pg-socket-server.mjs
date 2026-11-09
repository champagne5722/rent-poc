// 冒煙用：沒有 Docker 時，用 PGlite 加 socket 當 PostgreSQL。單一連線，所以應用程式要設 PG_POOL_MAX=1。
// 用法：在 worktree 根目錄 `node --experimental-strip-types scripts/smoke/pg-socket-server.mjs`（通常由 run-smoke.sh 啟動）。
// 環境變數 PG_PORT（預設 54388）。啟動完成後印出一行 `ready`。
// 需要 node_modules 有 @electric-sql/pglite 與 @electric-sql/pglite-socket。後者不在 package.json，
// 沒有時用 `npm install --no-save @electric-sql/pglite-socket` 補。
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);
const { PGLiteSocketServer } = await import(pathToFileURL(require.resolve('@electric-sql/pglite-socket')).href);
const { migrate } = await import(pathToFileURL(path.join(root, 'src/lib/pg/migrate.ts')).href);

const db = new PGlite();
await db.waitReady;
const applied = await migrate(db, { dir: path.join(root, 'db/migrations'), runAs: 'app_owner' });
console.log('migrated', applied.length);
await db.exec('SET ROLE app_rw');
const server = new PGLiteSocketServer({ db, port: Number(process.env.PG_PORT ?? 54388), host: '127.0.0.1' });
await server.start();
console.log('ready');
