// ===========================================================
//  ระบบติดตามหนี้เช่า — REST API Server (Express + node:sqlite)
//  ยกระดับระบบรักษาความปลอดภัย JWT + Role-Based Access Control
// ===========================================================
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { db, audit } = require('./db');
const A = require('./aging');
const { generateToken, authenticateToken, requireRole } = require('./auth');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const today = () => new Date().toISOString().slice(0, 10);

// ---------- helpers ----------
function invWithContract() {
  return db.prepare(`
    SELECT i.*, c.customer_id, c.deposit_balance, c.risk_tier, cu.name AS tenant, c.unit
    FROM invoices i
    JOIN contracts c ON c.id = i.contract_id
    JOIN customers cu ON cu.id = c.customer_id`).all();
}

function debtorTotals() {
  const rows = db.prepare(`
    SELECT contract_id, SUM(total - paid) AS debt
    FROM invoices WHERE written_off = 0 AND (total - paid) > 0
    GROUP BY contract_id`).all();
  const m = {};
  rows.forEach(r => m[r.contract_id] = r.debt);
  return m;
}

function rateMap() {
  const m = {};
  db.prepare('SELECT * FROM provision_rates').all().forEach(r => m[r.bucket_key] = r.rate_pct);
  return m;
}

// ========== AUTHENTICATION ==========
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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
        fullname: user.fullname
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
    const rows = db.prepare(`
      SELECT c.*, cu.name AS tenant, cu.tax_id
      FROM contracts c JOIN customers cu ON cu.id = c.customer_id
      ORDER BY c.id`).all();
    const debt = debtorTotals();
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
    
    // เริ่มบันทึก/ปรับปรุงข้อมูลผู้เช่า
    const tx = db.prepare('SELECT id FROM customers WHERE id=?').get(custId);
    if (!tx) {
      db.prepare('INSERT INTO customers(id,name,tax_id,address,authorized_person) VALUES(?,?,?,?,?)')
        .run(custId, b.tenant || '', b.tax_id || '', b.address || '', b.authorized_person || '');
    } else {
      db.prepare('UPDATE customers SET name=?,tax_id=? WHERE id=?').run(b.tenant || '', b.tax_id || '', custId);
    }
    
    db.prepare(`INSERT INTO contracts
      (id,customer_id,unit,rent_monthly,service_monthly,start_date,end_date,due_day,deposit,deposit_balance,penalty_rate,risk_tier,stamp_duty_paid)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, custId, b.unit || '', +b.rent_monthly || 0, +b.service_monthly || 0, b.start_date, b.end_date,
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
    
    db.prepare(`UPDATE contracts SET unit=?,rent_monthly=?,service_monthly=?,start_date=?,end_date=?,
      due_day=?,deposit=?,penalty_rate=?,risk_tier=?,stamp_duty_paid=? WHERE id=?`)
      .run(b.unit, +b.rent_monthly || 0, +b.service_monthly || 0, b.start_date, b.end_date,
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
    const debt = debtorTotals();
    let rows = invWithContract();
    
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
    const contracts = target && target !== 'all'
      ? [db.prepare('SELECT * FROM contracts WHERE id=?').get(target)]
      : db.prepare("SELECT * FROM contracts WHERE status='active'").all();
    
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
app.get('/api/aging', authenticateToken, requireRole(['manager', 'billing']), (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const invs = invWithContract().filter(i => !i.written_off && A.outstanding(i) > 0);
    const sums = {}; 
    A.BUCKETS.forEach(b => sums[b.key] = 0);
    
    const byContract = {};
    invs.forEach(i => {
      const b = A.bucketOf(i.due_date, asOf); 
      if (!b) return;
      const out = A.outstanding(i);
      sums[b.key] += out;
      byContract[i.contract_id] = byContract[i.contract_id] || { tenant: i.tenant, tot: 0 };
      byContract[i.contract_id][b.key] = (byContract[i.contract_id][b.key] || 0) + out;
      byContract[i.contract_id].tot += out;
    });
    
    res.json({ asOf, buckets: A.BUCKETS, sums, byContract });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/provision', authenticateToken, requireRole('manager'), (req, res) => {
  try {
    const asOf = req.query.asof || today();
    const rates = rateMap();
    const invs = invWithContract().filter(i => !i.written_off && A.outstanding(i) > 0);
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

app.get('/api/provision/rates', authenticateToken, requireRole(['manager', 'billing']), (req, res) => {
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
    const rates = rateMap();
    const invs = invWithContract();
    
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

// ========== AUDIT ==========
app.get('/api/audit', authenticateToken, requireRole('manager'), (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, db: 'connected' }));

// ========== CRON SCHEDULER (ทำงานอัตโนมัติเบื้องหลัง) ==========
// ตั้งเวลารันระบบทวงถามหนี้และบันทึกประวัติรายงานสรุปการทวงถามรายวันอัตโนมัติ ทุกวันเวลา 08:00 น.
cron.schedule('0 8 * * *', () => {
  console.log('[Scheduler] กำลังประมวลผลระบบทวงหนี้และคำนวณอายุหนี้ประจำวัน (08:00 น.)...');
  try {
    const asOf = today();
    const debt = debtorTotals();
    const invs = invWithContract().filter(i => !i.written_off && A.outstanding(i) > 0);
    const actions = {};
    
    invs.forEach(i => {
      const a = A.recommendedAction(i, asOf, debt[i.contract_id] || 0);
      actions[a.code] = (actions[a.code] || 0) + 1;
      
      // ตัวอย่างจำลอง: ยิง SMS ทวงหนี้หากเป็นวันแรกที่เกินกำหนดชำระ (เช่น เกินกำหนด 1-7 วัน และยังไม่มีการทวงระดับ call)
      const days = A.daysOverdue(i.due_date, asOf);
      if (days === 1) {
        console.log(`[Mock Notification] ยิง SMS แจ้งเตือนยอดค้างชำระอัตโนมัติไปยังผู้เช่า: ${i.tenant} (ยูนิต ${i.unit}) - ยอดค้าง ${i.total - i.paid} บาท`);
      }
    });
    
    audit('system-cron', 'daily-job', 'system', asOf, JSON.stringify(actions));
    console.log('[Scheduler] ประมวลผลและออกบันทึกจำลองเสร็จสิ้น:', actions);
  } catch (err) {
    console.error('[Scheduler] เกิดข้อผิดพลาดในการประมวลผลงานประจำวัน:', err);
  }
});

app.listen(PORT, () => console.log(`Lease AR API running → http://localhost:${PORT}`));
