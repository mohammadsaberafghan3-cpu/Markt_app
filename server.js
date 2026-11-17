require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { calculateCommission, canRequestSettlement } = require("./lib/finance");

const app = express();
if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET با حداقل ۳۲ کاراکتر برای محیط production الزامی است");
}
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "data", "nova.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
const uploadDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
class BetterSqliteSessionStore extends session.Store {
  get(sid, callback) {
    try { const row=db.prepare("SELECT sess,expired FROM sessions WHERE sid=?").get(sid); if(!row)return callback(null,null); if(row.expired<=Date.now()){db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);return callback(null,null)} callback(null,JSON.parse(row.sess)); } catch(e) { callback(e); }
  }
  set(sid, sess, callback) {
    try { const expires=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires).getTime():Date.now()+7*86400000; db.prepare("INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expired=excluded.expired").run(sid,JSON.stringify(sess),expires); if(callback)callback(null); } catch(e) { if(callback)callback(e); }
  }
  touch(sid, sess, callback) {
    try { const expires=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires).getTime():Date.now()+7*86400000; db.prepare("UPDATE sessions SET expired=? WHERE sid=?").run(expires,sid); if(callback)callback(null); } catch(e) { if(callback)callback(e); }
  }
  destroy(sid, callback) {
    try { db.prepare("DELETE FROM sessions WHERE sid=?").run(sid); if(callback)callback(null); } catch(e) { if(callback)callback(e); }
  }
}

