const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { db, audit } = require('./db');

console.log('===========================================================');
console.log('Starting Batch Processing & Data Import for All Branch Excel Files');
console.log('===========================================================');

const files = fs.readdirSync(__dirname).filter(f => f.match(/^C-\d+_Provision_Matrix_LossRate\.xlsx$/));
files.sort();

function excelDateToISO(serial) {
  if (!serial || isNaN(serial)) return '2026-06-25';
  const utc_days  = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;                                             
  const date_info = new Date(utc_value * 1000);
  return date_info.toISOString().slice(0, 10);
}

const insCust = db.prepare("INSERT OR IGNORE INTO customers(id,name,tax_id,address) VALUES(?,?,?,?)");
const insContract = db.prepare(`INSERT INTO contracts
  (id,branch_id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
const insInvoice = db.prepare(`INSERT INTO invoices
  (id,contract_id,period,issue_date,due_date,rent_amt,service_amt,vat_amt,total,paid,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);

let grandContracts = 0, grandInvoices = 0, grandAR = 0;

files.forEach(f => {
  const match = f.match(/^(C-\d+)/);
  const branchId = match[1];
  const branchRow = db.prepare("SELECT name FROM branches WHERE id=?").get(branchId);
  const branchName = branchRow ? branchRow.name : branchId;

  // 1. Clean existing records for this branch
  const oldContracts = db.prepare("SELECT id FROM contracts WHERE branch_id=?").all(branchId);
  oldContracts.forEach(c => {
    db.prepare("DELETE FROM invoices WHERE contract_id=?").run(c.id);
  });
  db.prepare("DELETE FROM contracts WHERE branch_id=?").run(branchId);

  // 2. Parse Excel
  const wb = XLSX.readFile(path.join(__dirname, f));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { header: 1 });

  let contractSeq = 0, invSeq = 0, branchAR = 0;

  json.slice(6).forEach(row => {
    const invCode = row[0];
    const tenantName = (row[1] || '').toString().trim();
    const unit = (row[2] || '').toString().trim();
    const rent = parseFloat(row[3]) || 0;
    const arAmt = parseFloat(row[4]) || 0;
    const dueSerial = row[5];
    const daysOverdue = parseInt(row[6]) || 0;

    if (!tenantName || !unit) return;

    contractSeq++;
    const numPart = String(contractSeq).padStart(4, '0');
    const custId = `CU-${branchId.replace('-', '')}-${numPart}`;
    const contractId = `${branchId}-CT-${numPart}`;

    insCust.run(custId, tenantName, '01055' + String(1000000 + contractSeq), branchName);

    let riskTier = 'ต่ำ';
    if (arAmt > 200000 || daysOverdue > 90) riskTier = 'สูง';
    else if (arAmt > 30000 || daysOverdue > 30) riskTier = 'กลาง';

    insContract.run(contractId, branchId, custId, unit, rent, Math.round(rent * 0.1), '2024-01-01', '2027-12-31', 5, rent * 3, rent * 3, 1.5, riskTier);

    if (arAmt > 0) {
      invSeq++;
      const dueISO = excelDateToISO(dueSerial);
      const issueISO = '2026-05-25';
      const period = dueISO.slice(0, 7);
      const invoiceId = invCode ? String(invCode).trim() : `INV-${branchId.replace('-', '')}-${String(invSeq).padStart(4, '0')}`;

      const rentAmt = Math.round((arAmt / 1.07) * 100) / 100;
      const vatAmt = Math.round((arAmt - rentAmt) * 100) / 100;

      insInvoice.run(invoiceId, contractId, period, issueISO, dueISO, rentAmt, 0, vatAmt, arAmt, 0, 'open');
      branchAR += arAmt;
    }
  });

  grandContracts += contractSeq;
  grandInvoices += invSeq;
  grandAR += branchAR;

  audit('system', 'import-excel', 'branch', branchId, `Imported ${contractSeq} contracts, ${invSeq} invoices, total AR = ${branchAR}`);
  console.log(`✅ [${branchId.padEnd(5)}] ${branchName.padEnd(45)} | Contracts: ${String(contractSeq).padStart(4)} | AR Invoices: ${String(invSeq).padStart(3)} | Total AR: ${branchAR.toLocaleString('th-TH', {minimumFractionDigits:2})} THB`);
});

console.log('===========================================================');
console.log(`🎉 Batch import completed successfully for ${files.length} branches!`);
console.log(`   - Total Contracts Imported: ${grandContracts.toLocaleString()} รายการ`);
console.log(`   - Total AR Invoices Imported: ${grandInvoices.toLocaleString()} รายการ`);
console.log(`   - Grand Total Outstanding AR: ${grandAR.toLocaleString('th-TH', {minimumFractionDigits:2})} THB`);
console.log('===========================================================');
