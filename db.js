const Database=require('better-sqlite3');
const path=require('path');
const fs=require('fs');
const file=process.env.DATABASE_PATH||path.join(__dirname,'data','nova.sqlite');
fs.mkdirSync(path.dirname(file),{recursive:true});
const db=new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','vendor','customer')), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS vendors(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id), store_name TEXT NOT NULL, description TEXT DEFAULT '', commission_rate REAL NOT NULL DEFAULT 10, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), category_id INTEGER REFERENCES categories(id), name TEXT NOT NULL, description TEXT DEFAULT '', price INTEGER NOT NULL CHECK(price>=0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0), image TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES users(id), total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), vendor_id INTEGER NOT NULL REFERENCES vendors(id), quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, commission INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wallets(id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL UNIQUE REFERENCES vendors(id), balance INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wallet_transactions(id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), order_id INTEGER REFERENCES orders(id), type TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settlements(id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, details TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL);
`);

function hasColumn(table,name){return db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name===name)}
function ensureColumn(table,name,definition){if(!hasColumn(table,name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+definition)}
function migrate(){
 ensureColumn('vendors','commission_override','REAL');
 ensureColumn('orders','currency_code',"TEXT NOT NULL DEFAULT 'IRR'");
 ensureColumn('orders','commission_total','INTEGER NOT NULL DEFAULT 0');
 ensureColumn('orders','payment_status',"TEXT NOT NULL DEFAULT 'unpaid'");
 ensureColumn('order_items','commission_rate','REAL NOT NULL DEFAULT 10');
 ensureColumn('wallet_transactions','ref_key','TEXT');
 ensureColumn('settlements','processed_at','TEXT');
 ensureColumn('settlements','processed_by','INTEGER REFERENCES users(id)');
 ensureColumn('settlements','external_reference','TEXT');
 ensureColumn('settlements','rejection_reason','TEXT');
 db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
 db.exec("CREATE TABLE IF NOT EXISTS payment_transactions(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),customer_id INTEGER NOT NULL REFERENCES users(id),provider TEXT NOT NULL DEFAULT 'test_gateway',mode TEXT NOT NULL DEFAULT 'test' CHECK(mode IN ('test')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','cancelled')),amount INTEGER NOT NULL CHECK(amount>=0),currency_code TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,failure_reason TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,paid_at TEXT)");
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_ref_key ON wallet_transactions(ref_key) WHERE ref_key IS NOT NULL');
 db.exec('CREATE INDEX IF NOT EXISTS idx_payments_order ON payment_transactions(order_id)');
 db.exec('CREATE INDEX IF NOT EXISTS idx_payments_customer ON payment_transactions(customer_id)');
 db.exec('CREATE INDEX IF NOT EXISTS idx_settlements_vendor_status ON settlements(vendor_id,status)');
 const seed=db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
 for(const pair of [['currency_code','IRR'],['currency_symbol','تومان'],['currency_name','تومان'],['commission_rate','10'],['payment_mode','test']])seed.run(...pair);
 db.prepare("UPDATE orders SET payment_status='succeeded' WHERE status='paid_test' AND payment_status='unpaid'").run();
 // Reserve legacy pending settlements once; ambiguous/overcommitted legacy requests are flagged for review.
 const reserveLegacy=db.transaction(()=>{
  const rows=db.prepare("SELECT * FROM settlements WHERE status='pending' ORDER BY id").all();
  for(const item of rows){
   const key='settlement_hold:'+item.id;
   if(db.prepare('SELECT id FROM wallet_transactions WHERE ref_key=?').get(key))continue;
   const wallet=db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(item.vendor_id);
   if(wallet&&wallet.balance>=item.amount){
    db.prepare('UPDATE wallets SET balance=balance-? WHERE vendor_id=?').run(item.amount,item.vendor_id);
    db.prepare("INSERT INTO wallet_transactions(vendor_id,type,amount,note,ref_key) VALUES(?,?,?,?,?)").run(item.vendor_id,'settlement_hold',-item.amount,'رزرو درخواست تسویه قدیمی',key);
   }else{
    db.prepare("UPDATE settlements SET status='needs_review',rejection_reason='درخواست قدیمی با مانده کیف پول تطبیق داده نشد' WHERE id=?").run(item.id);
   }
  }
 });
 reserveLegacy();
}
migrate();

const bcrypt=require('bcryptjs');
const adminEmail=(process.env.ADMIN_EMAIL||'admin@novamarket.local').toLowerCase();
const adminPassword=process.env.ADMIN_PASSWORD||'ChangeThisAdmin123!';
if(!db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)){
 db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)').run('مدیر NOVA MARKET',adminEmail,bcrypt.hashSync(adminPassword,12),'admin');
}
const cats=[['دیجیتال','digital'],['مد و پوشاک','fashion'],['خانه و زندگی','home'],['زیبایی و سلامت','beauty'],['ورزش و سفر','sport']];
const add=db.prepare('INSERT OR IGNORE INTO categories(name,slug) VALUES(?,?)');
for(const c of cats)add.run(...c);
// A clearly labelled sample storefront keeps a fresh preview from appearing empty.
const crypto=require('crypto');
const demoEmail='catalog-demo@novamarket.local';
let demoUser=db.prepare('SELECT id FROM users WHERE email=?').get(demoEmail);
if(!demoUser){
 const r=db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)').run('NOVA Sample Store',demoEmail,require('bcryptjs').hashSync(crypto.randomBytes(32).toString('hex'),10),'vendor');
 demoUser={id:r.lastInsertRowid};
}
let demoVendor=db.prepare('SELECT id FROM vendors WHERE user_id=?').get(demoUser.id);
if(!demoVendor){
 const r=db.prepare("INSERT INTO vendors(user_id,store_name,description,status,commission_rate) VALUES(?,?,?,?,?)").run(demoUser.id,'NOVA Select','فروشگاه نمونه برای نمایش امکانات بازارچه','approved',10);
 demoVendor={id:r.lastInsertRowid};
}
if(db.prepare('SELECT COUNT(*) n FROM products').get().n===0){
 const samples=[
  [1,'هدفون بی‌سیم استودیو','صدای شفاف با طراحی مینیمال و شارژدهی طولانی',2890000,24,'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=900'],
  [1,'ساعت هوشمند سری Nova','نمایشگر باکیفیت و پایش فعالیت‌های روزانه',4190000,18,'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=900'],
  [2,'کیف دستی روزمره','طراحی ساده و کاربردی برای استفاده روزانه',1790000,15,'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=900'],
  [2,'کتانی مینیمال','راحتی و استایل برای استفاده روزانه',2350000,20,'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=900'],
  [3,'چراغ رومیزی مدرن','نور گرم برای فضای کار و مطالعه',1290000,12,'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=900'],
  [3,'گلدان سرامیکی','جزئیات ظریف برای دکور خانه',690000,30,'https://images.unsplash.com/photo-1578500494198-246f612d3b3d?w=900'],
  [4,'ست مراقبت پوست','روتین ساده برای مراقبت روزانه',990000,16,'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?w=900'],
  [5,'کوله‌پشتی شهری','فضای مناسب برای وسایل روزانه و سفر کوتاه',1590000,14,'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=900']
 ];
 const insert=db.prepare('INSERT INTO products(vendor_id,category_id,name,description,price,stock,image) VALUES(?,?,?,?,?,?,?)');
 const tx=db.transaction(()=>{for(const p of samples)insert.run(demoVendor.id,...p)});
 tx();
}

db.migrate=migrate;
module.exports=db;
