const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const Database=require('better-sqlite3');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-market-test-'));
process.env.DATABASE_PATH=path.join(dir,'nova.sqlite');
process.env.ADMIN_EMAIL='admin-test@nova.local';
process.env.ADMIN_PASSWORD='TestOnlyAdminPass123!';
process.env.SESSION_SECRET='test-session-secret-that-is-long-enough';
process.env.NODE_ENV='test';

const db=require('./db');
const app=require('../server');
let server,base;
class Client{
 constructor(){this.cookie=''}
 async request(url,method,body,headers){
  const h={...(body!==undefined?{'Content-Type':'application/json'}:{}),...(headers||{})};
  if(this.cookie)h.Cookie=this.cookie;
  const response=await fetch(base+url,{method:method||'GET',headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  const setCookie=response.headers.get('set-cookie');if(setCookie)this.cookie=setCookie.split(';')[0];
  const data=await response.json().catch(()=>({}));
  return {status:response.status,data};
 }
}
const admin=new Client(),seller=new Client(),buyer=new Client();
async function login(client,email,password){const r=await client.request('/api/login','POST',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return r.data}
async function register(client,name,email){const r=await client.request('/api/register','POST',{name,email,password:'SecurePass123!'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data}

test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port});
test.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));try{db.close()}catch{}fs.rmSync(dir,{recursive:true,force:true})});

test('test payment, configurable commission, seller approval and settlement reservation lifecycle',async()=>{
 db.migrate();db.migrate();
 const config=await buyer.request('/api/public/config');
 assert.equal(config.status,200);assert.equal(config.data.paymentMode,'test');assert.equal(config.data.currency.code,'IRR');

 await login(admin,'admin-test@nova.local','TestOnlyAdminPass123!');
 const setting=await admin.request('/api/admin/settings','PATCH',{currency_code:'EUR',currency_symbol:'€',currency_name:'یورو',commission_rate:12});
 assert.equal(setting.status,200);assert.equal(setting.data.currency.code,'EUR');assert.equal(setting.data.commissionRate,12);
 const invalidSetting=await admin.request('/api/admin/settings','PATCH',{currency_code:'EUR',currency_symbol:'€',currency_name:'یورو',commission_rate:70});
 assert.equal(invalidSetting.status,400);

 await register(seller,'فروشنده آزمایشی','seller@nova.local');
 const application=await seller.request('/api/vendor/apply','POST',{store_name:'NOVA Seller Test'});
 assert.equal(application.status,201);assert.equal(application.data.status,'pending');
 const sellerPending=await seller.request('/api/vendor/products','POST',{name:'محصول ممنوع',price:100,stock:2});
 assert.equal(sellerPending.status,403);
 const appStatus=await seller.request('/api/vendor/application');
 assert.equal(appStatus.data.application.status,'pending');
 const approve=await admin.request('/api/admin/vendors/'+application.data.id,'PATCH',{status:'approved'});
 assert.equal(approve.status,200);
 await seller.request('/api/logout','POST',{});
 await login(seller,'seller@nova.local','SecurePass123!');
 const category=db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get().id;
 const product=await seller.request('/api/vendor/products','POST',{name:'محصول آزمون مالی',description:'محصول تست چرخه پرداخت',price:10000,stock:10,category_id:category});
 assert.equal(product.status,201);
 const walletBefore=db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance;
 assert.equal(walletBefore,0);

 await register(buyer,'مشتری آزمایشی','buyer@nova.local');
 const cart={items:[{product_id:product.data.id,quantity:2}]};
 const first=await buyer.request('/api/orders','POST',cart,{'Idempotency-Key':'checkout-test-key-001'});
 assert.equal(first.status,201,JSON.stringify(first.data));
 assert.equal(first.data.paymentMode,'test');assert.equal(first.data.paymentStatus,'pending');assert.equal(first.data.amount,20000);
 const duplicate=await buyer.request('/api/orders','POST',cart,{'Idempotency-Key':'checkout-test-key-001'});
 assert.equal(duplicate.status,200);assert.equal(duplicate.data.orderId,first.data.orderId);assert.equal(duplicate.data.paymentId,first.data.paymentId);
 const pendingOrder=db.prepare('SELECT * FROM orders WHERE id=?').get(first.data.orderId);
 assert.equal(pendingOrder.status,'awaiting_payment');assert.equal(pendingOrder.payment_status,'pending');
 assert.equal(db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance,0);
 assert.equal(db.prepare('SELECT commission_rate FROM order_items WHERE order_id=?').get(first.data.orderId).commission_rate,12);

 const paid=await buyer.request('/api/payments/'+first.data.paymentId+'/test-confirm','POST',{});
 assert.equal(paid.status,200,JSON.stringify(paid.data));assert.equal(paid.data.paymentStatus,'succeeded');
 const paidAgain=await buyer.request('/api/payments/'+first.data.paymentId+'/test-confirm','POST',{});
 assert.equal(paidAgain.status,200);assert.equal(paidAgain.data.alreadyProcessed,true);
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(first.data.orderId);
 assert.equal(order.status,'paid_test');assert.equal(order.payment_status,'succeeded');
 assert.equal(db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance,17600);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE ref_key LIKE ?").get('payment:'+first.data.paymentId+':vendor:%').n,1);
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.data.id).stock,8);

 const settlement=await seller.request('/api/vendor/settlements','POST',{amount:10000});
 assert.equal(settlement.status,201,JSON.stringify(settlement.data));
 assert.equal(db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance,7600);
 const overdraw=await seller.request('/api/vendor/settlements','POST',{amount:8000});
 assert.equal(overdraw.status,400);
 const approved=await admin.request('/api/admin/settlements/'+settlement.data.id,'PATCH',{status:'approved'});
 assert.equal(approved.status,200);
 assert.equal(db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance,7600);
 const paidManual=await admin.request('/api/admin/settlements/'+settlement.data.id,'PATCH',{status:'paid_manual',external_reference:'BANK-REF-TEST-001'});
 assert.equal(paidManual.status,200);assert.equal(paidManual.data.manualOnly,true);
 assert.equal(db.prepare('SELECT status FROM settlements WHERE id=?').get(settlement.data.id).status,'paid_manual');

 const rejectedRequest=await seller.request('/api/vendor/settlements','POST',{amount:5000});
 assert.equal(rejectedRequest.status,201);
 const rejected=await admin.request('/api/admin/settlements/'+rejectedRequest.data.id,'PATCH',{status:'rejected'});
 assert.equal(rejected.status,200);
 assert.equal(db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance,7600);
 const vendorSummary=await seller.request('/api/vendor/summary');
 assert.equal(vendorSummary.status,200);assert.equal(vendorSummary.data.availableBalance,7600);

 const override=await admin.request('/api/admin/vendors/'+application.data.id,'PATCH',{commission_override:5});
 assert.equal(override.status,200);
 const failedOrder=await buyer.request('/api/orders','POST',{items:[{product_id:product.data.id,quantity:1}]},{'Idempotency-Key':'checkout-test-key-002'});
 assert.equal(failedOrder.status,201);
 assert.equal(db.prepare('SELECT commission_rate FROM order_items WHERE order_id=?').get(failedOrder.data.orderId).commission_rate,5);
 const failed=await buyer.request('/api/payments/'+failedOrder.data.paymentId+'/test-fail','POST',{});
 assert.equal(failed.status,200);assert.equal(failed.data.paymentStatus,'failed');
 assert.equal(db.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(application.data.id).balance,7600);
 assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(failedOrder.data.orderId).payment_status,'failed');

 const forbidden=await buyer.request('/api/admin/settings');
 assert.equal(forbidden.status,403);
 const payments=await admin.request('/api/admin/payments');
 assert.equal(payments.status,200);assert.ok(payments.data.length>=2);
 const badIdempotency=await buyer.request('/api/orders','POST',cart,{'Idempotency-Key':'checkout-test-key-001'});
 assert.equal(badIdempotency.status,200);
});


