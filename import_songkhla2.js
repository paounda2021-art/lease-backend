const XLSX = require('xlsx');
const path = require('path');
const { db, audit } = require('./db');

console.log('========================================');
console.log('Importing Songkhla 2 Exact GL Categories (1.ข้อมูลท่า สงขลา 2.xlsx)');
console.log('========================================');

const wb = XLSX.readFile(path.join(__dirname, '1.ข้อมูลท่า สงขลา 2.xlsx'));
const sheet = wb.Sheets['กค.69'];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

const branchId = 'C-22';
const branchName = 'สำนักงานท่าเทียบเรือประมงสงขลา 2 (ท่าสะอ้าน)';

let currentCategory = 'ค่าเช่าอาคารและที่ดิน';
let count = 0;
let totalAR = 0;

const insCust = db.prepare("INSERT OR IGNORE INTO customers(id,name,tax_id,address) VALUES(?,?,?,?)");
const insContract = db.prepare(`INSERT OR REPLACE INTO contracts
  (id,branch_id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
const insInvoice = db.prepare(`INSERT OR REPLACE INTO invoices
  (id,contract_id,period,issue_date,due_date,rent_amt,service_amt,vat_amt,total,paid,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);

rows.slice(3).forEach((row, index) => {
  const itemNo = row[0];
  const colB = (row[1] || '').toString().trim();
  const colC = (row[2] || '').toString().trim();
  const rate = parseFloat(row[3]) || 0;
  const overdueFrom = (row[4] || '').toString().trim();
  const duePeriods = parseInt(row[5]) || 1;
  const overdueAgeMonths = parseInt(row[6]) || 0;
  const arAmount = parseFloat(row[7]) || 0;
  const vatAmount = parseFloat(row[8]) || 0;
  const totalAmount = parseFloat(row[9]) || 0;

  if (!colB) return;

  // Category Header Row
  if (!itemNo && colB && !colB.includes('รวม') && arAmount === 0 && totalAmount === 0) {
    currentCategory = colB;
    return;
  }

  // Row with actual debtor data
  if (typeof itemNo === 'number' && colB && colB !== 'รวม') {
    count++;
    const custId = `CU-C22-${String(count).padStart(3, '0')}`;
    const contractId = `C-22-CT-${String(count).padStart(3, '0')}`;
    const invoiceId = `INV-C22-${String(count).padStart(3, '0')}`;

    const effectiveTotal = totalAmount > 0 ? totalAmount : arAmount;
    // Combine category name with specific detail (location / meter / car plate)
    const categoryName = currentCategory || 'ค่าเช่าอาคารและที่ดิน';
    const fullUnitName = colC ? `${categoryName} (${colC})` : categoryName;

    // Insert Customer
    insCust.run(custId, colB, '0994000160000', `สำนักงานท่าเทียบเรือประมงสงขลา 2 (${fullUnitName})`);

    // Risk tier based on overdue age
    let riskTier = 'ต่ำ';
    if (overdueAgeMonths > 6 || effectiveTotal > 100000) riskTier = 'สูง';
    else if (overdueAgeMonths > 1 || effectiveTotal > 20000) riskTier = 'กลาง';

    // Insert Contract
    insContract.run(
      contractId, branchId, custId, fullUnitName, rate || effectiveTotal, 
      Math.round((rate || effectiveTotal) * 0.07), '2025-01-01', '2027-12-31', 
      5, effectiveTotal * 2, effectiveTotal * 2, 1.5, riskTier
    );

    // Insert Invoice if there is outstanding AR
    if (effectiveTotal > 0) {
      const issueDate = '2026-06-25';
      const dueDate = '2026-07-05';
      const period = '2026-07';
      const rentAmt = parseFloat((effectiveTotal / 1.07).toFixed(2));
      const vatAmt = parseFloat((effectiveTotal - rentAmt).toFixed(2));

      insInvoice.run(invoiceId, contractId, period, issueDate, dueDate, rentAmt, 0, vatAmt, effectiveTotal, 0, 'open');
      totalAR += effectiveTotal;
    }
  }
});

audit('system', 'import-songkhla2-exact', 'branch', branchId, `Imported ${count} exact GL category debtors from 1.ข้อมูลท่า สงขลา 2.xlsx with total AR = ${totalAR}`);
console.log(`✅ [${branchId}] ${branchName}: Imported ${count} debtors with exact GL categories, Total AR = ${totalAR.toLocaleString('th-TH', {minimumFractionDigits:2})} THB`);
