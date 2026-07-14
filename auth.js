const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'lease-secret-key-123456';

// ฟังก์ชันสร้าง JWT Token
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      fullname: user.fullname
    },
    JWT_SECRET,
    { expiresIn: '8h' } // อายุการใช้งาน 8 ชั่วโมง
  );
}

// Middleware ตรวจสอบ JWT Token ใน HTTP Header
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // รูปแบบ "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'ไม่พบ Token ยืนยันตัวตน กรุณาเข้าสู่ระบบ' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token หมดอายุ หรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
    }
    req.user = user;
    next();
  });
}

// Middleware ตรวจสอบสิทธิ์ผู้ใช้งาน (Role-based Authorization)
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'กรุณายืนยันตัวตนก่อนใช้งาน' });
    }

    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    
    // บัญชี admin จะสามารถใช้งานได้ทุกระบบเสมอ
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({ 
      error: `คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้ (ต้องการสิทธิ์: ${roles.join(', ')})` 
    });
  };
}

module.exports = {
  generateToken,
  authenticateToken,
  requireRole,
  JWT_SECRET
};
