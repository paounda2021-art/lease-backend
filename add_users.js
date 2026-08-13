// ===========================================================
//  add_users.js — เพิ่มและอัปเดตผู้ใช้งานจริง 8 ท่านลงฐานข้อมูล
// ===========================================================
const { db } = require('./db');
const bcrypt = require('bcryptjs');

const users = [
  // Viewers (3 ท่าน)
  ['preeda.y@fishmarket.co.th', 'preeda.y', 'password123', 'viewer', 'นายปรีดา ยังสุขสถาพร (ผอ.)'],
  ['supbhachart.c@fishmarket.co.th', 'supbhachart.c', '07170184', 'viewer', 'นายศุภชาติ ชาสมบัติ (รองผู้อำนวยการด้านบริหาร)'],
  ['thanachai.c@fishmarket.co.th', 'thanachai.c', '07170078', 'viewer', 'นายธนชัย ฉายศรี (เจ้าหน้าที่ตรวจสอบภายใน)'],
  
  // Admins (5 ท่าน)
  ['jiraporn.p@fishmarket.co.th', 'jiraporn.p', '07170164', 'admin', 'น.ส.จิราพร พงษ์ศิริ (หัวหน้าสำนักงาน)'],
  ['jareelak.m@fishmarket.co.th', 'jareelak.m', '07170041', 'admin', 'น.ส.จรีลักษณ์ เมืองอุดม (เจ้าหน้าที่การเงินและบัญชี)'],
  ['jittamas.p@fishmarket.co.th', 'jittamas.p', '07170167', 'admin', 'น.ส.จิตทามาศ ผลงาม (เจ้าหน้าที่บริหารงานทั่วไป)'],
  ['natmethinee.c@fishmarket.co.th', 'natmethinee.c', '07170146', 'admin', 'น.ส.ณัฏฐ์เมธินี จงสัจจา (เจ้าหน้าที่การเงินและบัญชี)'],
  ['ranida.c@fishmarket.co.th', 'ranida.c', '07170065', 'admin', 'น.ส.รณิดา โชติธนาอุดม (Admin System)']
];

let added = 0;
let seq = db.prepare('SELECT COUNT(*) c FROM users').get().c;

users.forEach(([email, shortName, pass, role, fullname]) => {
  const hash = bcrypt.hashSync(pass, 10);
  
  // ลบชื่อเดิมถ้ามีอยู่แล้ว เพื่อป้องกัน duplicate key error
  db.prepare('DELETE FROM users WHERE LOWER(username) = LOWER(?)').run(email);
  seq++;
  db.prepare('INSERT INTO users(id, username, password, role, fullname, branch_id) VALUES(?,?,?,?,?,NULL)')
    .run('U-' + String(seq).padStart(3, '0'), email, hash, role, fullname);
  added++;

  db.prepare('DELETE FROM users WHERE LOWER(username) = LOWER(?)').run(shortName);
  seq++;
  db.prepare('INSERT INTO users(id, username, password, role, fullname, branch_id) VALUES(?,?,?,?,?,NULL)')
    .run('U-' + String(seq).padStart(3, '0'), shortName, hash, role, fullname);
  added++;
});

console.log(`✅ Successfully inserted/updated ${users.length} official users (${added} account handles) in SQLite database!`);
