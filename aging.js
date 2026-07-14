// ตรรกะการจัดชั้นอายุหนี้ (aging) และการตั้งสำรอง (provision)
const BUCKETS = [
  { key: 'cur', label: 'ยังไม่ครบกำหนด', min: -Infinity, max: 0 },
  { key: 'b1',  label: '1–30 วัน',       min: 1,   max: 30 },
  { key: 'b2',  label: '31–60 วัน',      min: 31,  max: 60 },
  { key: 'b3',  label: '61–90 วัน',      min: 61,  max: 90 },
  { key: 'b4',  label: '91–180 วัน',     min: 91,  max: 180 },
  { key: 'b5',  label: '181–365 วัน',    min: 181, max: 365 },
  { key: 'b6',  label: 'เกิน 365 วัน',    min: 366, max: Infinity },
];

function daysOverdue(dueDate, asOf) {
  const d = (new Date(asOf + 'T00:00:00') - new Date(dueDate + 'T00:00:00')) / 86400000;
  return Math.round(d);
}
function bucketOf(dueDate, asOf) {
  const d = daysOverdue(dueDate, asOf);
  return BUCKETS.find(b => d >= b.min && d <= b.max);
}
function outstanding(inv) { return (inv.total || 0) - (inv.paid || 0); }

// จัดชั้น 186 ตามยอดหนี้รวมต่อราย
function tier186(debt) {
  if (debt > 2000000) return { key: 'gt2m', label: '>2 ล้าน: ต้องฟ้อง+บังคับคดีไม่มีทรัพย์' };
  if (debt >= 200000) return { key: '200k-2m', label: '2แสน–2ล้าน: ศาลรับฟ้องก็ตัดได้' };
  return { key: 'lt200k', label: '≤2แสน: ทวง≥2ครั้ง+กรรมการอนุมัติ' };
}

// การกระทำที่แนะนำตามอายุหนี้
function recommendedAction(inv, asOf, debtTotal) {
  if (inv.written_off) return { code: 'wo', text: 'ตัดหนี้สูญแล้ว' };
  if (inv.litigation)  return { code: 'lit', text: 'อยู่ระหว่างฟ้อง/บังคับคดี' };
  const d = daysOverdue(inv.due_date, asOf);
  if (d <= 0)  return { code: 'ok',   text: 'ปกติ' };
  if (d <= 7)  return { code: 'call', text: 'โทรติดตาม' };
  if (d <= 15) return { code: 'pen',  text: 'เริ่มคิดค่าปรับ' };
  if (d <= 30) return { code: 'l1',   text: 'หนังสือทวง #1' };
  if (d <= 45) return { code: 'l2',   text: 'หนังสือทวง #2 + เตือนบอกเลิก' };
  if (d <= 60) return { code: 'legal',text: 'ส่งฝ่ายกฎหมาย/ริบประกัน' };
  if (d <= 90) return { code: 'demand',text: 'ทนายออกหนังสือก่อนฟ้อง' };
  return { code: 'sue', text: 'ยื่นฟ้อง (' + tier186(debtTotal).label + ')' };
}

module.exports = { BUCKETS, daysOverdue, bucketOf, outstanding, tier186, recommendedAction };