app.disable("x-powered-by");
app.use(session({
  store: new BetterSqliteSessionStore(),
  name: "nova.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 86400000 }
}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
 status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 parent_id INTEGER, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER, category_id INTEGER,
 title TEXT NOT NULL, description TEXT DEFAULT '', price REAL NOT NULL DEFAULT 0,
 compare_price REAL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, sku TEXT DEFAULT '',
 image TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
 total REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
 status TEXT NOT NULL DEFAULT 'new', address TEXT DEFAULT '',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL, seller_id INTEGER, title TEXT NOT NULL,
 quantity INTEGER NOT NULL, unit_price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS coupons(
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
 discount_percent INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS seller_applications(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 shop_name TEXT NOT NULL, description TEXT DEFAULT '', contact_phone TEXT DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending', admin_note TEXT DEFAULT '',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT,
 UNIQUE(user_id)
);
CREATE TABLE IF NOT EXISTS payment_transactions(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE,
 provider TEXT NOT NULL DEFAULT 'mock', mode TEXT NOT NULL DEFAULT 'test',
 amount REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 reference TEXT NOT NULL UNIQUE, provider_reference TEXT, payload_json TEXT DEFAULT '{}',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS marketplace_commissions(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
 order_item_id INTEGER NOT NULL UNIQUE, seller_id INTEGER NOT NULL,
 gross_amount REAL NOT NULL, commission_rate REAL NOT NULL,
 commission_amount REAL NOT NULL, seller_net REAL NOT NULL,
 currency TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS seller_wallet_entries(
 id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL,
 order_id INTEGER, settlement_id INTEGER, type TEXT NOT NULL,
 amount REAL NOT NULL, currency TEXT NOT NULL, description TEXT DEFAULT '',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settlements(
 id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL,
 amount REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
 payout_reference TEXT, admin_note TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS refund_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE,
 customer_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'requested', admin_note TEXT DEFAULT '',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS marketplace_commission_reversals(
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_item_id INTEGER NOT NULL UNIQUE,
 order_id INTEGER NOT NULL, seller_id INTEGER NOT NULL,
 gross_amount REAL NOT NULL, commission_amount REAL NOT NULL,
 seller_net REAL NOT NULL, currency TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
// Additive, repeatable schema migrations. No existing table or row is dropped.
function hasColumn(table,name){return db.prepare("PRAGMA table_info("+table+")").all().some(c=>c.name===name)}
function ensureColumn(table,name,definition){if(!hasColumn(table,name))db.exec("ALTER TABLE "+table+" ADD COLUMN "+name+" "+definition)}
ensureColumn("orders","payment_status","TEXT NOT NULL DEFAULT 'unpaid'");
ensureColumn("orders","commission_total","REAL NOT NULL DEFAULT 0");
ensureColumn("order_items","commission_rate","REAL NOT NULL DEFAULT 0");
ensureColumn("order_items","commission_amount","REAL NOT NULL DEFAULT 0");
ensureColumn("payment_transactions","idempotency_key","TEXT");
ensureColumn("payment_transactions","request_hash","TEXT");
ensureColumn("payment_transactions","updated_at","TEXT");
ensureColumn("payment_transactions","failure_reason","TEXT");
ensureColumn("seller_applications","commission_override","REAL");
ensureColumn("seller_applications","reviewed_by","INTEGER");
ensureColumn("seller_wallet_entries","reference_key","TEXT");
ensureColumn("settlements","processed_by","INTEGER");
ensureColumn("settlements","updated_at","TEXT");
ensureColumn("refund_requests","processed_by","INTEGER");
ensureColumn("refund_requests","updated_at","TEXT");
db.exec("CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER,action TEXT NOT NULL,details TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_idempotency ON payment_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_wallet_reference ON seller_wallet_entries(reference_key) WHERE reference_key IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_seller_application_status ON seller_applications(status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_refund_status ON refund_requests(status)");
db.prepare("UPDATE orders SET payment_status=COALESCE((SELECT status FROM payment_transactions WHERE payment_transactions.order_id=orders.id),'unpaid')").run();
db.prepare("UPDATE order_items SET commission_rate=COALESCE((SELECT commission_rate FROM marketplace_commissions WHERE marketplace_commissions.order_item_id=order_items.id),commission_rate),commission_amount=COALESCE((SELECT commission_amount FROM marketplace_commissions WHERE marketplace_commissions.order_item_id=order_items.id),commission_amount)").run();
function audit(actor,action,details){db.prepare("INSERT INTO audit_logs(actor_id,action,details) VALUES(?,?,?)").run(actor||null,action,String(details||""))}
function regenerateSession(req,res,user,statusCode=200){req.session.regenerate(err=>{if(err)return res.status(500).json({error:"ساخت نشست امن انجام نشد"});req.session.user=safeUser(user);res.status(statusCode).json({user:req.session.user})})}
function hashRequest(value){return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}

// Safe additive settings migration: existing databases retain all prior records.
const seedSetting = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
seedSetting.run("commission_rate", "10");
seedSetting.run("payment_mode", "test");
seedSetting.run("currency", "auto");
seedSetting.run("store_name", "NOVA Market");
seedSetting.run("store_description", "بازاری برای انتخاب‌های هوشمندانه");
const count = db.prepare("SELECT COUNT(*) n FROM categories").get().n;
if (!count) {
  const add = db.prepare("INSERT INTO categories(name,slug) VALUES(?,?)");
  [
    ["مد و پوشاک","fashion"],["الکترونیک","electronics"],["خانه و آشپزخانه","home"],
    ["زیبایی و سلامت","beauty"],["ورزش و سفر","sports"],["کتاب و فرهنگ","books"],
    ["کودک و نوزاد","kids"],["مواد غذایی","grocery"],["ابزار و خودرو","tools"]
  ].forEach(x => add.run(...x));
}
const adminEmail = process.env.ADMIN_EMAIL || "admin@novamarket.local";
if (!db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail)) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!", 12);
  db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'admin')")
    .run("مدیر کل", adminEmail, hash);
}
if (!db.prepare("SELECT id FROM products LIMIT 1").get()) {
  const cat = db.prepare("SELECT id FROM categories WHERE slug='fashion'").get().id;
  const demo = db.prepare("INSERT INTO products(title,description,price,compare_price,stock,category_id,image,status) VALUES(?,?,?,?,?,?,?, 'active')");
  demo.run("مانتو مینیمال آوید","نمونه نمایشی؛ مشخصات و قیمت را از پنل مدیریت تغییر دهید.",79.9,99.9,12,cat,"https://images.unsplash.com/photo-1539109136881-3be0616acf4b?w=900");
  demo.run("کیف روزمره کلاسیک","نمونه نمایشی محصول فروشگاه.",49.5,0,8,cat,"https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=900");
  demo.run("کفش شهری راحت","نمونه نمایشی محصول فروشگاه.",64,0,15,cat,"https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=900");
}

const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const safeUser = u => u && ({ id:u.id, name:u.name, email:u.email, role:u.role, status:u.status });
function auth(req,res,next){if(!req.session.user)return res.status(401).json({error:"ابتدا وارد حساب شوید"});const current=one("SELECT * FROM users WHERE id=?",req.session.user.id);if(!current||current.status!=="active"){req.session.destroy(()=>{});return res.status(401).json({error:"حساب کاربری فعال نیست"})}req.session.user=safeUser(current);next()}
function roles(...allowed){return(req,res,next)=>auth(req,res,()=>{if(!allowed.includes(req.session.user.role))return res.status(403).json({error:"دسترسی مجاز نیست"});if(req.session.user.role==="seller"&&!one("SELECT id FROM seller_applications WHERE user_id=? AND status='approved'",req.session.user.id))return res.status(403).json({error:"درخواست فروشندگی تأیید نشده است"});next()})}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_,__,cb)=>cb(null,uploadDir),
    filename: (_,file,cb)=>cb(null,crypto.randomBytes(12).toString("hex")+path.extname(file.originalname).toLowerCase())
  }),
  limits:{fileSize:4*1024*1024},
  fileFilter:(_,f,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(f.mimetype))
});

