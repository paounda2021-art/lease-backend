// สร้างข้อมูลตัวอย่าง (รันครั้งเดียว: node seed.js)
const { db, audit } = require('./db');
const bcrypt = require('bcryptjs');

const ASOF = process.env.SEED_ASOF || '2026-07-14';

// ล้างข้อมูลเดิม
['users','payments','dunning_log','invoices','contracts','customers','audit_log'].forEach(t => db.exec(`DELETE FROM ${t}`));

// สร้างข้อมูลผู้ใช้จำลอง (รหัสผ่านเริ่มต้นคือ password123 สำหรับทุกบัญชี)
const mockUsers = [
  ['U-001', 'admin', bcrypt.hashSync('password123', 10), 'admin', 'สมชาย แอดมิน'],
  ['U-002', 'billing', bcrypt.hashSync('password123', 10), 'billing', 'วรรณา ฝ่ายวางบิล'],
  ['U-003', 'cashier', bcrypt.hashSync('password123', 10), 'cashier', 'สมศรี ฝ่ายการเงิน'],
  ['U-004', 'manager', bcrypt.hashSync('password123', 10), 'manager', 'เดชา ผู้จัดการฝ่ายการเงิน']
];
const uins = db.prepare('INSERT INTO users(id,username,password,role,fullname) VALUES(?,?,?,?,?)');
mockUsers.forEach(u => uins.run(...u));

const customers = [
  ['CU-001','บจก. สยาม เทรดดิ้ง','0105551234567','123 ถ.สุขุมวิท กทม.'],
  ['CU-002','บจก. โฟกัส ลอจิสติกส์','0105557654321','88 ถ.บางนา กทม.'],
  ['CU-003','ร้าน มณีจันทร์','1103700111222','45 ตลาดสด จ.นนทบุรี'],
  ['CU-004','บจก. เอเวอร์กรีน ฟู้ดส์','0105548889990','9 นิคมอุตสาหกรรม จ.ชลบุรี'],
  ['CU-005','หจก. บ้านสวนค้าไม้','0993000445566','77 ถ.รังสิต จ.ปทุมธานี'],
  ['CU-006','บจก. ทีเค อิเล็กทรอนิกส์','0105560223344','12 ถ.พหลโยธิน กทม.'],
];
const cins = db.prepare('INSERT INTO customers(id,name,tax_id,address) VALUES(?,?,?,?)');
customers.forEach(c => cins.run(...c));

// [id, cust, unit, rent, service, start, end, dueDay, deposit, penalty, risk, stoppedMonthsAgo]
const contracts = [
  ['C-001','CU-001','A-101',100000,30000,'2024-01-01','2026-12-31',5,300000,1.5,'ต่ำ',0],
  ['C-002','CU-002','B-205',75000,15000,'2024-06-01','2027-05-31',5,180000,1.5,'กลาง',2],
  ['C-003','CU-003','G-12',45000,8000,'2023-03-01','2026-02-28',10,106000,2,'สูง',5],
  ['C-004','CU-004','A-210',220000,60000,'2022-01-01','2026-12-31',1,560000,1.5,'สูง',8],
  ['C-005','CU-005','W-03',30000,5000,'2024-09-01','2027-08-31',15,70000,2,'กลาง',1],
  ['C-006','CU-006','B-110',60000,12000,'2023-07-01','2026-06-30',5,144000,1.5,'ต่ำ',0],
];
const coins = db.prepare(`INSERT INTO contracts
  (id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`);
const iins = db.prepare(`INSERT INTO invoices
  (id,contract_id,period,issue_date,due_date,rent_amt,service_amt,vat_amt,total,paid,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);

const asof = new Date(ASOF + 'T00:00:00');
function monthsBack(due) { return (asof.getFullYear() - due.getFullYear()) * 12 + (asof.getMonth() - due.getMonth()); }

let totalInv = 0;
contracts.forEach(c => {
  const [id,cust,unit,rent,service,start,end,dueDay,deposit,penalty,risk,stopped] = c;
  coins.run(id,cust,unit,rent,service,start,end,dueDay,deposit,deposit,penalty,risk);
  let d = new Date(start + 'T00:00:00'); let seq = 0;
  while (d <= asof) {
    seq++;
    const due = new Date(d.getFullYear(), d.getMonth(), dueDay);
    const period = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const issue = new Date(d.getFullYear(), d.getMonth() - 1, 25).toISOString().slice(0, 10);
    const vat = service * 0.07; const total = rent + service + vat;
    const ov = monthsBack(due);
    // หยุดจ่าย stopped เดือนก่อน → งวดล่าสุด (ov < stopped) ค้าง, งวดเก่าจ่ายแล้ว
    const unpaid = ov < stopped;
    const paid = unpaid ? 0 : total;
    const status = unpaid ? 'open' : 'paid';
    iins.run(id + '-' + String(seq).padStart(3, '0'), id, period, issue, due.toISOString().slice(0, 10),
             rent, service, vat, total, paid, status);
    totalInv++;
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
});
audit('seed', 'seed', 'system', ASOF, `${customers.length} customers, ${contracts.length} contracts, ${totalInv} invoices`);
console.log(`Seeded: ${customers.length} customers, ${contracts.length} contracts, ${totalInv} invoices (as of ${ASOF})`);
