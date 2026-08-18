// =========================================================================
//  seed_all_ledgers.js — นำเข้าข้อมูลทะเบียนคุมลูกหนี้ 17 หน่วยงานครบทุกงวด
// =========================================================================
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'lease.db');
const db = new DatabaseSync(DB_PATH);

function seedAllLedgers() {
  const gzPath = path.join(__dirname, 'seed_port_ledgers.json.gz');
  if (!fs.existsSync(gzPath)) {
    console.error('❌ ไม่พบไฟล์ seed_port_ledgers.json.gz');
    return;
  }

  console.log('🔄 กำลังแตกไฟล์และนำเข้าข้อมูลทะเบียนคุมทั้ง 17 หน่วยงาน...');
  const gzBuffer = fs.readFileSync(gzPath);
  const jsonStr = zlib.gunzipSync(gzBuffer).toString('utf8');
  const rows = JSON.parse(jsonStr);

  db.exec('BEGIN TRANSACTION;');

  // ล้างข้อมูลทะเบียนคุมเดิม
  db.exec('DELETE FROM port_ledgers;');

  const ins = db.prepare(`
    INSERT INTO port_ledgers (
      branch_id, period, contract_id, customer_name, category_name, location_detail, rate_amount,
      bg_overdue_from, bg_periods, bg_overdue_months, bg_amount, bg_vat, bg_total,
      pay_date, pay_receipt_no, pay_amount, pay_status, pay_requested_by, pay_approved_by, pay_approved_at,
      ed_overdue_from, ed_periods, ed_overdue_months, ed_amount, ed_vat, ed_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  rows.forEach(r => {
    ins.run(
      r.branch_id, r.period, r.contract_id || null, r.customer_name, r.category_name || '', r.location_detail || '', r.rate_amount || 0,
      r.bg_overdue_from || '', r.bg_periods || '', r.bg_overdue_months || 0, r.bg_amount || 0, r.bg_vat || 0, r.bg_total || 0,
      r.pay_date || '', r.pay_receipt_no || '', r.pay_amount || 0, r.pay_status || 'none', r.pay_requested_by || null, r.pay_approved_by || null, r.pay_approved_at || null,
      r.ed_overdue_from || '', r.ed_periods || '', r.ed_overdue_months || 0, r.ed_amount || 0, r.ed_vat || 0, r.ed_total || 0
    );
    count++;
  });

  db.exec('COMMIT;');

  console.log(`✅ นำเข้าข้อมูลทะเบียนคุมสำเร็จทั้งหมด ${count} รายการ (ครบ 17 หน่วยงาน)`);

  const summary = db.prepare('SELECT period, COUNT(DISTINCT branch_id) branches, COUNT(*) total FROM port_ledgers GROUP BY period').all();
  console.log('📊 สรุปยอดข้อมูลตามงวด:', summary);
}

if (require.main === module) {
  seedAllLedgers();
}

module.exports = { seedAllLedgers };
