const { db, audit } = require('./db');
const XLSX = require('c:/apps/lease-backend/node_modules/xlsx');
const path = require('path');

console.log('========================================');
console.log('Seeding Port Ledgers (Port Debtor 3-Part Ledgers)');
console.log('========================================');

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS port_ledgers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    period          TEXT NOT NULL,
    contract_id     TEXT REFERENCES contracts(id),
    customer_name   TEXT NOT NULL,
    category_name   TEXT NOT NULL,
    location_detail TEXT,
    rate_amount     REAL DEFAULT 0,
    
    bg_overdue_from TEXT,
    bg_periods      INTEGER DEFAULT 0,
    bg_overdue_months INTEGER DEFAULT 0,
    bg_amount       REAL DEFAULT 0,
    bg_vat          REAL DEFAULT 0,
    bg_total        REAL DEFAULT 0,
    
    pay_date        TEXT,
    pay_receipt_no  TEXT,
    pay_amount      REAL DEFAULT 0,
    
    ed_overdue_from TEXT,
    ed_periods      INTEGER DEFAULT 0,
    ed_overdue_months INTEGER DEFAULT 0,
    ed_amount       REAL DEFAULT 0,
    ed_vat          REAL DEFAULT 0,
    ed_total        REAL DEFAULT 0,
    
    status          TEXT DEFAULT 'unpaid',
    created_at      TEXT DEFAULT (datetime('now'))
  );