app.get("/api/config",(req,res)=>res.json({
  storeName:one("SELECT value FROM settings WHERE key='store_name'").value,
  currency:one("SELECT value FROM settings WHERE key='currency'").value,
  user:safeUser(req.session.user),
  categories:q("SELECT * FROM categories WHERE active=1 ORDER BY name")
}));
app.post("/api/register",async(req,res)=>{
  const {name,email,password}=req.body||{};
  if(!name||!email||!password||String(password).length<8) return res.status(400).json({error:"نام، ایمیل و رمز حداقل ۸ کاراکتری لازم است"});
  try{
    const hash=await bcrypt.hash(String(password),12);
    const r=run("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'customer')",String(name).trim(),String(email).toLowerCase().trim(),hash);
    req.session.user=safeUser(one("SELECT * FROM users WHERE id=?",r.lastInsertRowid));
    res.json({user:req.session.user});
  }catch(e){res.status(400).json({error:"این ایمیل قبلاً ثبت شده یا اطلاعات معتبر نیست"});}
});
app.post("/api/login",async(req,res)=>{
  const email=String(req.body.email||"").toLowerCase().trim();
  const user=one("SELECT * FROM users WHERE email=?",email);
  if(!user||user.status!=="active"||!(await bcrypt.compare(String(req.body.password||""),user.password_hash))) return res.status(401).json({error:"ایمیل یا رمز عبور اشتباه است"});
  req.session.user=safeUser(user); res.json({user:req.session.user});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({user:safeUser(req.session.user)}));

app.get("/api/products",(req,res)=>{
  const {q:term="",category="",sort="new"}=req.query;
  let sql="SELECT p.*, c.name category_name, u.name seller_name FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN users u ON u.id=p.seller_id WHERE p.status='active'";
  const args=[];
  if(term){sql+=" AND (p.title LIKE ? OR p.description LIKE ?)";args.push(`%${term}%`,`%${term}%`);}
  if(category){sql+=" AND c.slug=?";args.push(category);}
  sql+=sort==="price_asc"?" ORDER BY p.price ASC":sort==="price_desc"?" ORDER BY p.price DESC":" ORDER BY p.created_at DESC";
  res.json(q(sql,args));
});
app.get("/api/products/:id",(req,res)=>{
  const p=one("SELECT p.*,c.name category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.status='active'",Number(req.params.id));
  if(!p)return res.status(404).json({error:"محصول پیدا نشد"});res.json(p);
});
app.post("/api/orders",auth,(req,res)=>{
  const {items,address}=req.body||{};
  if(!Array.isArray(items)||!items.length||!String(address||'').trim()) return res.status(400).json({error:"سبد خرید و نشانی تحویل لازم است"});
  const create=db.transaction(()=>{
    let total=0; const normalized=[]; const quantities=new Map();
    for(const item of items){
      const id=Number(item.id), qty=Number(item.quantity);
      if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(qty)||qty<1||qty>99) throw new Error("اقلام سفارش نامعتبر است");
      quantities.set(id,(quantities.get(id)||0)+qty);
    }
    for(const [id,qty] of quantities){
      if(qty>99)throw new Error("تعداد هر کالا نمی‌تواند بیش از ۹۹ باشد");
      const p=one("SELECT * FROM products WHERE id=? AND status='active'",id);
      if(!p||p.stock<qty) throw new Error("موجودی یکی از محصولات کافی نیست");
      total=Math.round((total+p.price*qty)*100)/100; normalized.push({p,qty});
    }
    const configuredCurrency=one("SELECT value FROM settings WHERE key='currency'").value;
    const language=String(req.get("accept-language")||"").toLowerCase();
    const currency=configuredCurrency!=="auto"?configuredCurrency:(language.includes("fa")?"IRR":language.includes("en-us")?"USD":language.includes("en-gb")?"GBP":"EUR");
    const o=run("INSERT INTO orders(customer_id,total,currency,status,address) VALUES(?,?,?,'pending_payment',?)",req.session.user.id,total,currency,String(address).trim().slice(0,500));
    for(const x of normalized) run("INSERT INTO order_items(order_id,product_id,seller_id,title,quantity,unit_price) VALUES(?,?,?,?,?,?)",o.lastInsertRowid,x.p.id,x.p.seller_id,x.p.title,x.qty,x.p.price);
    const ref='NOVA-'+crypto.randomBytes(12).toString('hex').toUpperCase();
    run("INSERT INTO payment_transactions(order_id,amount,currency,reference) VALUES(?,?,?,?)",o.lastInsertRowid,total,currency,ref);
    return {orderId:o.lastInsertRowid,paymentReference:ref,paymentMode:one("SELECT value FROM settings WHERE key='payment_mode'").value,total,currency};
  });
  try{res.status(201).json(create());}catch(e){res.status(400).json({error:e.message});}
});
// Explicit test-only payment confirmation. It cannot represent a real gateway callback.
app.post("/api/payments/test/confirm",auth,(req,res)=>{
  const ref=String(req.body.reference||'').trim();
  if(!ref)return res.status(400).json({error:"شناسه پرداخت لازم است"});
  try{
    const result=db.transaction(()=>{
      const tx=one("SELECT t.*,o.customer_id,o.status order_status,o.id oid FROM payment_transactions t JOIN orders o ON o.id=t.order_id WHERE t.reference=?",ref);
      if(!tx||tx.customer_id!==req.session.user.id)return {error:"تراکنش پیدا نشد",code:404};
      if(one("SELECT value FROM settings WHERE key='payment_mode'").value!=="test"||tx.mode!=="test")return {error:"حالت آزمایشی پرداخت فعال نیست",code:409};
      if(tx.status==='paid')return {ok:true,alreadyPaid:true,orderId:tx.oid};
      if(tx.status!=='pending')return {error:"وضعیت تراکنش قابل پرداخت نیست",code:409};
      const items=q("SELECT * FROM order_items WHERE order_id=?",tx.oid);
      for(const item of items){const product=one("SELECT stock FROM products WHERE id=?",item.product_id);if(!product||product.stock<item.quantity)throw new Error("موجودی کالا پس از ثبت سفارش کافی نیست؛ با مدیر تماس بگیرید");}
      run("UPDATE payment_transactions SET status='paid',provider_reference=?,paid_at=CURRENT_TIMESTAMP,payload_json=? WHERE id=?",'TEST-'+crypto.randomBytes(8).toString('hex'),JSON.stringify({simulated:true}),tx.id);
      run("UPDATE orders SET status='new' WHERE id=?",tx.oid);
      const rate=Number(one("SELECT value FROM settings WHERE key='commission_rate'").value);
      if(!Number.isFinite(rate)||rate<0||rate>50)throw new Error("نرخ کمیسیون پیکربندی‌شده نامعتبر است");
      for(const item of items){
        run("UPDATE products SET stock=stock-? WHERE id=?",item.quantity,item.product_id);
        if(item.seller_id){
          const amounts=calculateCommission(item.quantity*item.unit_price,rate);
          run("INSERT INTO marketplace_commissions(order_id,order_item_id,seller_id,gross_amount,commission_rate,commission_amount,seller_net,currency) VALUES(?,?,?,?,?,?,?,?)",tx.oid,item.id,item.seller_id,amounts.gross,rate,amounts.commission,amounts.net,tx.currency);
          run("INSERT INTO seller_wallet_entries(seller_id,order_id,type,amount,currency,description) VALUES(?,?,'credit',?,?,?)",item.seller_id,tx.oid,amounts.net,tx.currency,`فروش سفارش ${tx.oid}؛ کمیسیون ${rate}%`);
        }
      }
      return {ok:true,alreadyPaid:false,orderId:tx.oid};
    })();
    if(result.error)return res.status(result.code).json({error:result.error});res.json(result);
  }catch(e){res.status(400).json({error:e.message});}
});
app.get("/api/payments/:reference",auth,(req,res)=>{
 const tx=one("SELECT t.reference,t.order_id,t.amount,t.currency,t.status,t.mode,t.created_at,t.paid_at,o.customer_id FROM payment_transactions t JOIN orders o ON o.id=t.order_id WHERE t.reference=?",String(req.params.reference));
 if(!tx||tx.customer_id!==req.session.user.id)return res.status(404).json({error:"تراکنش پیدا نشد"});delete tx.customer_id;res.json(tx);
});
// Refunds are simulation-only. No external payment provider or money movement is involved.
app.post("/api/orders/:id/refund",auth,(req,res)=>{
 const orderId=Number(req.params.id),reason=String(req.body.reason||'').trim().slice(0,500);
 const out=db.transaction(()=>{
  const o=one("SELECT * FROM orders WHERE id=? AND customer_id=?",orderId,req.session.user.id);
  if(!o)return {error:"سفارش پیدا نشد",code:404};
  const tx=one("SELECT * FROM payment_transactions WHERE order_id=?",orderId);
  if(!tx||tx.status!=='paid'||!['new','processing','shipped','completed'].includes(o.status))return {error:"این سفارش در حال حاضر واجد شرایط درخواست بازپرداخت نیست",code:409};
  if(one("SELECT id FROM refund_requests WHERE order_id=?",orderId))return {error:"برای این سفارش قبلاً درخواست بازپرداخت ثبت شده است",code:409};
  const id=run("INSERT INTO refund_requests(order_id,customer_id,reason) VALUES(?,?,?)",orderId,req.session.user.id,reason).lastInsertRowid;
  return {id,status:'requested',simulationOnly:true};
 })();
 if(out.error)return res.status(out.code).json({error:out.error});res.status(201).json(out);
});
app.get("/api/admin/refunds",roles("admin"),(req,res)=>res.json(q("SELECT r.*,o.total,o.currency,u.name customer_name,u.email FROM refund_requests r JOIN orders o ON o.id=r.order_id JOIN users u ON u.id=r.customer_id ORDER BY r.id DESC")));
app.patch("/api/admin/refunds/:id",roles("admin"),(req,res)=>{
 const status=String(req.body.status||''),note=String(req.body.admin_note||'').slice(0,500);
 if(!['approved','rejected'].includes(status))return res.status(400).json({error:"تصمیم بازپرداخت نامعتبر است"});
 try{
  const result=db.transaction(()=>{
   const r=one("SELECT * FROM refund_requests WHERE id=?",Number(req.params.id));
   if(!r)return {error:"درخواست پیدا نشد",code:404};
   if(r.status!=='requested')return {error:"این درخواست قبلاً بررسی شده است",code:409};
   if(status==='approved'){
    const tx=one("SELECT * FROM payment_transactions WHERE order_id=?",r.order_id);
    if(!tx||tx.status!=='paid')return {error:"تراکنش پرداخت‌شده برای این سفارش یافت نشد",code:409};
    const items=q("SELECT * FROM order_items WHERE order_id=?",r.order_id);
    for(const item of items){
     const commission=one("SELECT * FROM marketplace_commissions WHERE order_item_id=?",item.id);
     if(commission&&!one("SELECT id FROM marketplace_commission_reversals WHERE order_item_id=?",item.id)){
      run("INSERT INTO marketplace_commission_reversals(order_item_id,order_id,seller_id,gross_amount,commission_amount,seller_net,currency) VALUES(?,?,?,?,?,?,?)",item.id,r.order_id,commission.seller_id,commission.gross_amount,commission.commission_amount,commission.seller_net,commission.currency);
      run("INSERT INTO seller_wallet_entries(seller_id,order_id,type,amount,currency,description) VALUES(?,?,'debit',?,?,?)",commission.seller_id,r.order_id,commission.seller_net,commission.currency,`برگشت سهم فروشنده بابت بازپرداخت سفارش ${r.order_id}`);
     }
     run("UPDATE products SET stock=stock+? WHERE id=?",item.quantity,item.product_id);
    }
    run("UPDATE payment_transactions SET status='refunded' WHERE order_id=? AND status='paid'",r.order_id);
    run("UPDATE orders SET status='refunded' WHERE id=?",r.order_id);
   }
   run("UPDATE refund_requests SET status=?,admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",status,note,r.id);
   return {ok:true,status,simulationOnly:true};
  })();
  if(result.error)return res.status(result.code).json({error:result.error});res.json(result);
 }catch(e){res.status(400).json({error:e.message});}
});
app.get("/api/my-orders",auth,(req,res)=>res.json(q("SELECT o.*,rr.status refund_status FROM orders o LEFT JOIN refund_requests rr ON rr.order_id=o.id WHERE o.customer_id=? ORDER BY o.created_at DESC",req.session.user.id)));

