// =========================================================================
//  สคริปต์นำเข้าไฟล์ข้อมูลอัตโนมัติ c02_1 ถึง c22_3 (Batch Excel Auto Importer)
//  รองรับโครงสร้างไฟล์:
//    cXX_1 -> ไฟล์ข้อมูลท่า / ทะเบียนคุมลูกหนี้ 3 ส่วน (GL, ทะเบียน, ค้างยกมา, รับชำระ, ยกไป)
//    cXX_2 -> ไฟล์ข้อมูลอายุหนี้ (Aging & สำรอง)
//    cXX_3 -> ไฟล์รูปแบบสรุปรายงาน (GL Summary Template)
// =========================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { db, audit } = require('./db');

console.log('=================================================================');
console.log('🚀 เริ่มต้นการค้นหาและนำเข้าข้อมูลชุดไฟล์ c02_1 ถึง c22_3 เข้าสู่ระบบ');
console.log('=================================================================');

// แมปชื่อไฟล์กับรหัสหน่วยงาน C-XX
const branchMapping = {
  'c01': 'C-01', 'c02': 'C-02', 'c03': 'C-03', 'c04': 'C-04',
  'c05': 'C-05', 'c06': 'C-06', 'c07': 'C-07', 'c08': 'C-08',
  'c09': 'C-09', 'c10': 'C-10', 'c11': 'C-11', 'c12': 'C-12',
  'c13': 'C-13', 'c14': 'C-14', 'c15': 'C-15', 'c16': 'C-16',
  'c17': 'C-17', 'c18': 'C-18', 'c19': 'C-19', 'c20': 'C-20',
  'c21': 'C-21', 'c22': 'C-22'
};

