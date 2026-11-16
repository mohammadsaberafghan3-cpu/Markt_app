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
const bcrypt=require('bcryptjs');
const adminEmail=(process.env.ADMIN_EMAIL||'admin@novamarket.local').toLowerCase();
const adminPassword=process.env.ADMIN_PASSWORD||'ChangeThisAdmin123!';
if(!db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)){
 db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)').run('مدیر NOVA MARKET',adminEmail,bcrypt.hashSync(adminPassword,12),'admin');
}
const cats=[['دیجیتال','digital'],['مد و پوشاک','fashion'],['خانه و زندگی','home'],['زیبایی و سلامت','beauty'],['ورزش و سفر','sport']];
const add=db.prepare('INSERT OR IGNORE INTO categories(name,slug) VALUES(?,?)');
for(const c of cats)add.run(...c);
module.exports=db;
