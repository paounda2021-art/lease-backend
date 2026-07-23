const XLSX = require('xlsx');
const { db, audit } = require('./db');
const path = require('path');

const excelPath = path.join(__dirname, 'C-02_Provision_Matrix_LossRate.xlsx');
console.log('Reading Excel dataset:', excelPath);

const wb = XLSX.readFile(excelPath);
const ws = wb.Sheets[wb.SheetNames[0]];
const json = XLSX.utils.sheet_to_json(ws, { header: 1 });

// Helper: Excel serial date to YYYY-MM-DD
function excelDateToISO(serial) {
  if (!serial || isNaN(serial)) return '2026-06-25';
  const utc_days  = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;                                             
  const date_info = new Date(utc_value * 1000);
  return date_info.toISOString().slice(0, 10);
}

// 1. Clean existing C-02 contracts and invoices
const oldContracts = db.prepare("SELECT id FROM contracts WHERE branch_id='C-02'").all();
oldContracts.forEach(c => {
  db.prepare("DELETE FROM invoices WHERE contract_id=?").run(c.id);
});
db.prepare("DELETE FROM contracts WHERE branch_id='C-02'").run();

const insCust = db.prepare("INSERT OR IGNORE INTO customers(id,name,tax_id,address) VALUES(?,?,?,?)");
const insContract = db.prepare(`INSERT INTO contracts
  (id,branch_id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
const insInvoice = db.prepare(`INSERT INTO invoices
  (id,contract_id,period,issue_date,due_date,rent_amt,service_amt,vat_amt,total,paid,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);

let contractSeq = 0, invSeq = 0, totalImportedAR = 0;

json.slice(6).forEach((row) => {
  const invCode = row[0];
  const tenantName = (row[1] || '').toString().trim();
  const unit = (row[2] || '').toString().trim();
  const rent = parseFloat(row[3]) || 0;
  const arAmt = parseFloat(row[4]) || 0;
  const dueSerial = row[5];
  const daysOverdue = parseInt(row[6]) || 0;
  const bucketLabel = (row[8] || '').toString().trim();

  if (!tenantName || !unit) return;

  contractSeq++;
  const custId = 'CU-C02-' + String(contractSeq).padStart(3, '0');
  const contractId = 'C02-CT-' + String(contractSeq).padStart(3, '0');

  insCust.run(custId, tenantName, '01055' + String(1000000 + contractSeq), 'สำนักงานสะพานปลากรุงเทพ');

  let riskTier = 'ต่ำ';
  if (arAmt > 200000 || daysOverdue > 90) riskTier = 'สูง';
  else if (arAmt > 30000 || daysOverdue > 30) riskTier = 'กลาง';

  insContract.run(contractId, 'C-02', custId, unit, rent, Math.round(rent * 0.1), '2024-01-01', '2027-12-31', 5, rent * 3, rent * 3, 1.5, riskTier);

  if (arAmt > 0) {
    invSeq++;
    const dueISO = excelDateToISO(dueSerial);
    const issueISO = '2026-05-25';
    const period = dueISO.slice(0, 7);
    const invoiceId = invCode || ('INV-C02-' + String(invSeq).padStart(4, '0'));
    
    const rentAmt = Math.round((arAmt / 1.07) * 100) / 100;
    const vatAmt = Math.round((arAmt - rentAmt) * 100) / 100;

    insInvoice.run(invoiceId, contractId, period, issueISO, dueISO, rentAmt, 0, vatAmt, arAmt, 0, 'open');
    totalImportedAR += arAmt;
  }
});

audit('system', 'import-excel', 'branch', 'C-02', `Imported ${contractSeq} contracts, ${invSeq} invoices, total AR = ${totalImportedAR}`);
console.log(`✅ Successfully imported Excel dataset for C-02 (สำนักงานสะพานปลากรุงเทพ):`);
console.log(`   - Contracts: ${contractSeq}`);
console.log(`   - Unpaid Invoices: ${invSeq}`);
console.log(`   - Total AR Outstanding: ${totalImportedAR.toLocaleString('th-TH')} THB`);
