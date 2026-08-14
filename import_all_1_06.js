// =========================================================================
//  สคริปต์นำเข้าไฟล์ข้อมูลจริง 17 หน่วยงาน งวดมิถุนายน 2569 (c02_1-06 ถึง c22_1-06)
//  โครงสร้าง: ทะเบียนคุมรายตัว 3 ส่วน (GL Category, ทะเบียน, ค้างยกมา, รับชำระ, ยอดยกไป)
// =========================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { db, audit } = require('./db');

console.log('=================================================================');
console.log('🚀 เริ่มต้นการนำเข้าข้อมูลจริง 17 หน่วยงาน (c02_1-06 ถึง c22_1-06)');
console.log('=================================================================');

// แมปชื่อไฟล์กับรหัสหน่วยงาน C-XX
const branchMapping = {
  'c02': { id: 'C-02', name: 'สำนักงานสะพานปลากรุงเทพ (สป.กท.)' },
  'c03': { id: 'C-03', name: 'สำนักงานสะพานปลาสมุทรปราการ (สป.สป.)' },
  'c04': { id: 'C-04', name: 'สำนักงานสะพานปลาสมุทรสาคร (สป.สค.)' },
  'c07': { id: 'C-07', name: 'สำนักงานท่าเทียบเรือประมงตราด (ทร.ตร.)' },
  'c08': { id: 'C-08', name: 'สำนักงานท่าเทียบเรือประมงอ่างศิลา (ทร.อศ)' },
  'c10': { id: 'C-10', name: 'สำนักงานท่าเทียบเรือประมงหัวหิน (ทร.หห.)' },
  'c12': { id: 'C-12', name: 'สำนักงานท่าเทียบเรือประมงชุมพร (ทร.ชพ.)' },
  'c13': { id: 'C-13', name: 'สำนักงานท่าเทียบเรือประมงหลังสวน (ทร.ลส.)' },
  'c14': { id: 'C-14', name: 'สำนักงานท่าเทียบเรือประมงสุราษฎร์ธานี (ทร.สฎ)' },
  'c15': { id: 'C-15', name: 'สำนักงานสะพานปลานครศรีธรรมราช (สป.นศ.)' },
  'c16': { id: 'C-16', name: 'สำนักงานท่าเทียบเรือประมงสงขลา 1 (ทร.สข.1)' },
  'c17': { id: 'C-17', name: 'สำนักงานท่าเทียบเรือประมงปัตตานี (ทร.ปน.)' },
  'c18': { id: 'C-18', name: 'สำนักงานท่าเทียบเรือประมงนราธิวาส (ทร.นธ.)' },
  'c19': { id: 'C-19', name: 'สำนักงานท่าเทียบเรือประมงระนอง (ทร.รน.)' },
  'c20': { id: 'C-20', name: 'สำนักงานท่าเทียบเรือประมงภูเก็ต (ทร.ภก.)' },
  'c21': { id: 'C-21', name: 'สำนักงานท่าเทียบเรือประมงสตูล (ทร.สต.)' },
  'c22': { id: 'C-22', name: 'สำนักงานท่าเทียบเรือประมงสงขลา 2 (ทร.สข.2)' }
};

function formatOverdueDate(rawVal, fallbackPeriod = '2026-06') {
  if (rawVal === undefined || rawVal === null || rawVal === '') return '';
  const s = String(rawVal).trim();
  if (!s || s === '-' || s === '0') return '';

  // If already contains Thai text (e.g. 1 ส.ค. 67, ศาล, ก.ค.69, ธ.ค.66)
  if (/[ก-๙]/.test(s)) return s;

  // If ISO date
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return s;
  }

  // If Excel serial number
  const num = parseFloat(s);
  if (!isNaN(num) && num >= 36526 && num <= 73050) {
    const utc_days = Math.floor(num - 25569);
    const utc_value = utc_days * 86400;
    const date_info = new Date(utc_value * 1000);
    return date_info.toISOString().slice(0, 10);
  }

  return s;
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

