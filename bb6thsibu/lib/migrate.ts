// lib/migrate.ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("迁移完成！");
  process.exit(0);
}
main();