test('legacy SQLite database is upgraded additively and overcommitted pending settlements are flagged',()=>{
 const legacyPath=path.join(dir,'legacy.sqlite'),old=new Database(legacyPath);
 old.exec("PRAGMA foreign_keys=ON;"+
 "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','vendor','customer')),status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE vendors(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),store_name TEXT NOT NULL,description TEXT DEFAULT '',commission_rate REAL NOT NULL DEFAULT 10,status TEXT NOT NULL DEFAULT 'pending');"+
 "CREATE TABLE wallets(id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL UNIQUE REFERENCES vendors(id),balance INTEGER NOT NULL DEFAULT 0);"+
 "CREATE TABLE settlements(id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL REFERENCES vendors(id),amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE wallet_transactions(id INTEGER PRIMARY KEY,vendor_id INTEGER NOT NULL REFERENCES vendors(id),order_id INTEGER,type TEXT NOT NULL,amount INTEGER NOT NULL,note TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES users(id),total INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),product_id INTEGER NOT NULL,vendor_id INTEGER NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,commission INTEGER NOT NULL);"+
 "CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_id INTEGER,action TEXT NOT NULL,details TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);");
 const user=old.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Legacy Seller','legacy-seller@nova.local','x','vendor')").run();
 const vendor=old.prepare("INSERT INTO vendors(user_id,store_name,status) VALUES(?,?,'approved')").run(user.lastInsertRowid,'Legacy Store');
 old.prepare('INSERT INTO wallets(vendor_id,balance) VALUES(?,1000)').run(vendor.lastInsertRowid);
 old.prepare("INSERT INTO settlements(vendor_id,amount,status) VALUES(?,700,'pending')").run(vendor.lastInsertRowid);
 old.prepare("INSERT INTO settlements(vendor_id,amount,status) VALUES(?,500,'pending')").run(vendor.lastInsertRowid);
 old.close();
 const child=spawnSync(process.execPath,['-e',"const db=require('./db');db.close()"],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:{...process.env,DATABASE_PATH:legacyPath,ADMIN_EMAIL:'legacy-admin@nova.local',ADMIN_PASSWORD:'LegacyAdminPass123!',SESSION_SECRET:'legacy-session-secret-long-enough',NODE_ENV:'test'}});
 assert.equal(child.status,0,child.stderr||child.stdout);
 const upgraded=new Database(legacyPath);
 const columns=upgraded.prepare('PRAGMA table_info(orders)').all().map(x=>x.name);
 assert.ok(columns.includes('currency_code'));assert.ok(columns.includes('payment_status'));
 assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_transactions'").get());
 assert.equal(upgraded.prepare('SELECT balance FROM wallets WHERE vendor_id=?').get(vendor.lastInsertRowid).balance,300);
 assert.equal(upgraded.prepare('SELECT status FROM settlements WHERE id=1').get().status,'pending');
 assert.equal(upgraded.prepare('SELECT status FROM settlements WHERE id=2').get().status,'needs_review');
 assert.equal(upgraded.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE ref_key='settlement_hold:1'").get().n,1);
 upgraded.close();
});
