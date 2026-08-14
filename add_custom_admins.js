const { db } = require('./db');
const bcrypt = require('bcryptjs');

const users = [
  ['admin1', 'admin1', 'admin', 'น.ส.ณัฏฐ์เมธินี จงสัจจา'],
  ['admin2', 'admin2', 'admin', 'น.ส.จิราพร พงษ์ศิริ'],
  ['admin3', 'admin3', 'admin', 'Admin System']
];

let seq = db.prepare('SELECT COUNT(*) c FROM users').get().c;

users.forEach(([username, pass, role, fullname]) => {
  const hash = bcrypt.hashSync(pass, 10);
  
  // ลบถ้ามีอยู่แล้ว
  db.prepare('DELETE FROM users WHERE username = ?').run(username);
  seq++;
  
  // เพิ่มเข้าฐานข้อมูล
  db.prepare('INSERT INTO users(id, username, password, role, fullname, branch_id) VALUES(?,?,?,?,?,NULL)')
    .run('U-ADM-' + String(seq).padStart(3, '0'), username, hash, role, fullname);
});

console.log(`✅ เพิ่ม ${users.length} admins เรียบร้อยแล้ว`);
