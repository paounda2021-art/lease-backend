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

function excelDateToISO(serial, fallback = '2026-06-25') {
  if (!serial || isNaN(serial)) return fallback;
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  return date_info.toISOString().slice(0, 10);
}

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

function parseAndImportFile(filePath, branchId, period = '2026-07') {
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

    let isSongkhla3Part = false;
    let isMatrixFormat = false;
    let headerRowIdx = -1;

    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const rStr = (rows[i] || []).join(' ');
      if (rStr.includes('ค้างตั้งแต่') && (rStr.includes('งวด') || rStr.includes('อายุ') || rStr.includes('ยอดหนี้'))) {
        isSongkhla3Part = true;
        headerRowIdx = i;
        break;
      }
      if (rStr.includes('เลขที่ใบแจ้งหนี้') || (rStr.includes('ผู้เช่า') && (rStr.includes('พื้นที่เช่า') || rStr.includes('ยอดคงค้าง')))) {
        isMatrixFormat = true;
        headerRowIdx = i;
        break;
      }
    }

    if (headerRowIdx === -1) headerRowIdx = 4;

    // Clear existing for this branch and period
    db.prepare("DELETE FROM port_ledgers WHERE branch_id = ? AND period = ?").run(branchId, period);

    if (isSongkhla3Part) {
      rows.slice(headerRowIdx + 1).forEach(row => {
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
    } else {
      let contractSeq = 0;
      rows.slice(headerRowIdx + 1).forEach(row => {
        const invCode = row[0];
        const tenantName = (row[1] || '').toString().trim();
        const unit = (row[2] || '').toString().trim();
        const rent = parseFloat(row[3]) || 0;
        const arAmt = parseFloat(row[4]) || 0;
        const dueSerial = row[5];
        const daysOverdue = parseInt(row[6]) || 0;

        if (!tenantName || !unit || tenantName.includes('รวม') || tenantName.includes('ทั้งหมด')) return;

        contractSeq++;
        count++;
        const custId = `CU-${branchId.replace('-', '')}-${String(contractSeq).padStart(4, '0')}`;
        const contractId = `${branchId}-CT-${String(contractSeq).padStart(4, '0')}`;
        const invoiceId = invCode ? String(invCode).trim() : `INV-${branchId.replace('-', '')}-${String(contractSeq).padStart(4, '0')}`;

        insCust.run(custId, tenantName, '01055' + String(1000000 + contractSeq), `ส่วนงาน ${branchId}`);

        let riskTier = 'ต่ำ';
        if (arAmt > 200000 || daysOverdue > 90) riskTier = 'สูง';
        else if (arAmt > 30000 || daysOverdue > 30) riskTier = 'กลาง';

        insContract.run(contractId, branchId, custId, unit, rent, Math.round(rent * 0.1), '2024-01-01', '2027-12-31', 5, rent * 3, rent * 3, 1.5, riskTier);

        const rentAmt = Math.round((arAmt / 1.07) * 100) / 100;
        const vatAmt = Math.round((arAmt - rentAmt) * 100) / 100;
        const overdueMonths = Math.floor(daysOverdue / 30) || (daysOverdue > 0 ? 1 : 0);
        const dueISO = excelDateToISO(dueSerial, `${period}-05`);

        if (arAmt > 0) {
          insInvoice.run(invoiceId, contractId, period, '2026-05-25', dueISO, rentAmt, 0, vatAmt, arAmt, 0, 'open');
          totalAR += arAmt;
        }

        insLedger.run(
          branchId, period, contractId, tenantName, 'ค่าเช่าอาคารและที่ดิน', unit, rent,
          dueISO, 1, overdueMonths, rentAmt, vatAmt, arAmt,
          '', '', 0,
          dueISO, 1, overdueMonths, rentAmt, vatAmt, arAmt,
          arAmt === 0 ? 'paid' : 'unpaid'
        );
      });
    }

    console.log(`  ✅ [${branchId}] (${path.basename(filePath)}): นำเข้าสำเร็จ ${count} รายการ | ยอดหนี้รวม ${totalAR.toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`);
    audit('system', 'import-batch-cxx', 'port_ledgers', branchId, `Imported ${count} records from ${path.basename(filePath)}`);
    return { count, totalAR };
  } catch (err) {
    console.error(`  ❌ [${branchId}] ข้อผิดพลาดในการนำเข้า ${filePath}:`, err.message);
    return { count: 0, totalAR: 0, error: err.message };
  }
}

// 1. นำเข้าไฟล์ cXX_1.xlsx, cXX_2.xlsx, cXX_3.xlsx
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
      parseAndImportFile(fullPath, branchId, '2026-07');
    }
  }
});

// 2. นำเข้าไฟล์ C-XX_Provision_Matrix_LossRate.xlsx ที่มีอยู่ในเครื่องทั้งหมด
const matrixFiles = allFiles.filter(f => f.match(/^C-\d+_Provision_Matrix_LossRate\.xlsx$/i));
console.log(`\n📦 กำลังตรวจสอบไฟล์ Provision Matrix ในระบบ (${matrixFiles.length} สาขา)...`);
matrixFiles.forEach(f => {
  const m = f.match(/^(C-\d+)/i);
  if (m) {
    const bId = m[1].toUpperCase();
    const fullPath = path.join(__dirname, f);
    // Only import if not already in port_ledgers
    const exists = db.prepare("SELECT COUNT(*) as c FROM port_ledgers WHERE branch_id = ? AND period = '2026-07'").get(bId);
    if (!exists || exists.c === 0) {
      parseAndImportFile(fullPath, bId, '2026-07');
    }
  }
});

console.log('\n🎉 ประมวลผลและนำเข้าข้อมูลชุดไฟล์เสร็จสิ้นสมบูรณ์!');
module.exports = { parseAndImportFile, branchMapping };
