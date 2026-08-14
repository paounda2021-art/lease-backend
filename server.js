// ===========================================================
//  ระบบติดตามหนี้เช่า — REST API Server (Express + node:sqlite)
//  ยกระดับระบบรักษาความปลอดภัย JWT + Role-Based Access Control
// ===========================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { db, audit } = require('./db');
const A = require('./aging');
const { generateToken, authenticateToken, requireRole } = require('./auth');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const today = () => new Date().toISOString().slice(0, 10);

// ---------- helpers ----------
function invWithContract(branchId) {
  let sql = `
    SELECT i.*, c.customer_id, c.branch_id, c.deposit_balance, c.risk_tier, 
           cu.name AS tenant, cu.address, cu.tax_id, c.unit, b.name AS branch_name
    FROM invoices i
    JOIN contracts c ON c.id = i.contract_id
    JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN branches b ON b.id = c.branch_id`;
  
  if (branchId && branchId !== 'all') {
    sql += ` WHERE c.branch_id = ?`;
    return db.prepare(sql).all(branchId);
  }
  return db.prepare(sql).all();
}

function debtorTotals(branchId) {
  let sql = `
    SELECT i.contract_id, SUM(i.total - i.paid) AS debt
    FROM invoices i
    JOIN contracts c ON c.id = i.contract_id
    WHERE i.written_off = 0 AND (i.total - i.paid) > 0`;
  
  let rows;
  if (branchId && branchId !== 'all') {
    sql += ` AND c.branch_id = ? GROUP BY i.contract_id`;
    rows = db.prepare(sql).all(branchId);
  } else {
    sql += ` GROUP BY i.contract_id`;
    rows = db.prepare(sql).all();
  }
  const m = {};
  rows.forEach(r => m[r.contract_id] = r.debt);
  return m;
}

function rateMap() {
  const m = {};
  db.prepare('SELECT * FROM provision_rates').all().forEach(r => m[r.bucket_key] = r.rate_pct);
  return m;
}