const targetPeriod = '2026-06';
const nextPeriod = '2026-07';

let grandTotalCount = 0;
let grandTotalAR = 0;
const summaryResults = [];

const files = fs.readdirSync(__dirname).filter(f => f.match(/^c\d{2}_1-06\.(xlsx|xls)$/i)).sort();

files.forEach(fileName => {
  const match = fileName.match(/^(c\d{2})_1-06\.(xlsx|xls)$/i);
  if (!match) return;

  const code = match[1].toLowerCase();
  const branchInfo = branchMapping[code] || { id: code.toUpperCase(), name: code.toUpperCase() };
  const branchId = branchInfo.id;
  const fullPath = path.join(__dirname, fileName);

  try {
    const wb = XLSX.readFile(fullPath);
    // Find sheet for June 69
    let sheetName = wb.SheetNames.find(s => s.toLowerCase().includes('มิย') || s.toLowerCase().includes('มิ.ย.') || s.toLowerCase().includes('1-06')) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Clean existing data for this branch for both June and July to ensure clean overwrite
    db.prepare("DELETE FROM port_ledgers WHERE branch_id = ? AND (period = ? OR period = ?)").run(branchId, targetPeriod, nextPeriod);

    let currentCategory = 'ค่าเช่าอาคารและที่ดิน';
    let count = 0;
    let totalAR = 0;

    let headerRowIdx = 3;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const rStr = (rows[i] || []).join(' ');
      if (rStr.includes('ลำดับ') && (rStr.includes('รายชื่อ') || rStr.includes('ผู้เช่า'))) {
        headerRowIdx = i;
        break;
      }
    }

    rows.slice(headerRowIdx + 1).forEach(row => {
      const itemNo = row[0];
      const colB = (row[1] || '').toString().trim();
      const colC = (row[2] || '').toString().trim();
      const rate = parseFloat(row[3]) || 0;
      const overdueFromRaw = row[4];
      const duePeriods = parseInt(row[5]) || 0;
      const overdueAgeMonths = parseInt(row[6]) || 0;
      const arAmount = parseFloat(row[7]) || 0;
      const vatAmount = parseFloat(row[8]) || 0;
      const totalAmount = parseFloat(row[9]) || 0;

      const payDateRaw = row[10];
      const payReceiptNo = (row[11] || '').toString().trim();
      const payAmount = parseFloat(row[12]) || 0;

      const edFromRaw = row[13];
      const edPeriods = parseInt(row[14]) || 0;
      const edMonths = parseInt(row[15]) || 0;
      const edAmount = parseFloat(row[16]) || 0;
      const edVat = parseFloat(row[17]) || 0;
      const edTotal = parseFloat(row[18]) || 0;

      if (!colB) return;

      // Category Header Row
      if (!itemNo && colB && !colB.includes('รวม') && !colB.includes('ทั้งหมด') && arAmount === 0 && totalAmount === 0) {
        currentCategory = colB;
        return;
      }

      // Valid Debtor Row
      const isNumItem = (typeof itemNo === 'number') || (typeof itemNo === 'string' && itemNo.match(/^\d+$/));
      if (isNumItem && colB && !colB.includes('รวม') && !colB.includes('ทั้งหมด') && colB !== '-ไม่มี-') {
        count++;
        const custId = `CU-${branchId.replace('-', '')}-${String(count).padStart(4, '0')}`;
        const contractId = `${branchId}-CT-${String(count).padStart(4, '0')}`;
        const invoiceId = `INV-${branchId.replace('-', '')}-${String(count).padStart(4, '0')}`;

        const bgTot = totalAmount !== 0 ? totalAmount : arAmount;
        const bgAmt = arAmount !== 0 ? arAmount : parseFloat((bgTot / 1.07).toFixed(2));
        const bgVat = vatAmount !== 0 ? vatAmount : parseFloat((bgTot - bgAmt).toFixed(2));

        const paid = payAmount;
        const finalEdTot = edTotal !== 0 ? edTotal : Math.max(0, bgTot - paid);
        const finalEdAmt = edAmount !== 0 ? edAmount : parseFloat((finalEdTot / 1.07).toFixed(2));
        const finalEdVat = edVat !== 0 ? edVat : parseFloat((finalEdTot - finalEdAmt).toFixed(2));

        const bgOverdueFrom = formatOverdueDate(overdueFromRaw, targetPeriod);
        const payDate = formatOverdueDate(payDateRaw, targetPeriod);
        const edOverdueFrom = formatOverdueDate(edFromRaw, targetPeriod) || (finalEdTot > 0 ? bgOverdueFrom : '');

        let status = 'unpaid';
        if (paid >= bgTot && bgTot > 0) status = 'paid';
        else if (paid > 0) status = 'partial';
        else if (bgTot === 0) status = 'paid';

        const fullUnit = colC ? `${currentCategory} (${colC})` : currentCategory;
        insCust.run(custId, colB, '0994000160000', `ส่วนงาน ${branchId} (${fullUnit})`);

        let riskTier = 'ต่ำ';
        if (overdueAgeMonths > 6 || bgTot > 100000) riskTier = 'สูง';
        else if (overdueAgeMonths > 1 || bgTot > 20000) riskTier = 'กลาง';

        insContract.run(contractId, branchId, custId, fullUnit, rate || bgTot, Math.round((rate || bgTot) * 0.07), '2024-01-01', '2027-12-31', 5, bgTot * 2, bgTot * 2, 1.5, riskTier);

        if (bgTot > 0) {
          insInvoice.run(invoiceId, contractId, targetPeriod, '2026-05-25', '2026-06-05', bgAmt, 0, bgVat, bgTot, paid, status);
          totalAR += bgTot;
        }

        // 1. Insert for June 2026
        insLedger.run(
          branchId, targetPeriod, contractId, colB, currentCategory, colC, rate,
          bgOverdueFrom, duePeriods, overdueAgeMonths, bgAmt, bgVat, bgTot,
          payDate, payReceiptNo, paid,
          edOverdueFrom, edPeriods, edMonths, finalEdAmt, finalEdVat, finalEdTot,
          status
        );

        // 2. Insert for July 2026 (Rolled forward from June ending balance)
        insLedger.run(
          branchId, nextPeriod, contractId, colB, currentCategory, colC, rate,
          edOverdueFrom || bgOverdueFrom, edPeriods || duePeriods, (edMonths || overdueAgeMonths) + 1, finalEdAmt, finalEdVat, finalEdTot,
          '', '', 0,
          edOverdueFrom || bgOverdueFrom, edPeriods || duePeriods, (edMonths || overdueAgeMonths) + 1, finalEdAmt, finalEdVat, finalEdTot,
          finalEdTot === 0 ? 'paid' : 'unpaid'
        );
      }
    });

    grandTotalCount += count;
    grandTotalAR += totalAR;
    summaryResults.push({ branchId, name: branchInfo.name, count, totalAR, fileName });
    console.log(`✅ [${branchId}] ${branchInfo.name}: นำเข้าสำเร็จ ${count} รายการ | ยอดหนี้รวม ${totalAR.toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`);
  } catch (err) {
    console.error(`❌ [${branchId}] ข้อผิดพลาดในการนำเข้า ${fileName}:`, err.message);
  }
});

console.log('\n=================================================================');
console.log(`🎉 สรุปผลการนำเข้าข้อมูลจริงครบทั้ง 17 หน่วยงาน:`);
console.log(`   📦 รวมจำนวนลูกหนี้ทั้งหมด: ${grandTotalCount.toLocaleString()} รายการ`);
console.log(`   💰 รวมยอดหนี้ค้างชำระทั้งหมด: ${grandTotalAR.toLocaleString('th-TH', {minimumFractionDigits: 2})} บาท`);
console.log('=================================================================');

audit('system', 'import-all-17-branches', 'port_ledgers', 'ALL', `Imported ${grandTotalCount} records for 17 branches (Total AR = ${grandTotalAR})`);
