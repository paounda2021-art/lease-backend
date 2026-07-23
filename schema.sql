-- ===========================================================
--  ระบบติดตามหนี้เช่า — โครงสร้างฐานข้อมูล (SQLite)
--  Lease Receivables Tracking — Database Schema
-- ===========================================================

PRAGMA foreign_keys = ON;

-- หน่วยงาน / สะพานปลา / ท่าเทียบเรือ (17 แห่ง)
CREATE TABLE IF NOT EXISTS branches (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  region      TEXT,                 -- ภาคกลาง / ภาคใต้ / ภาคตะวันออก ฯลฯ
  created_at  TEXT DEFAULT (datetime('now'))
);

-- บัญชีผู้ใช้งานระบบ (Authentication & Role-Based Access Control)
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,                  -- รหัสผ่านที่ถูกแฮชแล้ว (bcrypt)
  role        TEXT NOT NULL,                  -- admin / billing / cashier / manager
  fullname    TEXT NOT NULL,
  branch_id   TEXT REFERENCES branches(id),
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ผู้เช่า / ลูกหนี้
CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  tax_id            TEXT,                 -- เลขผู้เสียภาษี / บัตรประชาชน
  address           TEXT,                 -- ที่อยู่ตามทะเบียน (ใช้ส่งหนังสือ/หมายศาล)
  authorized_person TEXT,                 -- ผู้มีอำนาจลงนาม
  guarantor         TEXT,                 -- ผู้ค้ำประกัน
  created_at        TEXT DEFAULT (datetime('now'))
);

-- สัญญาเช่า (ข้อมูลหลัก)
CREATE TABLE IF NOT EXISTS contracts (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  branch_id       TEXT REFERENCES branches(id), -- หน่วยงานสังกัด (1 ใน 17 แห่ง)
  unit            TEXT,                   -- ยูนิต/พื้นที่
  rent_monthly    REAL NOT NULL DEFAULT 0,-- ค่าเช่า/เดือน (ยกเว้น VAT)
  service_monthly REAL NOT NULL DEFAULT 0,-- ค่าบริการ/เดือน (VAT 7%)
  start_date      TEXT,
  end_date        TEXT,
  due_day         INTEGER DEFAULT 5,      -- วันครบกำหนดชำระของเดือน
  deposit         REAL DEFAULT 0,         -- เงินประกันตั้งต้น
  deposit_balance REAL DEFAULT 0,         -- เงินประกันคงเหลือ (หลังหักล้างหนี้)
  penalty_rate    REAL DEFAULT 1.5,       -- อัตราค่าปรับผิดนัด %/เดือน
  risk_tier       TEXT DEFAULT 'ต่ำ',      -- ต่ำ/กลาง/สูง
  stamp_duty_paid INTEGER DEFAULT 0,      -- ปิดอากรแสตมป์แล้วหรือยัง (0/1)
  status          TEXT DEFAULT 'active',  -- active/terminated
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contracts_branch ON contracts(branch_id);

-- ใบแจ้งหนี้ / ลูกหนี้รายใบ
CREATE TABLE IF NOT EXISTS invoices (
  id               TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL REFERENCES contracts(id),
  period           TEXT,                  -- งวด เช่น 2026-06
  issue_date       TEXT,
  due_date         TEXT NOT NULL,
  rent_amt         REAL DEFAULT 0,
  service_amt      REAL DEFAULT 0,
  vat_amt          REAL DEFAULT 0,
  total            REAL DEFAULT 0,
  paid             REAL DEFAULT 0,
  penalty          REAL DEFAULT 0,
  status           TEXT DEFAULT 'open',   -- open/partial/paid/writeoff
  litigation       INTEGER DEFAULT 0,
  written_off      INTEGER DEFAULT 0,
  written_off_date TEXT,
  created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_contract ON invoices(contract_id);
CREATE INDEX IF NOT EXISTS idx_inv_due      ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_inv_status   ON invoices(status);

-- รายการรับชำระ
CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  pay_date   TEXT,
  amount     REAL,                        -- ยอดที่ตัดชำระลูกหนี้
  wht_amt    REAL DEFAULT 0,              -- ภาษีหัก ณ ที่จ่าย
  method     TEXT,                        -- โอน/เงินสด/หักเงินประกัน
  note       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- บันทึกการทวงถาม (หลักฐานสำหรับเกณฑ์ตัดหนี้สูญ ก.186)
CREATE TABLE IF NOT EXISTS dunning_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT REFERENCES invoices(id),
  contract_id TEXT REFERENCES contracts(id),
  action_date TEXT,
  level       TEXT,   -- reminder/call/letter1/letter2/legal/demand/lawsuit/judgment
  channel     TEXT,   -- sms/email/phone/registered-mail
  result      TEXT,
  note        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dun_contract ON dunning_log(contract_id);

-- ตารางอัตราสำรอง (provision matrix) แก้ไขได้
CREATE TABLE IF NOT EXISTS provision_rates (
  bucket_key TEXT PRIMARY KEY,   -- cur,b1,b2,b3,b4,b5,b6
  label      TEXT,
  rate_pct   REAL
);

-- ร่องรอยการแก้ไข (audit trail) — สำคัญมากสำหรับการตัดหนี้สูญ
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT DEFAULT (datetime('now')),
  actor     TEXT,
  action    TEXT,
  entity    TEXT,
  entity_id TEXT,
  detail    TEXT
);