`);

// Clear existing port_ledgers
db.exec("DELETE FROM port_ledgers;");

const insLedger = db.prepare(`
  INSERT INTO port_ledgers (
    branch_id, period, contract_id, customer_name, category_name, location_detail, rate_amount,
    bg_overdue_from, bg_periods, bg_overdue_months, bg_amount, bg_vat, bg_total,
    pay_date, pay_receipt_no, pay_amount,
    ed_overdue_from, ed_periods, ed_overdue_months, ed_amount, ed_vat, ed_total,
    status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

// 1. Populate from File 1 (1.ข้อมูลท่า สงขลา 2.xlsx) for Songkhla 2 (C-22)
try {
  const wb = XLSX.readFile('c:/apps/lease-backend/1.ข้อมูลท่า สงขลา 2.xlsx');
  const sheet = wb.Sheets['กค.69'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  let currentCategory = 'ค่าเช่าอาคารและที่ดิน 4700400';
  let seq = 0;

  rows.slice(3).forEach((r) => {
    const itemNo = r[0];
    const colB = (r[1] || '').toString().trim();
    const colC = (r[2] || '').toString().trim();
    const rate = parseFloat(r[3]) || 0;
    const overdueFrom = (r[4] || '').toString().trim();
    const duePeriods = parseInt(r[5]) || 0;
    const overdueAgeMonths = parseInt(r[6]) || 0;
    const arAmount = parseFloat(r[7]) || 0;
    const vatAmount = parseFloat(r[8]) || 0;
    const totalAmount = parseFloat(r[9]) || 0;

    // Receipt and Payment Columns (cols 10, 11, 12 if present in sheet)
    const payDateSerial = r[10];
    const payReceiptNo = (r[11] || '').toString().trim();
    const payAmount = parseFloat(r[12]) || 0;

    if (!colB) return;

    if (!itemNo && colB && !colB.includes('รวม') && arAmount === 0 && totalAmount === 0) {
      currentCategory = colB;
      return;
    }

    if (typeof itemNo === 'number' && colB && colB !== 'รวม') {
      seq++;
      const contractId = `C-22-CT-${String(seq).padStart(3, '0')}`;
      const bgTot = totalAmount > 0 ? totalAmount : arAmount;
      const bgAmt = parseFloat((bgTot / 1.07).toFixed(2));
      const bgVat = parseFloat((bgTot - bgAmt).toFixed(2));

      // Calculate payment & ending balance
      const paid = payAmount > 0 ? payAmount : (bgTot === 0 ? 0 : 0);
      const edTot = Math.max(0, bgTot - paid);
      const edAmt = parseFloat((edTot / 1.07).toFixed(2));
      const edVat = parseFloat((edTot - edAmt).toFixed(2));

      let status = 'unpaid';
      if (paid >= bgTot && bgTot > 0) status = 'paid';
      else if (paid > 0) status = 'partial';
      else if (bgTot === 0) status = 'paid';

      insLedger.run(
        'C-22', '2026-07', contractId, colB, currentCategory, colC, rate,
        overdueFrom, duePeriods, overdueAgeMonths, bgAmt, bgVat, bgTot,
        payDateSerial ? '2026-07-14' : '', payReceiptNo, paid,
        edTot > 0 ? overdueFrom : '', edTot > 0 ? duePeriods : 0, edTot > 0 ? overdueAgeMonths : 0, edAmt, edVat, edTot,
        status
      );
    }
  });

  console.log(`✅ [C-22] Populated ${seq} Port Ledger rows for Songkhla 2`);
} catch (e) {
  console.error('Error seeding Songkhla 2:', e.message);
}

// 2. Populate Sample Initial Port Ledger Data for Chumphon (C-12)
try {
  const chumphonDebtors = [
    { name: 'บ.สมุทรประมง ชุมพร จำกัด', cat: 'ค่าธรรมเนียมสัตว์น้ำผ่านท่า (GL 4600200)', loc: 'แพปลา ทร.ชพ. 1-2', rate: 35000, bgFrom: '21-30มิย.69', bgPeriods: 1, bgAge: 1, bgAmt: 15923, bgVat: 1114.61, bgTot: 17037.61, payDate: '2026-07-24', payReceipt: '022/1086', payAmt: 10000, edFrom: '21-30มิย.69', edPeriods: 1, edAge: 1, edAmt: 6577.21, edVat: 460.40, edTot: 7037.61, status: 'partial' },
    { name: 'นายไสว จันทร์มา', cat: 'ค่าธรรมเนียมรถผ่านท่า (GL 4600300)', loc: 'รถผ่านท่า กขว-885', rate: 321, bgFrom: '', bgPeriods: 0, bgAge: 0, bgAmt: 0, bgVat: 0, bgTot: 0, payDate: '2026-07-02', payReceipt: '022/1081', payAmt: 321, edFrom: '', edPeriods: 0, edAge: 0, edAmt: 0, edVat: 0, edTot: 0, status: 'paid' },
    { name: 'นายพล สังข์แก้วป่า', cat: 'ค่าธรรมเนียมรถผ่านท่า (GL 4600300)', loc: 'รถผ่านท่า ขพษ-712', rate: 321, bgFrom: '', bgPeriods: 0, bgAge: 0, bgAmt: 0, bgVat: 0, bgTot: 0, payDate: '2026-07-07', payReceipt: '022/1088', payAmt: 321, edFrom: '', edPeriods: 0, edAge: 0, edAmt: 0, edVat: 0, edTot: 0, status: 'paid' },
    { name: 'นายสีก้อง แซ่ซั่ง', cat: 'ค่าธรรมเนียมรถผ่านท่า (GL 4600300)', loc: 'รถผ่านท่า ฆ-7286', rate: 321, bgFrom: '', bgPeriods: 0, bgAge: 0, bgAmt: 0, bgVat: 0, bgTot: 0, payDate: '2026-07-14', payReceipt: '022/1097', payAmt: 321, edFrom: '', edPeriods: 0, edAge: 0, edAmt: 0, edVat: 0, edTot: 0, status: 'paid' },
    { name: 'นายมูฮำหมัด เบ็ญโส๊ะ', cat: 'ค่าธรรมเนียมรถผ่านท่า (GL 4600300)', loc: 'รถผ่านท่า งขบ-726', rate: 321, bgFrom: 'กค.69', bgPeriods: 1, bgAge: 1, bgAmt: 300, bgVat: 21, bgTot: 321, payDate: '', payReceipt: '', payAmt: 0, edFrom: 'กค.69', edPeriods: 1, edAge: 1, edAmt: 300, edVat: 21, edTot: 321, status: 'unpaid' },
    { name: 'หจก. ชุมพรการประมง', cat: 'ค่าเช่าอาคารและที่ดิน (GL 4700400)', loc: 'อาคารพานิชย์ ทร.ชพ. 5-6', rate: 25000, bgFrom: 'มิย.69', bgPeriods: 1, bgAge: 1, bgAmt: 23364.49, bgVat: 1635.51, bgTot: 25000, payDate: '2026-07-10', payReceipt: '022/1090', payAmt: 25000, edFrom: '', edPeriods: 0, edAge: 0, edAmt: 0, edVat: 0, edTot: 0, status: 'paid' },
    { name: 'บจก. นำโชคแพปลา ชุมพร', cat: 'ค่าจำหน่ายน้ำประปา (GL 4700200)', loc: 'มิเตอร์น้ำประปา W-04', rate: 12500, bgFrom: 'มิย.69', bgPeriods: 1, bgAge: 1, bgAmt: 11682.24, bgVat: 817.76, bgTot: 12500, payDate: '', payReceipt: '', payAmt: 0, edFrom: 'มิย.69', edPeriods: 1, edAge: 1, edAmt: 11682.24, edVat: 817.76, edTot: 12500, status: 'unpaid' },
    { name: 'นายธนกร แสงแก้ว', cat: 'ค่าจำหน่ายไฟฟ้า (GL 4700300)', loc: 'มิเตอร์ไฟฟ้า E-12', rate: 8400, bgFrom: 'มิย.69', bgPeriods: 1, bgAge: 1, bgAmt: 7850.47, bgVat: 549.53, bgTot: 8400, payDate: '2026-07-15', payReceipt: '022/1101', payAmt: 8400, edFrom: '', edPeriods: 0, edAge: 0, edAmt: 0, edVat: 0, edTot: 0, status: 'paid' }
  ];

  chumphonDebtors.forEach((d, idx) => {
    insLedger.run(
      'C-12', '2026-07', null, d.name, d.cat, d.loc, d.rate,
      d.bgFrom, d.bgPeriods, d.bgAge, d.bgAmt, d.bgVat, d.bgTot,
      d.payDate, d.payReceipt, d.payAmt,
      d.edFrom, d.edPeriods, d.edAge, d.edAmt, d.edVat, d.edTot,
      d.status
    );
  });
  console.log(`✅ [C-12] Populated ${chumphonDebtors.length} Port Ledger rows for Chumphon`);
} catch (e) {
  console.error('Error seeding Chumphon:', e.message);
}

audit('system', 'seed-port-ledgers', 'table', 'port_ledgers', 'Seeded initial 3-part port ledgers for Songkhla 2 and Chumphon');