app.get("/api/dashboard",roles("admin","seller"),(req,res)=>{
  const u=req.session.user, sellerFilter=u.role==="seller"?" AND seller_id=?":"";
  const args=u.role==="seller"?[u.id]:[];
  const productCount=one("SELECT COUNT(*) n FROM products WHERE 1=1"+sellerFilter,args).n;
  const orderSql=u.role==="seller"?"SELECT COUNT(DISTINCT o.id) n,COALESCE(SUM(oi.quantity*oi.unit_price),0) revenue FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN payment_transactions pt ON pt.order_id=o.id AND pt.status='paid' WHERE oi.seller_id=?":"SELECT COUNT(*) n,COALESCE(SUM(o.total),0) revenue FROM orders o JOIN payment_transactions pt ON pt.order_id=o.id AND pt.status='paid'";
  const stats=one(orderSql,...(u.role==="seller"?[u.id]:[]));
  const pending=one(u.role==="seller"?"SELECT COUNT(*) n FROM products WHERE status='pending' AND seller_id=?":"SELECT COUNT(*) n FROM products WHERE status='pending'",...(u.role==="seller"?[u.id]:[])).n;
  res.json({productCount,orderCount:stats.n,revenue:stats.revenue,pending});
});
app.get("/api/manage/products",roles("admin","seller"),(req,res)=>{
  if(req.session.user.role==="seller") return res.json(q("SELECT * FROM products WHERE seller_id=? ORDER BY id DESC",req.session.user.id));
  res.json(q("SELECT p.*,u.name seller_name FROM products p LEFT JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC"));
});
app.post("/api/upload",roles("admin","seller"),upload.single("image"),(req,res)=>{
  if(!req.file)return res.status(400).json({error:"فایل تصویر معتبر (حداکثر ۴ مگابایت) انتخاب کنید"});
  res.json({url:"/uploads/"+req.file.filename});
});
app.post("/api/manage/products",roles("admin","seller"),(req,res)=>{
  const b=req.body||{};
  if(!b.title||Number(b.price)<0)return res.status(400).json({error:"عنوان و قیمت معتبر لازم است"});
  const seller=req.session.user.role==="seller"?req.session.user.id:(Number(b.seller_id)||null);
  const status=req.session.user.role==="admin"?"active":"pending";
  const r=run("INSERT INTO products(seller_id,category_id,title,description,price,compare_price,stock,sku,image,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
    seller,Number(b.category_id)||null,String(b.title),String(b.description||""),Number(b.price),Number(b.compare_price)||0,Math.max(0,Number(b.stock)||0),String(b.sku||""),String(b.image||""),status);
  res.json({id:r.lastInsertRowid,status});
});
app.put("/api/manage/products/:id",roles("admin","seller"),(req,res)=>{
  const id=Number(req.params.id), p=one("SELECT * FROM products WHERE id=?",id), b=req.body||{};
  if(!p)return res.status(404).json({error:"محصول پیدا نشد"});
  if(req.session.user.role==="seller"&&p.seller_id!==req.session.user.id)return res.status(403).json({error:"این محصول متعلق به شما نیست"});
  run("UPDATE products SET title=?,description=?,price=?,compare_price=?,stock=?,sku=?,image=?,category_id=? WHERE id=?",
    String(b.title||p.title),String(b.description??p.description),Number(b.price??p.price),Number(b.compare_price??p.compare_price),Math.max(0,Number(b.stock??p.stock)),String(b.sku??p.sku),String(b.image??p.image),Number(b.category_id)||p.category_id,id);
  res.json({ok:true});
});
app.delete("/api/manage/products/:id",roles("admin","seller"),(req,res)=>{
  const p=one("SELECT * FROM products WHERE id=?",Number(req.params.id));
  if(!p)return res.status(404).json({error:"محصول پیدا نشد"});
  if(req.session.user.role==="seller"&&p.seller_id!==req.session.user.id)return res.status(403).json({error:"دسترسی مجاز نیست"});
  run("DELETE FROM products WHERE id=?",p.id);res.json({ok:true});
});
app.get("/api/manage/orders",roles("admin","seller"),(req,res)=>{
  if(req.session.user.role==="seller")return res.json(q("SELECT DISTINCT o.*,u.name customer_name FROM orders o JOIN order_items i ON i.order_id=o.id JOIN users u ON u.id=o.customer_id WHERE i.seller_id=? ORDER BY o.id DESC",req.session.user.id));
  res.json(q("SELECT o.*,u.name customer_name FROM orders o JOIN users u ON u.id=o.customer_id ORDER BY o.id DESC"));
});
app.patch("/api/manage/orders/:id",roles("admin"),(req,res)=>{
  const allowed=["new","processing","shipped","completed","cancelled"];
  if(!allowed.includes(req.body.status))return res.status(400).json({error:"وضعیت نامعتبر"});
  const order=one("SELECT id FROM orders WHERE id=?",Number(req.params.id));if(!order)return res.status(404).json({error:"سفارش پیدا نشد"});
  const paid=one("SELECT status FROM payment_transactions WHERE order_id=?",order.id);
  if(req.body.status==="cancelled"&&paid&&paid.status==="paid")return res.status(409).json({error:"سفارش پرداخت‌شده را از مسیر درخواست بازپرداخت مدیریت کنید"});
  if((!paid||paid.status!=="paid")&&req.body.status!=="cancelled")return res.status(409).json({error:"سفارش تا پیش از پرداخت قابل پردازش نیست"});
  if(req.body.status==="cancelled"&&paid&&paid.status==="pending")run("UPDATE payment_transactions SET status='cancelled' WHERE order_id=?",order.id);
  run("UPDATE orders SET status=? WHERE id=?",req.body.status,order.id);res.json({ok:true});
});
app.get("/api/admin/users",roles("admin"),(req,res)=>res.json(q("SELECT id,name,email,role,status,created_at FROM users ORDER BY id DESC")));
app.patch("/api/admin/users/:id",roles("admin"),(req,res)=>{
  const {role,status}=req.body||{};
  if(!["admin","seller","customer"].includes(role)||!["active","blocked"].includes(status))return res.status(400).json({error:"اطلاعات نامعتبر"});
  run("UPDATE users SET role=?,status=? WHERE id=?",role,status,Number(req.params.id));res.json({ok:true});
});
app.get("/api/admin/categories",roles("admin"),(req,res)=>res.json(q("SELECT * FROM categories ORDER BY id")));
app.post("/api/admin/categories",roles("admin"),(req,res)=>{
  const name=String(req.body.name||"").trim(), slug=String(req.body.slug||"").trim().toLowerCase();
  if(!name||!slug)return res.status(400).json({error:"نام و شناسه لازم است"});
  try{const r=run("INSERT INTO categories(name,slug,parent_id) VALUES(?,?,?)",name,slug,Number(req.body.parent_id)||null);res.json({id:r.lastInsertRowid});}
  catch(e){res.status(400).json({error:"شناسه دسته‌بندی تکراری است"});}
});
app.get("/api/admin/settings",roles("admin"),(req,res)=>res.json(Object.fromEntries(q("SELECT key,value FROM settings").map(x=>[x.key,x.value]))));
app.put("/api/admin/settings",roles("admin"),(req,res)=>{
  const b=req.body||{};
  if(b.currency!==undefined&&!['auto','EUR','USD','IRR','TOMAN','GBP'].includes(String(b.currency)))return res.status(400).json({error:"واحد پول پشتیبانی نمی‌شود"});
  if(b.commission_rate!==undefined&&(!Number.isFinite(Number(b.commission_rate))||Number(b.commission_rate)<0||Number(b.commission_rate)>50))return res.status(400).json({error:"کمیسیون باید بین صفر تا ۵۰ درصد باشد"});
  if(b.payment_mode!==undefined&&b.payment_mode!=='test')return res.status(400).json({error:"در این نسخه فقط حالت آزمایشی پرداخت فعال است"});
  for(const key of ["currency","store_name","store_description","commission_rate","payment_mode"])if(b[key]!==undefined)run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,String(b[key]).slice(0,200));
  res.json({ok:true});
});
// Seller application workflow.
app.post("/api/seller/apply",auth,(req,res)=>{
 if(req.session.user.role!=='customer')return res.status(409).json({error:"این حساب امکان ثبت درخواست فروشندگی ندارد"});
 const shop=String(req.body.shop_name||'').trim(),description=String(req.body.description||'').trim(),phone=String(req.body.contact_phone||'').trim();
 if(shop.length<2||shop.length>100||description.length>1000||phone.length>30)return res.status(400).json({error:"اطلاعات فروشگاه نامعتبر است"});
 try{const r=run("INSERT INTO seller_applications(user_id,shop_name,description,contact_phone) VALUES(?,?,?,?)",req.session.user.id,shop,description,phone);res.status(201).json({id:r.lastInsertRowid,status:'pending'});}catch(e){res.status(409).json({error:"برای این حساب قبلاً درخواست ثبت شده است"});}
});
app.get("/api/seller/application",auth,(req,res)=>res.json(one("SELECT id,shop_name,description,contact_phone,status,admin_note,created_at,reviewed_at FROM seller_applications WHERE user_id=?",req.session.user.id)||null));
app.get("/api/admin/seller-applications",roles("admin"),(req,res)=>res.json(q("SELECT a.*,u.name,u.email FROM seller_applications a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC")));
app.patch("/api/admin/seller-applications/:id",roles("admin"),(req,res)=>{
 const status=String(req.body.status||''),note=String(req.body.admin_note||'').slice(0,500);
 if(!['approved','rejected'].includes(status))return res.status(400).json({error:"تصمیم نامعتبر است"});
 const r=db.transaction(()=>{const a=one("SELECT * FROM seller_applications WHERE id=?",Number(req.params.id));if(!a)return null;if(a.status!=='pending')throw new Error("این درخواست قبلاً بررسی شده است");run("UPDATE seller_applications SET status=?,admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",status,note,a.id);if(status==='approved')run("UPDATE users SET role='seller' WHERE id=? AND status='active'",a.user_id);return a;})();
 if(!r)return res.status(404).json({error:"درخواست پیدا نشد"});res.json({ok:true,status});
});
// Seller wallet and settlement ledger. Balances are derived from immutable ledger entries.
app.get("/api/seller/wallet",roles("seller"),(req,res)=>{
 const currencyRows=q("SELECT currency,ROUND(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),2) balance FROM seller_wallet_entries WHERE seller_id=? GROUP BY currency",req.session.user.id);
 const entries=q("SELECT * FROM seller_wallet_entries WHERE seller_id=? ORDER BY id DESC LIMIT 100",req.session.user.id);
 const pending=q("SELECT currency,ROUND(SUM(amount),2) amount FROM settlements WHERE seller_id=? AND status IN ('requested','approved') GROUP BY currency",req.session.user.id);
 res.json({balances:currencyRows,entries,pending});
});
app.post("/api/seller/settlements",roles("seller"),(req,res)=>{
 const amount=Number(req.body.amount),currency=String(req.body.currency||'').trim().toUpperCase();
 if(!Number.isFinite(amount)||amount<=0||amount>1e9||! /^[A-Z]{3,8}$/.test(currency))return res.status(400).json({error:"مبلغ یا واحد پول نامعتبر است"});
 const r=db.transaction(()=>{const bal=one("SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0) n FROM seller_wallet_entries WHERE seller_id=? AND currency=?",req.session.user.id,currency).n;const settlementHeld=one("SELECT COALESCE(SUM(amount),0) n FROM settlements WHERE seller_id=? AND currency=? AND status IN ('requested','approved')",req.session.user.id,currency).n;const refundHeld=one("SELECT COALESCE(SUM(c.seller_net),0) n FROM marketplace_commissions c JOIN refund_requests r ON r.order_id=c.order_id WHERE c.seller_id=? AND c.currency=? AND r.status='requested'",req.session.user.id,currency).n;const held=settlementHeld+refundHeld;if(!canRequestSettlement(bal,held,amount))throw new Error("موجودی قابل تسویه کافی نیست");return run("INSERT INTO settlements(seller_id,amount,currency) VALUES(?,?,?)",req.session.user.id,amount,currency).lastInsertRowid;})();
 res.status(201).json({id:r,status:'requested'});
});
app.get("/api/admin/commissions",roles("admin"),(req,res)=>res.json(q("SELECT c.*,u.name seller_name FROM marketplace_commissions c JOIN users u ON u.id=c.seller_id ORDER BY c.id DESC LIMIT 500")));
app.get("/api/admin/settlements",roles("admin"),(req,res)=>res.json(q("SELECT s.*,u.name seller_name,u.email FROM settlements s JOIN users u ON u.id=s.seller_id ORDER BY s.id DESC")));
app.patch("/api/admin/settlements/:id",roles("admin"),(req,res)=>{
 const status=String(req.body.status||''),reference=String(req.body.payout_reference||'').slice(0,100),note=String(req.body.admin_note||'').slice(0,500);
 if(!['approved','paid','rejected'].includes(status))return res.status(400).json({error:"وضعیت تسویه نامعتبر است"});
 const out=db.transaction(()=>{const s=one("SELECT * FROM settlements WHERE id=?",Number(req.params.id));if(!s)return null;if(!['requested','approved'].includes(s.status))throw new Error("این درخواست قبلاً نهایی شده است");if(status==='paid'){const bal=one("SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0) n FROM seller_wallet_entries WHERE seller_id=? AND currency=?",s.seller_id,s.currency).n;const held=one("SELECT COALESCE(SUM(amount),0) n FROM settlements WHERE seller_id=? AND currency=? AND status IN ('requested','approved') AND id<>?",s.seller_id,s.currency,s.id).n;if(!canRequestSettlement(bal,held,s.amount))throw new Error("موجودی قابل تسویه کافی نیست");run("INSERT INTO seller_wallet_entries(seller_id,settlement_id,type,amount,currency,description) VALUES(?,?,'debit',?,?,?)",s.seller_id,s.id,s.amount,s.currency,`تسویه شماره ${s.id}`);}
 run("UPDATE settlements SET status=?,payout_reference=?,admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",status,reference,note,s.id);return s;})();
 if(!out)return res.status(404).json({error:"درخواست تسویه پیدا نشد"});res.json({ok:true,status});
});
app.get("/api/admin/coupons",roles("admin"),(req,res)=>res.json(q("SELECT * FROM coupons ORDER BY id DESC")));
app.post("/api/admin/coupons",roles("admin"),(req,res)=>{
  const code=String(req.body.code||"").toUpperCase().trim(), discount=Math.max(1,Math.min(90,Number(req.body.discount_percent)||1));
  try{const r=run("INSERT INTO coupons(code,discount_percent) VALUES(?,?)",code,discount);res.json({id:r.lastInsertRowid});}
  catch(e){res.status(400).json({error:"کد تخفیف تکراری یا نامعتبر است"});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`NOVA Market running: http://localhost:${PORT}`));
