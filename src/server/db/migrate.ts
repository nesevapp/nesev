// `bun run db:migrate` — migrations are also applied automatically on server start (see db/client.ts).
import { DB_PATH } from "../lib/paths";
import "./index";

console.log(`Migrations applied to ${DB_PATH}`);