// ========== BRANCHES (17 หน่วยงาน) ==========
app.get('/api/branches', authenticateToken, (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const rates = rateMap();
    const branches = db.prepare('SELECT * FROM branches ORDER BY id').all();
    const invs = invWithContract();

    const branchMap = {};
    branches.forEach(b => {
      branchMap[b.id] = {
        ...b,
        contractCount: 0,
        totalAR: 0,
        overdue: 0,
        overduePct: 0,
        provision: 0,
        riskLevel: 'ปกติ'
      };
    });

    // นับจำนวนสัญญาต่อส่วนงาน
    const contractCounts = db.prepare("SELECT branch_id, COUNT(*) AS c FROM contracts WHERE status='active' GROUP BY branch_id").all();
    contractCounts.forEach(r => {
      if (r.branch_id && branchMap[r.branch_id]) {
        branchMap[r.branch_id].contractCount = r.c;
      }
    });

    // คำนวณ AR และ Overdue รายส่วนงาน
    invs.forEach(i => {
      if (!i.branch_id || !branchMap[i.branch_id]) return;
      const out = A.outstanding(i);
      if (i.written_off) return;
      if (out > 0) {
        branchMap[i.branch_id].totalAR += out;
        const b = A.bucketOf(i.due_date, asOf);
        if (b) {
          if (b.key !== 'cur') {
            branchMap[i.branch_id].overdue += out;
          }
          branchMap[i.branch_id].provision += out * (rates[b.key] || 0) / 100;
        }
      }
    });

    const result = Object.values(branchMap).map(b => {
      const pct = b.totalAR > 0 ? (b.overdue / b.totalAR) * 100 : 0;
      let riskLevel = 'ปกติ';
      if (pct > 50 || b.overdue > 200000) riskLevel = 'เสี่ยงสูง';
      else if (pct > 20 || b.overdue > 50000) riskLevel = 'เฝ้าระวัง';
      return {
        ...b,
        overduePct: Math.round(pct * 10) / 10,
        riskLevel
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== AUTHENTICATION ==========
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน' });
    }

    const cleanUser = (username || '').trim().toLowerCase();
    const shortUser = cleanUser.split('@')[0];
    const emailUser = cleanUser.includes('@') ? cleanUser : cleanUser + '@fishmarket.co.th';
    
    const user = db.prepare(`
      SELECT * FROM users 
      WHERE LOWER(username) = ? 
         OR LOWER(username) = ? 
         OR LOWER(username) = ?
    `).get(cleanUser, emailUser, shortUser);
    if (!user) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
    }

    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
    }

    const token = generateToken(user);
    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullname: user.fullname,
        branch_id: user.branch_id
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ: ' + err.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ========== CONTRACTS ==========
app.get('/api/contracts', authenticateToken, (req, res) => {
  try {
    const branchId = req.query.branch_id;
    let sql = `
      SELECT c.*, cu.name AS tenant, cu.tax_id, b.name AS branch_name
      FROM contracts c
      JOIN customers cu ON cu.id = c.customer_id
      LEFT JOIN branches b ON b.id = c.branch_id`;
    
    let rows;
    if (branchId && branchId !== 'all') {
      sql += ` WHERE c.branch_id = ? ORDER BY c.id`;
      rows = db.prepare(sql).all(branchId);
    } else {
      sql += ` ORDER BY c.id`;
      rows = db.prepare(sql).all();
    }
    const debt = debtorTotals(branchId);
    res.json(rows.map(r => ({ ...r, outstanding: debt[r.id] || 0 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contracts', authenticateToken, requireRole('billing'), (req, res) => {
  try {
    const b = req.body;
    const id = b.id || ('C-' + String(Date.now()).slice(-6));
    const custId = 'CU-' + id.replace(/^C-/, '');
    
    const tx = db.prepare('SELECT id FROM customers WHERE id=?').get(custId);
    if (!tx) {
      db.prepare('INSERT INTO customers(id,name,tax_id,address,authorized_person) VALUES(?,?,?,?,?)')
        .run(custId, b.tenant || '', b.tax_id || '', b.address || '', b.authorized_person || '');
    } else {
      db.prepare('UPDATE customers SET name=?,tax_id=? WHERE id=?').run(b.tenant || '', b.tax_id || '', custId);
    }
    
    db.prepare(`INSERT INTO contracts
      (id,branch_id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, b.branch_id || 'BR-001', custId, b.unit || '', +b.rent_monthly || 0, +b.service_monthly || 0, b.start_date, b.end_date,
           +b.due_day || 5, +b.deposit || 0, +b.deposit || 0, +b.penalty_rate || 1.5, b.risk_tier || 'ต่ำ', b.stamp_duty_paid ? 1 : 0);
    
    audit(req.user.username, 'create', 'contract', id, JSON.stringify(b));
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contracts/:id', authenticateToken, requireRole('billing'), (req, res) => {
  try {
    const b = req.body, id = req.params.id;
    const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
    if (!c) return res.status(404).json({ error: 'ไม่พบสัญญาเช่าที่ระบุ' });
    
    db.prepare(`UPDATE contracts SET branch_id=?,unit=?,rent_monthly=?,service_monthly=?,start_date=?,end_date=?,
      due_day=?,deposit=?,penalty_rate=?,risk_tier=?,stamp_duty_paid=? WHERE id=?`)
      .run(b.branch_id || c.branch_id, b.unit, +b.rent_monthly || 0, +b.service_monthly || 0, b.start_date, b.end_date,
           +b.due_day || 5, +b.deposit || 0, +b.penalty_rate || 1.5, b.risk_tier, b.stamp_duty_paid ? 1 : 0, id);
    
    if (b.tenant) {
      db.prepare('UPDATE customers SET name=?,tax_id=? WHERE id=?').run(b.tenant, b.tax_id || '', c.customer_id);
    }
    
    audit(req.user.username, 'update', 'contract', id, JSON.stringify(b));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contracts/:id', authenticateToken, requireRole('billing'), (req, res) => {
  try {
    const id = req.params.id;
    db.prepare('DELETE FROM invoices WHERE contract_id=?').run(id);
    db.prepare('DELETE FROM contracts WHERE id=?').run(id);
    
    audit(req.user.username, 'delete', 'contract', id, '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== INVOICES ==========
app.get('/api/invoices', authenticateToken, (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const branchId = req.query.branch_id;
    const debt = debtorTotals(branchId);
    let rows = invWithContract(branchId);
    
    rows = rows.map(i => {
      const b = A.bucketOf(i.due_date, asOf);
      const out = A.outstanding(i);
      return { 
        ...i, 
        outstanding: out, 
        days_overdue: A.daysOverdue(i.due_date, asOf),
        bucket: b ? b.key : null, 
        bucket_label: b ? b.label : '',
        action: A.recommendedAction(i, asOf, debt[i.contract_id] || 0) 
      };
    });
    
    const f = req.query.filter;
    if (f === 'open') rows = rows.filter(i => i.outstanding > 0 && !i.written_off);
    if (f === 'overdue') rows = rows.filter(i => i.days_overdue > 0 && i.outstanding > 0 && !i.written_off);
    if (f === 'litig') rows = rows.filter(i => i.litigation);
    if (f === 'wo') rows = rows.filter(i => i.written_off);
    
    rows.sort((a, b) => a.due_date < b.due_date ? 1 : -1);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// สร้างใบแจ้งหนี้งวดถัดไป
app.post('/api/invoices/generate', authenticateToken, requireRole('billing'), (req, res) => {
  try {
    const target = req.body.contract_id;
    const targets = req.body.contract_ids;
    const branchId = req.body.branch_id;
    let contracts = [];

    if (Array.isArray(targets) && targets.length > 0) {
      const placeholders = targets.map(() => '?').join(',');
      contracts = db.prepare(`SELECT * FROM contracts WHERE id IN (${placeholders})`).all(...targets);
    } else if (target && target !== 'all') {
      const row = db.prepare('SELECT * FROM contracts WHERE id=?').get(target);
      if (row) contracts = [row];
    } else if (branchId && branchId !== 'all') {
      contracts = db.prepare("SELECT * FROM contracts WHERE status='active' AND branch_id=?").all(branchId);
    } else {
      contracts = db.prepare("SELECT * FROM contracts WHERE status='active'").all();
    }
    
    let made = 0;
    const insert = db.prepare(`INSERT INTO invoices
      (id,contract_id,period,issue_date,due_date,rent_amt,service_amt,vat_amt,total,paid,status)
      VALUES(?,?,?,?,?,?,?,?,?,0,'open')`);
      
    contracts.filter(Boolean).forEach(c => {
      const last = db.prepare('SELECT due_date FROM invoices WHERE contract_id=? ORDER BY due_date DESC LIMIT 1').get(c.id);
      const base = last ? new Date(last.due_date + 'T00:00:00') : new Date(c.start_date + 'T00:00:00');
      const nd = new Date(base.getFullYear(), base.getMonth() + 1, c.due_day);
      const period = nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0');
      const seq = db.prepare('SELECT COUNT(*) c FROM invoices WHERE contract_id=?').get(c.id).c + 1;
      const id = c.id + '-' + String(seq).padStart(3, '0');
      const vat = c.service_monthly * 0.07;
      const total = c.rent_monthly + c.service_monthly + vat;
      const issue = new Date(nd.getFullYear(), nd.getMonth() - 1, 25).toISOString().slice(0, 10);
      
      insert.run(id, c.id, period, issue, nd.toISOString().slice(0, 10),
                 c.rent_monthly, c.service_monthly, vat, total);
      made++;
    });
    
    audit(req.user.username, 'generate', 'invoice', target || 'all', made + ' invoices');
    res.json({ ok: true, made });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// รับชำระเงิน
app.post('/api/invoices/:id/payment', authenticateToken, requireRole('cashier'), (req, res) => {
  try {
    const id = req.params.id, amt = +req.body.amount || 0, wht = +req.body.wht || 0;
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!inv) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้ที่ระบุ' });
    
    const newPaid = Math.min(inv.total, inv.paid + amt);
    const status = (inv.total - newPaid) <= 0.5 ? 'paid' : 'partial';
    
    db.prepare('UPDATE invoices SET paid=?,status=? WHERE id=?').run(status === 'paid' ? inv.total : newPaid, status, id);
    db.prepare('INSERT INTO payments(invoice_id,pay_date,amount,wht_amt,method,note) VALUES(?,?,?,?,?,?)')
      .run(id, req.body.pay_date || today(), amt, wht, req.body.method || 'transfer', req.body.note || '');
      
    audit(req.user.username, 'payment', 'invoice', id, `amount=${amt} wht=${wht}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// หักจากเงินประกัน
app.post('/api/invoices/:id/use-deposit', authenticateToken, requireRole('cashier'), (req, res) => {
  try {
    const id = req.params.id;
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!inv) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้ที่ระบุ' });
    
    const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(inv.contract_id);
    const out = inv.total - inv.paid;
    const use = Math.min(out, c.deposit_balance);
    
    db.prepare('UPDATE contracts SET deposit_balance=? WHERE id=?').run(c.deposit_balance - use, c.id);
    const newPaid = inv.paid + use;
    const status = (inv.total - newPaid) <= 0.5 ? 'paid' : 'partial';
    
    db.prepare('UPDATE invoices SET paid=?,status=? WHERE id=?').run(status === 'paid' ? inv.total : newPaid, status, id);
    db.prepare('INSERT INTO payments(invoice_id,pay_date,amount,method,note) VALUES(?,?,?,?,?)')
      .run(id, today(), use, 'deposit', 'หักจากเงินประกัน');
      
    audit(req.user.username, 'use-deposit', 'invoice', id, `use=${use}`);
    res.json({ ok: true, used: use, deposit_left: c.deposit_balance - use });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ส่งยื่นฟ้องดำเนินคดี
app.post('/api/invoices/:id/litigation', authenticateToken, requireRole('manager'), (req, res) => {
  try {
    db.prepare('UPDATE invoices SET litigation=1 WHERE id=?').run(req.params.id);
    db.prepare('INSERT INTO dunning_log(invoice_id,contract_id,action_date,level,note) SELECT id,contract_id,?,?,? FROM invoices WHERE id=?')
      .run(today(), 'lawsuit', req.body.note || 'ยื่นฟ้อง', req.params.id);
      
    audit(req.user.username, 'litigation', 'invoice', req.params.id, req.body.note || '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ตัดหนี้สูญ (ต้องระบุเหตุผล/หลักฐานเข้าเงื่อนไขกฎกระทรวง 186)
app.post('/api/invoices/:id/writeoff', authenticateToken, requireRole('manager'), (req, res) => {
  try {
    const id = req.params.id;
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!inv) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้ที่ระบุ' });
    if (!req.body.reason) return res.status(400).json({ error: 'ต้องระบุเหตุผล/หลักฐานตามกฎกระทรวง 186' });
    
    db.prepare("UPDATE invoices SET written_off=1,litigation=0,status='writeoff',written_off_date=? WHERE id=?").run(today(), id);
    
    audit(req.user.username, 'writeoff', 'invoice', id, `reason=${req.body.reason}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== DUNNING ==========
app.post('/api/dunning', authenticateToken, requireRole(['billing', 'cashier']), (req, res) => {
  try {
    const b = req.body;
    db.prepare('INSERT INTO dunning_log(invoice_id,contract_id,action_date,level,channel,result,note) VALUES(?,?,?,?,?,?,?)')
      .run(b.invoice_id || null, b.contract_id || null, b.action_date || today(), b.level, b.channel, b.result, b.note);
      
    audit(req.user.username, 'dunning', 'invoice', b.invoice_id || b.contract_id, b.level);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dunning/:contract_id', authenticateToken, (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM dunning_log WHERE contract_id=? ORDER BY action_date DESC').all(req.params.contract_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== AGING & PROVISION ==========
app.get('/api/aging', authenticateToken, requireRole(['manager', 'billing', 'viewer']), (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const branchId = req.query.branch_id;
    const invs = invWithContract(branchId).filter(i => !i.written_off && A.outstanding(i) > 0);
    const sums = {}; 
    A.BUCKETS.forEach(b => sums[b.key] = 0);
    
    const byContract = {};
    invs.forEach(i => {
      const b = A.bucketOf(i.due_date, asOf); 
      if (!b) return;
      const out = A.outstanding(i);
      sums[b.key] += out;
      byContract[i.contract_id] = byContract[i.contract_id] || { tenant: i.tenant, branch_name: i.branch_name, tot: 0 };
      byContract[i.contract_id][b.key] = (byContract[i.contract_id][b.key] || 0) + out;
      byContract[i.contract_id].tot += out;
    });
    
    res.json({ asOf, buckets: A.BUCKETS, sums, byContract });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/provision', authenticateToken, requireRole(['manager', 'viewer']), (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const branchId = req.query.branch_id;
    const rates = rateMap();
    const invs = invWithContract(branchId).filter(i => !i.written_off && A.outstanding(i) > 0);
    const detail = {}; 
    A.BUCKETS.forEach(b => detail[b.key] = { label: b.label, amt: 0, rate: rates[b.key] || 0, prov: 0 });
    
    invs.forEach(i => { 
      const b = A.bucketOf(i.due_date, asOf); 
      if (b) detail[b.key].amt += A.outstanding(i); 
    });
    
    let total = 0; 
    Object.values(detail).forEach(d => { 
      d.prov = d.amt * d.rate / 100; 
      total += d.prov; 
    });
    
    res.json({ asOf, detail, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/provision/rates', authenticateToken, requireRole('manager'), (req, res) => {
  try {
    const up = db.prepare('UPDATE provision_rates SET rate_pct=? WHERE bucket_key=?');
    Object.entries(req.body.rates || {}).forEach(([k, v]) => up.run(+v, k));
    
    audit(req.user.username, 'update', 'provision_rates', 'matrix', JSON.stringify(req.body.rates));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/provision/rates', authenticateToken, requireRole(['manager', 'billing', 'viewer']), (req, res) => {
  try {
    res.json(rateMap());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== DASHBOARD ==========
app.get('/api/dashboard', authenticateToken, (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const branchId = req.query.branch_id;
    const rates = rateMap();
    const invs = invWithContract(branchId);
    
    let totalAR = 0, overdue = 0, litig = 0, woTotal = 0, openCount = 0, litCount = 0, woCount = 0;
    const provDetail = {}; 
    A.BUCKETS.forEach(b => provDetail[b.key] = 0);
    
    invs.forEach(i => {
      const out = A.outstanding(i);
      if (i.written_off) { 
        woTotal += (i.total - i.paid); 
        woCount++; 
        return; 
      }
      if (out > 0) {
        totalAR += out; 
        openCount++;
        const b = A.bucketOf(i.due_date, asOf);
        if (b) { 
          if (b.key !== 'cur') overdue += out; 
          provDetail[b.key] += out; 
        }
        if (i.litigation) { 
          litig += out; 
          litCount++; 
        }
      }
    });
    
    let prov = 0; 
    A.BUCKETS.forEach(b => prov += provDetail[b.key] * (rates[b.key] || 0) / 100);
    
    res.json({ 
      asOf, 
      branchId: branchId || 'all',
      totalAR, 
      overdue, 
      overduePct: totalAR ? overdue / totalAR * 100 : 0,
      provision: prov, 
      litigation: litig, 
      litCount, 
      writeoff: woTotal, 
      woCount, 
      openCount 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FEE BREAKDOWN REPORT (ตามแบบรายงานไฟล์ที่ 3 & 2) ==========
app.get('/api/reports/fee-breakdown', authenticateToken, (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const branchId = req.query.branch_id;
    const invs = invWithContract(branchId).filter(i => !i.written_off && A.outstanding(i) > 0);

    function categorizeUnit(unitName) {
      const u = (unitName || '').toString();
      if (u.includes('4600200') || u.includes('สัตว์น้ำ')) return 'ค่าธรรมเนียมสัตว์น้ำผ่านท่า (GL 4600200)';
      if (u.includes('4600300') || u.includes('รถ')) return 'ค่าธรรมเนียมรถผ่านท่า (GL 4600300)';
      if (u.includes('4600400') || u.includes('น้ำแข็ง') || u.includes('เครื่องโม่')) return 'ค่าธรรมเนียมน้ำแข็งผ่านท่า (GL 4600400)';
      if (u.includes('4600500') || u.includes('น้ำมัน')) return 'ค่าธรรมเนียมน้ำมันผ่านท่า (GL 4600500)';
      if (u.includes('4600600') || u.includes('เครื่องชั่ง')) return 'ค่าธรรมเนียมใช้เครื่องชั่ง (GL 4600600)';
      if (u.includes('4600700') || u.includes('ใช้สถานที่') || u.includes('ต่ออายุ')) return 'ค่าธรรมเนียมใช้สถานที่ (GL 4600700)';
      if (u.includes('4700200') || u.includes('น้ำประปา') || u.includes('ค่าน้ำ') || u.includes('ซีเวลท์')) return 'ค่าจำหน่ายน้ำประปา (GL 4700200)';
      if (u.includes('4700300') || u.includes('ไฟฟ้า') || u.includes('ค่าไฟ')) return 'ค่าจำหน่ายไฟฟ้า (GL 4700300)';
      if (u.includes('4701420') || u.includes('สุขาภิบาล')) return 'ค่าสุขาภิบาล (GL 4701420)';
      if (u.includes('4600100') || u.includes('ตลาด') || u.includes('แผง') || u.includes('ล็อค') || u.includes('แพปลา')) return 'ค่าบริการตลาด / แพปลา / แผงค้า (GL 4600100)';
      if (u.includes('ภาษีโรงเรือน') || u.includes('สิ่งปลูกสร้าง') || u.includes('เบ็ดเตล็ด')) return 'ค่าภาษีโรงเรือนและที่ดิน / เบ็ดเตล็ด';
      if (u.includes('รับสภาพหนี้') || u.includes('ปรับโครงสร้าง') || u.includes('สืบหาหลักทรัพย์') || u.includes('ส่งฟ้อง') || u.includes('ดำเนินคดี')) return 'ลูกหนี้ปรับโครงสร้างหนี้ / ดำเนินคดี';
      return 'ค่าเช่าอาคารและที่ดิน (GL 4700400)';
    }

    const categories = [
      'ค่าเช่าอาคารและที่ดิน (GL 4700400)',
      'ค่าธรรมเนียมสัตว์น้ำผ่านท่า (GL 4600200)',
      'ค่าธรรมเนียมรถผ่านท่า (GL 4600300)',
      'ค่าธรรมเนียมน้ำแข็งผ่านท่า (GL 4600400)',
      'ค่าธรรมเนียมน้ำมันผ่านท่า (GL 4600500)',
      'ค่าธรรมเนียมใช้เครื่องชั่ง (GL 4600600)',
      'ค่าธรรมเนียมใช้สถานที่ (GL 4600700)',
      'ค่าจำหน่ายน้ำประปา (GL 4700200)',
      'ค่าจำหน่ายไฟฟ้า (GL 4700300)',
      'ค่าสุขาภิบาล (GL 4701420)',
      'ค่าบริการตลาด / แพปลา / แผงค้า (GL 4600100)',
      'ค่าภาษีโรงเรือนและที่ดิน / เบ็ดเตล็ด',
      'ลูกหนี้ปรับโครงสร้างหนี้ / ดำเนินคดี'
    ];

    const map = {};
    categories.forEach(c => {
      map[c] = { category: c, count: 0, total_ar: 0, cur: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
    });

    let grandTotal = 0;
    invs.forEach(i => {
      const cat = categorizeUnit(i.unit);
      if (!map[cat]) {
        map[cat] = { category: cat, count: 0, total_ar: 0, cur: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
      }
      const out = A.outstanding(i);
      const b = A.bucketOf(i.due_date, asOf);
      map[cat].count++;
      map[cat].total_ar += out;
      grandTotal += out;

      if (b) {
        if (b.key === 'cur') map[cat].cur += out;
        else if (b.key === 'b1') map[cat].b1 += out;
        else if (b.key === 'b2') map[cat].b2 += out;
        else if (b.key === 'b3') map[cat].b3 += out;
        else if (b.key === 'b4') map[cat].b4 += out;
        else if (b.key === 'b5') map[cat].b5 += out;
        else if (b.key === 'b6') map[cat].b6 += out;
      }
    });

    // ส่งออกรายการครบทุกหมวดหมู่ GL (12+ หมวด) เสมอ
    const result = Object.values(map).map(r => ({
      ...r,
      pct: grandTotal > 0 ? parseFloat((r.total_ar / grandTotal * 100).toFixed(2)) : 0
    }));

    res.json({ asOf, branchId: branchId || 'all', grandTotal, categories: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SCHEDULED JOB (จำลองงานรายวัน) ==========
app.post('/api/jobs/daily', authenticateToken, requireRole('manager'), (req, res) => {
  try {
    const asOf = req.body.asof || today();
    const debt = debtorTotals();
    const invs = invWithContract().filter(i => !i.written_off && A.outstanding(i) > 0);
    const actions = {};
    invs.forEach(i => {
      const a = A.recommendedAction(i, asOf, debt[i.contract_id] || 0);
      actions[a.code] = (actions[a.code] || 0) + 1;
    });
    
    audit(req.user.username, 'daily-job', 'system', asOf, JSON.stringify(actions));
    res.json({ 
      ok: true, 
      asOf, 
      summary: actions, 
      note: 'จำลองการรันระบบงานทวงถามรายวันเรียบร้อย (ในโปรดักชันจะเชื่อมต่อกับ SMS/Email Gateway ค่ายจริง)' 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PORT LEDGER ROUTES (ทะเบียนคุมรับชำระและยอดยกไป 3 ส่วน) ==========
app.get('/api/port-ledgers', authenticateToken, (req, res) => {
  try {
    const branchId = req.query.branch_id || 'C-12';
    const period = req.query.period || '2026-07';
    let sql = "SELECT * FROM port_ledgers";
    const params = [];
    const conds = [];

    if (branchId && branchId !== 'all') {
      conds.push("branch_id = ?");
      params.push(branchId);
    }
    if (period) {
      conds.push("period = ?");
      params.push(period);
    }

    if (conds.length > 0) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY category_name, id";

    const rows = db.prepare(sql).all(...params);
    const updatedRows = rows.map(r => {
      const bgTot = parseFloat(r.bg_total) || 0;
      const payAmt = parseFloat(r.pay_amount) || 0;
      const edTot = Math.max(0, bgTot - payAmt);
      const edAmt = parseFloat((edTot / 1.07).toFixed(2));
      const edVat = parseFloat((edTot - edAmt).toFixed(2));
      const edFrom = edTot > 0 ? (r.bg_overdue_from || '') : '';
      const edPeriods = edTot > 0 ? (r.bg_periods || '') : '';
      const edMonths = edTot > 0 ? (r.bg_overdue_months || 0) : 0;
      return {
        ...r,
        unit_no: r.location_detail || r.unit_no || '',
        location_detail: r.location_detail || r.unit_no || '',
        rate: (r.rate_amount !== undefined && r.rate_amount !== null) ? r.rate_amount : (r.rate || 0),
        rate_amount: (r.rate_amount !== undefined && r.rate_amount !== null) ? r.rate_amount : (r.rate || 0),
        ed_amount: edAmt,
        ed_vat: edVat,
        ed_total: edTot,
        ed_overdue_from: edFrom,
        ed_periods: edPeriods,
        ed_overdue_months: edMonths
      };
    });
    res.json(updatedRows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. บันทึกยอดรับชำระเบื้องต้นจาก ทร. (ยังไม่ตัดยอดจริง รอส่วนกลางอนุมัติ)
app.post('/api/port-ledgers/save-pending-pay', authenticateToken, (req, res) => {
  try {
    const body = req.body || {};
    const items = body.items; // Array of { id, pay_date, pay_receipt_no, pay_amount }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'ไม่พบรายการที่ต้องการบันทึก' });
    }

    const stmt = db.prepare(`
      UPDATE port_ledgers SET
        pay_date = ?,
        pay_receipt_no = ?,
        pay_amount = ?,
        ed_amount = ?,
        ed_vat = ?,
        ed_total = ?,
        ed_overdue_from = ?,
        ed_periods = ?,
        ed_overdue_months = ?,
        pay_status = 'pending_approval',
        pay_requested_by = ?
      WHERE id = ?
    `);

    const getStmt = db.prepare("SELECT * FROM port_ledgers WHERE id = ?");
    let count = 0;
    items.forEach(it => {
      const pAmt = parseFloat(it.pay_amount) || 0;
      const item = getStmt.get(it.id);
      if (item) {
        const bgTot = parseFloat(item.bg_total) || 0;
        const edTot = Math.max(0, bgTot - pAmt);
        const edAmt = parseFloat((edTot / 1.07).toFixed(2));
        const edVat = parseFloat((edTot - edAmt).toFixed(2));
        const edFrom = edTot > 0 ? (item.bg_overdue_from || '') : '';
        const edPeriods = edTot > 0 ? (item.bg_periods || '') : '';
        const edMonths = edTot > 0 ? (item.bg_overdue_months || 0) : 0;

        stmt.run(it.pay_date || today(), it.pay_receipt_no || '', pAmt, edAmt, edVat, edTot, edFrom, edPeriods, edMonths, req.user.username, it.id);
        count++;
      }
    });

    audit(req.user.username, 'save-pending-pay', 'port_ledgers', 'batch', `Recorded pending payment for ${count} items, waiting for central approval`);
    res.json({ ok: true, count, message: 'บันทึกข้อมูลเรียบร้อยแล้ว รอส่วนกลางอนุมัติตัดยอด' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ส่วนกลางอนุมัติตัดยอดชำระเงินจริง (Central Approval & Settlement)
app.post('/api/port-ledgers/approve-pay', authenticateToken, requireRole(['admin', 'manager', 'cashier']), (req, res) => {
  try {
    const body = req.body || {};
    const ids = body.ids; // Array of IDs to approve
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ไม่พบรายการที่ต้องการอนุมัติ' });
    }

    const getStmt = db.prepare("SELECT * FROM port_ledgers WHERE id = ?");
    const updateStmt = db.prepare(`
      UPDATE port_ledgers SET
        ed_amount = ?,
        ed_vat = ?,
        ed_total = ?,
        status = ?,
        pay_status = 'approved',
        pay_approved_by = ?,
        pay_approved_at = datetime('now')
      WHERE id = ?
    `);

    let approvedCount = 0;
    ids.forEach(id => {
      const item = getStmt.get(id);
      if (item && item.pay_status === 'pending_approval') {
        const pAmt = parseFloat(item.pay_amount) || 0;
        const bgTot = parseFloat(item.bg_total) || 0;
        const edTot = Math.max(0, bgTot - pAmt);
        const edAmt = parseFloat((edTot / 1.07).toFixed(2));
        const edVat = parseFloat((edTot - edAmt).toFixed(2));

        let status = 'unpaid';
        if (pAmt >= bgTot && bgTot > 0) status = 'paid';
        else if (pAmt > 0) status = 'partial';
        else if (bgTot === 0) status = 'paid';

        updateStmt.run(edAmt, edVat, edTot, status, req.user.username, id);
        approvedCount++;
      }
    });

    audit(req.user.username, 'approve-pay', 'port_ledgers', 'batch', `Approved payment settlement for ${approvedCount} items`);
    res.json({ ok: true, approvedCount, message: `ส่วนกลางอนุมัติตัดยอดชำระเงินเรียบร้อยแล้ว (${approvedCount} รายการ)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. ตัดยอดรับชำระเงินทันที (สำหรับ Admin/Manager/Cashier Direct Pay)
app.post('/api/port-ledgers/pay', authenticateToken, requireRole(['cashier', 'admin', 'manager', 'billing']), (req, res) => {
  try {
    const { id, pay_date, pay_receipt_no, pay_amount } = req.body;
    if (!id) return res.status(400).json({ error: 'ไม่ระบุรหัสรายการ' });

    const item = db.prepare("SELECT * FROM port_ledgers WHERE id = ?").get(id);
    if (!item) return res.status(404).json({ error: 'ไม่พบรายการทะเบียนคุม' });

    const pAmt = parseFloat(pay_amount) || 0;
    const bgTot = parseFloat(item.bg_total) || 0;
    const edTot = Math.max(0, bgTot - pAmt);
    const edAmt = parseFloat((edTot / 1.07).toFixed(2));
    const edVat = parseFloat((edTot - edAmt).toFixed(2));

    let status = 'unpaid';
    if (pAmt >= bgTot && bgTot > 0) status = 'paid';
    else if (pAmt > 0) status = 'partial';
    else if (bgTot === 0) status = 'paid';

    db.prepare(`
      UPDATE port_ledgers SET
        pay_date = ?,
        pay_receipt_no = ?,
        pay_amount = ?,
        ed_amount = ?,
        ed_vat = ?,
        ed_total = ?,
        status = ?,
        pay_status = 'approved',
        pay_approved_by = ?,
        pay_approved_at = datetime('now')
      WHERE id = ?
    `).run(pay_date || today(), pay_receipt_no || '', pAmt, edAmt, edVat, edTot, status, req.user.username, id);

    audit(req.user.username, 'pay-ledger', 'port_ledgers', id, `Payment ${pAmt} THB, Receipt: ${pay_receipt_no}, Ending Balance: ${edTot}`);
    res.json({ ok: true, edTot, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ยกยอดยกไปตั้งต้นงวดเดือนถัดไป (Roll Forward to Next Period)
app.post('/api/port-ledgers/roll-forward', authenticateToken, requireRole(['admin', 'manager', 'billing']), (req, res) => {
  try {
    const branchId = req.body.branch_id || 'C-12';
    const currentPeriod = req.body.period || '2026-07';

    // Parse current period year and month to get next period (e.g. 2026-07 -> 2026-08)
    const [year, month] = currentPeriod.split('-').map(Number);
    let nextYear = year;
    let nextMonth = month + 1;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    const nextPeriod = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;

    // Get all items in current period for branch
    const currentItems = db.prepare("SELECT * FROM port_ledgers WHERE branch_id = ? AND period = ?").all(branchId, currentPeriod);
    if (!currentItems.length) {
      return res.status(400).json({ error: 'ไม่พบรายการในงวดปัจจุบันสำหรับยกยอด' });
    }

    // Delete existing entries in next period for branch to avoid duplicates
    db.prepare("DELETE FROM port_ledgers WHERE branch_id = ? AND period = ?").run(branchId, nextPeriod);

    const insLedger = db.prepare(`
      INSERT INTO port_ledgers (
        branch_id, period, contract_id, customer_name, category_name, location_detail, rate_amount,
        bg_overdue_from, bg_periods, bg_overdue_months, bg_amount, bg_vat, bg_total,
        pay_date, pay_receipt_no, pay_amount,
        ed_overdue_from, ed_periods, ed_overdue_months, ed_amount, ed_vat, ed_total,
        status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    let rolledCount = 0;
    currentItems.forEach(item => {
      // Carry forward Ending Balance (กรอบสีเขียว) to become Beginning Balance (กรอบสีแดง) in next period
      const newBgFrom = item.ed_overdue_from || item.bg_overdue_from || nextPeriod;
      const newBgPeriods = item.ed_total > 0 ? (item.ed_periods || 1) + 1 : 0;
      const newBgAge = item.ed_total > 0 ? (item.ed_overdue_months || 0) + 1 : 0;
      const newBgAmt = item.ed_amount;
      const newBgVat = item.ed_vat;
      const newBgTot = item.ed_total;

      insLedger.run(
        item.branch_id, nextPeriod, item.contract_id, item.customer_name, item.category_name, item.location_detail, item.rate_amount,
        newBgFrom, newBgPeriods, newBgAge, newBgAmt, newBgVat, newBgTot,
        '', '', 0,
        newBgFrom, newBgPeriods, newBgAge, newBgAmt, newBgVat, newBgTot,
        newBgTot === 0 ? 'paid' : 'unpaid'
      );
      rolledCount++;
    });

    audit(req.user.username, 'roll-forward', 'port_ledgers', branchId, `Rolled forward ${rolledCount} items from ${currentPeriod} to ${nextPeriod}`);
    res.json({ ok: true, currentPeriod, nextPeriod, rolledCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit', authenticateToken, requireRole(['manager', 'viewer']), (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/audit', authenticateToken, (req, res) => {
  try {
    const { action, entity, entity_id, detail } = req.body;
    audit(req.user.username, action, entity, entity_id, detail);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const rows = db.prepare('SELECT id, username, role, fullname, branch_id, created_at FROM users').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { username, password, role, fullname, branch_id } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'กรุณากรอก username, password และ role' });
    }
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exists) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีในระบบแล้ว' });
    }
    const count = db.prepare('SELECT COUNT(*) c FROM users').get().c + 1;
    const id = 'U-' + String(count).padStart(3, '0');
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users(id, username, password, role, fullname, branch_id) VALUES(?,?,?,?,?,?)')
      .run(id, username, hash, role, fullname || username, branch_id || null);
    audit(req.user.username, 'create', 'user', id, `username=${username} role=${role}`);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, db: 'connected' }));

// Backup function
function backupDatabase() {
  const backupsDir = path.join(__dirname, 'backups');
  try {
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const backupFile = path.join(backupsDir, `lease_backup_${timestamp}.db`);
    const mainDbPath = path.join(__dirname, 'lease.db');
    if (fs.existsSync(mainDbPath)) {
      fs.copyFileSync(mainDbPath, backupFile);
      console.log(`[Backup] สำรองข้อมูลฐานข้อมูลสำเร็จ: ${backupFile}`);
      audit('system-backup', 'create-backup', 'database', timestamp, `Backup file: lease_backup_${timestamp}.db`);
    }
  } catch (err) {
    console.error('[Backup] เกิดข้อผิดพลาดในการสำรองข้อมูลฐานข้อมูล:', err);
  }
}

backupDatabase();

app.listen(PORT, () => console.log(`Lease AR API running → http://localhost:${PORT}`));
