import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { dbPath } from "../paths.js";
import { migrate } from "./migrations.js";

export type { Database };

export function openDatabase(file: string = dbPath()): Database {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseConstructor(file);
  migrate(db);
  return db;
}
