const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-test-'));
process.env.DATABASE_PATH=path.join(dir,'test.sqlite');
process.env.ADMIN_EMAIL='test-admin@nova.local';
process.env.ADMIN_PASSWORD='TestOnlyPassword123!';
const db=require('../db');
test('database initializes core marketplace tables and admin account',()=>{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
 for(const t of ['users','vendors','products','orders','order_items','wallets','wallet_transactions','settlements','audit_logs'])assert.ok(tables.includes(t),t+' table missing');
 assert.equal(db.prepare('SELECT role FROM users WHERE email=?').get('test-admin@nova.local').role,'admin');
});
test('foreign keys are enabled',()=>assert.equal(db.pragma('foreign_keys',{simple:true}),1));
test('product stock cannot be negative',()=>{
 const u=db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Vendor','vendor@nova.local','x','vendor')").run();
 const v=db.prepare("INSERT INTO vendors(user_id,store_name,status) VALUES(?,?,?)").run(u.lastInsertRowid,'Test Store','approved');
 assert.throws(()=>db.prepare('INSERT INTO products(vendor_id,name,price,stock) VALUES(?,?,?,?)').run(v.lastInsertRowid,'Invalid',100,-1));
});
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})});
