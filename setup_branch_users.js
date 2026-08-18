const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('lease.db');
const bcrypt = require('bcryptjs');

const branchMapping = {
  'user02': { id: 'C-02', name: 'สป.กท.' },
  'user03': { id: 'C-03', name: 'สป.สป.' },
  'user04': { id: 'C-04', name: 'สป.สค.' },
  'user07': { id: 'C-07', name: 'ทร.ตร.' },
  'user08': { id: 'C-08', name: 'ทร.อศ' },
  'user10': { id: 'C-10', name: 'ทร.หห.' },
  'user12': { id: 'C-12', name: 'ทร.ชพ.' },
  'user13': { id: 'C-13', name: 'ทร.ลส.' },
  'user14': { id: 'C-14', name: 'ทร.สฎ' },
  'user15': { id: 'C-15', name: 'สป.นศ.' },
  'user16': { id: 'C-16', name: 'ทร.สข.1' },
  'user17': { id: 'C-17', name: 'ทร.ปน.' },
  'user18': { id: 'C-18', name: 'ทร.นธ.' },
  'user19': { id: 'C-19', name: 'ทร.รน.' },
  'user20': { id: 'C-20', name: 'ทร.ภก.' },
  'user21': { id: 'C-21', name: 'ทร.สต.' },
  'user22': { id: 'C-22', name: 'ทร.สข.2' }
};

const insUser = db.prepare("INSERT OR REPLACE INTO users (id, username, password, role, fullname, branch_id) VALUES (?, ?, ?, ?, ?, ?)");

for (const [username, branch] of Object.entries(branchMapping)) {
  const passwordHash = bcrypt.hashSync('password123', 10);
  const userId = `U-${branch.id.replace('C-', '')}`;
  insUser.run(userId, username, passwordHash, 'branch', `จนท. ${branch.name}`, branch.id);
  console.log(`Created ${username} for ${branch.id}`);
}

console.log("Done adding branch users.");
