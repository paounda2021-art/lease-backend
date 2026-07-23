const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.match(/^C-\d+_Provision_Matrix_LossRate\.xlsx$/));
console.log('Found Excel files:', files.length);

let grandTotalAR = 0;
let grandTotalContracts = 0;
let grandTotalInvoices = 0;

files.sort().forEach(f => {
  const match = f.match(/^(C-\d+)/);
  const branchId = match[1];
  const wb = XLSX.readFile(path.join(__dirname, f));
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
  
  let validRows = 0, arRows = 0, totalAR = 0;
  json.slice(6).forEach(r => {
    const tenant = (r[1] || '').toString().trim();
    const unit = (r[2] || '').toString().trim();
    const ar = parseFloat(r[4]) || 0;
    if (tenant && unit) {
      validRows++;
      if (ar > 0) {
        arRows++;
        totalAR += ar;
      }
    }
  });
  grandTotalContracts += validRows;
  grandTotalInvoices += arRows;
  grandTotalAR += totalAR;
  console.log(`${branchId.padEnd(5)} | Sheet: ${sheetName.padEnd(30)} | Contracts: ${String(validRows).padStart(4)} | Unpaid AR Invoices: ${String(arRows).padStart(3)} | Total AR: ${totalAR.toLocaleString('th-TH', {minimumFractionDigits:2})} THB`);
});

console.log('-----------------------------------------------------------------------------------------');
console.log(`GRAND TOTAL: ${files.length} Branches | Contracts: ${grandTotalContracts} | AR Invoices: ${grandTotalInvoices} | Total AR: ${grandTotalAR.toLocaleString('th-TH', {minimumFractionDigits:2})} THB`);
