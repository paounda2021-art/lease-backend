// การเชื่อมต่อฐานข้อมูล + สร้างสคีมา (ใช้ node:sqlite ในตัว Node 22+ ไม่ต้องคอมไพล์)
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'lease.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Migration: ตรวจสอบคอลัมน์ในตารางต่าง ๆ ก่อนรัน schema
try {
  const cols = db.prepare('PRAGMA table_info(contracts)').all();
  if (cols.length > 0 && !cols.some(c => c.name === 'branch_id')) {
    db.exec('ALTER TABLE contracts ADD COLUMN branch_id TEXT;');
  }
  const ledgerCols = db.prepare('PRAGMA table_info(port_ledgers)').all();
  if (ledgerCols.length > 0 && !ledgerCols.some(c => c.name === 'pay_status')) {
    db.exec("ALTER TABLE port_ledgers ADD COLUMN pay_status TEXT DEFAULT 'none';");
    db.exec("ALTER TABLE port_ledgers ADD COLUMN pay_requested_by TEXT;");
    db.exec("ALTER TABLE port_ledgers ADD COLUMN pay_approved_by TEXT;");
    db.exec("ALTER TABLE port_ledgers ADD COLUMN pay_approved_at TEXT;");
  }
} catch (e) {}

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

// ซิงค์บัญชีผู้ใช้งานอัตโนมัติ (Auto-Sync Official & Branch Users)
try {
  const bcrypt = require('bcryptjs');

  // ลบ mock user เดิม
  db.prepare("DELETE FROM users WHERE LOWER(username) IN ('admin5', 'billing', 'cashier', 'manager')").run();

  const officialList = [
    // Admins
    ['U-001', 'admin', '07170065', 'admin', 'น.ส.รณิดา โชติธนาอุดม (Admin System)', null],
    ['U-ADM-1', 'admin1', '07170164', 'admin', 'น.ส.จิราพร พงษ์ศิริ (หัวหน้าสำนักงาน)', null],
    ['U-ADM-2', 'admin2', '07170041', 'admin', 'น.ส.จรีลักษณ์ เมืองอุดม (เจ้าหน้าที่การเงินและบัญชี)', null],
    ['U-ADM-3', 'admin3', '07170167', 'admin', 'น.ส.จิตทามาศ ผลงาม (เจ้าหน้าที่บริหารงานทั่วไป)', null],
    ['U-ADM-4', 'admin4', '07170146', 'admin', 'น.ส.ณัฏฐ์เมธินี จงสัจจา (เจ้าหน้าที่การเงินและบัญชี)', null],

    // Email & Short Handles
    ['U-019', 'jiraporn.p@fishmarket.co.th', '07170164', 'admin', 'น.ส.จิราพร พงษ์ศิริ (หัวหน้าสำนักงาน)', null],
    ['U-020', 'jiraporn.p', '07170164', 'admin', 'น.ส.จิราพร พงษ์ศิริ (หัวหน้าสำนักงาน)', null],
    ['U-021', 'jareelak.m@fishmarket.co.th', '07170041', 'admin', 'น.ส.จรีลักษณ์ เมืองอุดม (เจ้าหน้าที่การเงินและบัญชี)', null],
    ['U-022', 'jareelak.m', '07170041', 'admin', 'น.ส.จรีลักษณ์ เมืองอุดม (เจ้าหน้าที่การเงินและบัญชี)', null],
    ['U-023', 'jittamas.p@fishmarket.co.th', '07170167', 'admin', 'น.ส.จิตทามาศ ผลงาม (เจ้าหน้าที่บริหารงานทั่วไป)', null],
    ['U-024', 'jittamas.p', '07170167', 'admin', 'น.ส.จิตทามาศ ผลงาม (เจ้าหน้าที่บริหารงานทั่วไป)', null],
    ['U-025', 'natmethinee.c@fishmarket.co.th', '07170146', 'admin', 'น.ส.ณัฏฐ์เมธินี จงสัจจา (เจ้าหน้าที่การเงินและบัญชี)', null],
    ['U-026', 'natmethinee.c', '07170146', 'admin', 'น.ส.ณัฏฐ์เมธินี จงสัจจา (เจ้าหน้าที่การเงินและบัญชี)', null],
    ['U-027', 'ranida.c@fishmarket.co.th', '07170065', 'admin', 'น.ส.รณิดา โชติธนาอุดม (Admin System)', null],
    ['U-028', 'ranida.c', '07170065', 'admin', 'น.ส.รณิดา โชติธนาอุดม (Admin System)', null],

    // Viewers
    ['U-013', 'preeda.y@fishmarket.co.th', 'password123', 'viewer', 'นายปรีดา ยังสุขสถาพร (ผอ.)', null],
    ['U-014', 'preeda.y', 'password123', 'viewer', 'นายปรีดา ยังสุขสถาพร (ผอ.)', null],
    ['U-015', 'supbhachart.c@fishmarket.co.th', '07170184', 'viewer', 'นายศุภชาติ ชาสมบัติ (รองผู้อำนวยการด้านบริหาร)', null],
    ['U-016', 'supbhachart.c', '07170184', 'viewer', 'นายศุภชาติ ชาสมบัติ (รองผู้อำนวยการด้านบริหาร)', null],
    ['U-017', 'thanachai.c@fishmarket.co.th', '07170078', 'viewer', 'นายธนชัย ฉายศรี (เจ้าหน้าที่ตรวจสอบภายใน)', null],
    ['U-018', 'thanachai.c', '07170078', 'viewer', 'นายธนชัย ฉายศรี (เจ้าหน้าที่ตรวจสอบภายใน)', null]
  ];

  const upsertUser = db.prepare(`
    INSERT INTO users (id, username, password, role, fullname, branch_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password = excluded.password,
      role = excluded.role,
      fullname = excluded.fullname,
      branch_id = excluded.branch_id
  `);

  officialList.forEach(([id, username, pass, role, fullname, branch_id]) => {
    const hash = bcrypt.hashSync(pass, 10);
    upsertUser.run(id, username, hash, role, fullname, branch_id);
  });

  // Branch Users user02 - user22
  const branchList = db.prepare("SELECT id, name FROM branches").all();
  const defaultBranchPassHash = bcrypt.hashSync('password123', 10);

  branchList.forEach(b => {
    const codeNum = b.id.replace('C-', '').toLowerCase();
    const uName = `user${codeNum}`;
    const uId = `U-BR-${codeNum.toUpperCase()}`;
    const uFullname = `เจ้าหน้าที่ประจำ${b.name}`;
    upsertUser.run(uId, uName, defaultBranchPassHash, 'branch', uFullname, b.id);
  });
} catch (err) {
  console.error('Error auto-syncing users in db.js:', err);
}

function audit(actor, action, entity, entity_id, detail) {
  db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?)')
    .run(actor || 'system', action, entity, String(entity_id), detail || '');
}

module.exports = { db, audit, DB_PATH };
