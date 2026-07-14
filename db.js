// การเชื่อมต่อฐานข้อมูล + สร้างสคีมา (ใช้ node:sqlite ในตัว Node 22+ ไม่ต้องคอมไพล์)
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'lease.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// สร้างตารางจาก schema.sql
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// อัตราสำรองเริ่มต้น (ถ้ายังว่าง)
const cnt = db.prepare('SELECT COUNT(*) c FROM provision_rates').get().c;
if (cnt === 0) {
  const ins = db.prepare('INSERT INTO provision_rates(bucket_key,label,rate_pct) VALUES(?,?,?)');
  [['cur','ยังไม่ครบกำหนด',0.5],['b1','1–30 วัน',2],['b2','31–60 วัน',5],
   ['b3','61–90 วัน',10],['b4','91–180 วัน',30],['b5','181–365 วัน',60],
   ['b6','เกิน 365 วัน',100]].forEach(r => ins.run(...r));
}

function audit(actor, action, entity, entity_id, detail) {
  db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?)')
    .run(actor || 'system', action, entity, String(entity_id), detail || '');
}

module.exports = { db, audit, DB_PATH };
