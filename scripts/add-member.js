require("dotenv").config();
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const [fullName, guardianCode, personCode, role = "member"] = process.argv.slice(2);
if (![fullName, guardianCode, personCode].every(v => typeof v === "string" && v.trim().length)) {
 console.error('Usage: npm run member:add -- "Full Name" "GUARDIAN_CODE" "PERSON_CODE" [admin|member]');
 process.exit(1);
}
const dbFile = process.env.DATABASE_FILE || "./data/hamyar.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const db = new Database(dbFile);
db.exec(`CREATE TABLE IF NOT EXISTS members (
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL,
 guardian_code_hash TEXT NOT NULL, person_code_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'member', active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const result = db.prepare("INSERT INTO members (full_name, guardian_code_hash, person_code_hash, role) VALUES (?, ?, ?, ?)")
 .run(fullName.trim(), bcrypt.hashSync(guardianCode.trim(), 12), bcrypt.hashSync(personCode.trim(), 12), role === "admin" ? "admin" : "member");
console.log("Member created. ID:", result.lastInsertRowid);
db.close();