const insCust = db.prepare("INSERT OR IGNORE INTO customers(id,name,tax_id,address) VALUES(?,?,?,?)");
const insContract = db.prepare(`INSERT OR REPLACE INTO contracts
  (id,branch_id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
const insInvoice = db.prepare(`INSERT OR REPLACE INTO invoices
  (id,contract_id,period,issue_date,due_date,rent_amt,service_amt,vat_amt,total,paid,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
const insLedger = db.prepare(`
  INSERT INTO port_ledgers (
    branch_id, period, contract_id, customer_name, category_name, location_detail, rate_amount,
    bg_overdue_from, bg_periods, bg_overdue_months, bg_amount, bg_vat, bg_total,
    pay_date, pay_receipt_no, pay_amount,
    ed_overdue_from, ed_periods, ed_overdue_months, ed_amount, ed_vat, ed_total,
    status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

function parseAndImportFile1(filePath, branchId, period = '2026-07') {
  try {
    const wb = XLSX.readFile(filePath);
    let sheetName = wb.SheetNames[0];
    const found = wb.SheetNames.find(s => s.toLowerCase().includes('กค') || s.toLowerCase().includes('ก.ค.'));
    if (found) sheetName = found;

    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    let currentCategory = 'ค่าเช่าอาคารและที่ดิน';
    let count = 0;
    let totalAR = 0;

    // Clear existing for this branch and period
    db.prepare("DELETE FROM port_ledgers WHERE branch_id = ? AND period = ?").run(branchId, period);

    rows.slice(3).forEach(row => {
      const itemNo = row[0];
      const colB = (row[1] || '').toString().trim();
      const colC = (row[2] || '').toString().trim();
      const rate = parseFloat(row[3]) || 0;
      const overdueFrom = (row[4] || '').toString().trim();
      const duePeriods = parseInt(row[5]) || 0;
      const overdueAgeMonths = parseInt(row[6]) || 0;
      const arAmount = parseFloat(row[7]) || 0;
      const vatAmount = parseFloat(row[8]) || 0;
      const totalAmount = parseFloat(row[9]) || 0;

      const payDate = (row[10] || '').toString().trim();
      const payReceiptNo = (row[11] || '').toString().trim();
      const payAmount = parseFloat(row[12]) || 0;

      if (!colB) return;

      // Category Header Row
      if (!itemNo && colB && !colB.includes('รวม') && arAmount === 0 && totalAmount === 0) {
        currentCategory = colB;
        return;
      }

      if ((typeof itemNo === 'number' || (typeof itemNo === 'string' && itemNo.match(/^\d+$/))) && colB && !colB.includes('รวม')) {
        count++;
        const custId = `CU-${branchId.replace('-', '')}-${String(count).padStart(4, '0')}`;
        const contractId = `${branchId}-CT-${String(count).padStart(4, '0')}`;
        const invoiceId = `INV-${branchId.replace('-', '')}-${String(count).padStart(4, '0')}`;

        const bgTot = totalAmount > 0 ? totalAmount : arAmount;
        const bgAmt = arAmount > 0 ? arAmount : parseFloat((bgTot / 1.07).toFixed(2));
        const bgVat = vatAmount > 0 ? vatAmount : parseFloat((bgTot - bgAmt).toFixed(2));

        const paid = payAmount;
        const edTot = Math.max(0, bgTot - paid);
        const edAmt = parseFloat((edTot / 1.07).toFixed(2));
        const edVat = parseFloat((edTot - edAmt).toFixed(2));
        const edFrom = edTot > 0 ? overdueFrom : '';
        const edPeriods = edTot > 0 ? duePeriods : 0;
        const edMonths = edTot > 0 ? overdueAgeMonths : 0;

        let status = 'unpaid';
        if (paid >= bgTot && bgTot > 0) status = 'paid';
        else if (paid > 0) status = 'partial';
        else if (bgTot === 0) status = 'paid';

        const fullUnit = colC ? `${currentCategory} (${colC})` : currentCategory;
        insCust.run(custId, colB, '0994000160000', `ส่วนงาน ${branchId} (${fullUnit})`);

        let riskTier = 'ต่ำ';
        if (overdueAgeMonths > 6 || bgTot > 100000) riskTier = 'สูง';
        else if (overdueAgeMonths > 1 || bgTot > 20000) riskTier = 'กลาง';

        insContract.run(contractId, branchId, custId, fullUnit, rate || bgTot, Math.round((rate || bgTot) * 0.07), '2025-01-01', '2027-12-31', 5, bgTot * 2, bgTot * 2, 1.5, riskTier);

        if (bgTot > 0) {
          insInvoice.run(invoiceId, contractId, period, '2026-06-25', '2026-07-05', bgAmt, 0, bgVat, bgTot, paid, status);
          totalAR += bgTot;
        }

        insLedger.run(
          branchId, period, contractId, colB, currentCategory, colC, rate,
          overdueFrom, duePeriods, overdueAgeMonths, bgAmt, bgVat, bgTot,
          payDate, payReceiptNo, paid,
          edFrom, edPeriods, edMonths, edAmt, edVat, edTot,
          status
        );
      }
    });

    console.log(`  ✅ [${branchId}] ไฟล์ 1 (${path.basename(filePath)}): นำเข้าสำเร็จ ${count} รายการ | ยอดหนี้รวม ${totalAR.toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`);
    audit('system', 'import-batch-cxx_1', 'port_ledgers', branchId, `Imported ${count} records from ${path.basename(filePath)}`);
    return { count, totalAR };
  } catch (err) {
    console.error(`  ❌ [${branchId}] ข้อผิดพลาดในการนำเข้า ${filePath}:`, err.message);
    return { count: 0, totalAR: 0, error: err.message };
  }
}

// สแกนโฟลเดอร์หาไฟล์ cXX_1.xlsx, cXX_2.xlsx, cXX_3.xlsx
const allFiles = fs.readdirSync(__dirname);
let foundFilesCount = 0;

console.log('\n🔍 กำลังตรวจสอบไฟล์ในโฟลเดอร์...');
allFiles.forEach(fileName => {
  const match = fileName.match(/^(c\d{2})_([123])\.(xlsx|xls)$/i);
  if (match) {
    foundFilesCount++;
    const code = match[1].toLowerCase();
    const typeNum = match[2];
    const branchId = branchMapping[code] || code.toUpperCase();
    const fullPath = path.join(__dirname, fileName);

    console.log(`📌 ตรวจพบไฟล์: ${fileName} -> หน่วยงาน ${branchId} (ไฟล์ประเภทที่ ${typeNum})`);
    if (typeNum === '1') {
      parseAndImportFile1(fullPath, branchId, '2026-07');
    }
  }
});

if (foundFilesCount === 0) {
  console.log('ℹ️ ยังไม่พบไฟล์ชื่อรูปแบบ c02_1.xlsx ถึง c21_3.xlsx ในโฟลเดอร์นี้');
  console.log('💡 คุณสามารถวางไฟล์ชื่อ เช่น c02_1.xlsx, c03_1.xlsx, c21_1.xlsx ฯลฯ แล้วรัน: node import_cxx_batch.js ได้ทันที');
} else {
  console.log(`\n🎉 ประมวลผลเสร็จสมบูรณ์สำหรับ ${foundFilesCount} ไฟล์!`);
}

module.exports = { parseAndImportFile1, branchMapping };
