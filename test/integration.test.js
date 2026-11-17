const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const Database=require('better-sqlite3');

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nova-original-mvp-'));
process.env.DATABASE_PATH=path.join(temp,'app.sqlite');
process.env.ADMIN_EMAIL='admin@nova.test';
process.env.ADMIN_PASSWORD='AdminSecurePass123!';
process.env.SESSION_SECRET='integration-test-session-secret-with-more-than-32-characters';
process.env.NODE_ENV='test';

const app=require('../server');
const db=app.db;
let server,base;
class Client{
 constructor(){this.cookie=''}
 async request(url,method='GET',body,headers={}){
  const h={...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers};
  if(this.cookie)h.Cookie=this.cookie;
  const response=await fetch(base+url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];
  return {status:response.status,data:await response.json().catch(()=>({}))};
 }
}
const admin=new Client(),seller=new Client(),buyer=new Client();
async function register(client,name,email){const r=await client.request('/api/register','POST',{name,email,password:'SecureTestPass123!'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.user}
async function login(client,email,password){const r=await client.request('/api/login','POST',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.user}

test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port});
test.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));try{db.close()}catch{}fs.rmSync(temp,{recursive:true,force:true})});

test('seller approval, idempotent test payment, commission, wallet, settlement and refund lifecycle',async()=>{
 const health=await buyer.request('/health');assert.equal(health.status,200);assert.equal(health.data.ok,true);
 const config=await buyer.request('/api/config');assert.equal(config.status,200);assert.equal(config.data.paymentMode,'test');

 await login(admin,'admin@nova.test','AdminSecurePass123!');
 const settings=await admin.request('/api/admin/settings','PUT',{currency:'EUR',commission_rate:12,payment_mode:'test'});
 assert.equal(settings.status,200);
 const invalid=await admin.request('/api/admin/settings','PUT',{commission_rate:75,payment_mode:'real'});
 assert.equal(invalid.status,400);

 await register(seller,'فروشنده آزمون','seller@nova.test');
 const application=await seller.request('/api/seller/apply','POST',{shop_name:'NOVA Seller Test',description:'فروشگاه آزمایشی'});
 assert.equal(application.status,201);assert.equal(application.data.status,'pending');
 const pendingAccess=await seller.request('/api/seller/wallet');assert.equal(pendingAccess.status,403);
 const approved=await admin.request('/api/admin/seller-applications/'+application.data.id,'PATCH',{status:'approved'});
 assert.equal(approved.status,200);
 const walletEmpty=await seller.request('/api/seller/wallet');assert.equal(walletEmpty.status,200);
 const category=db.prepare("SELECT id FROM categories WHERE slug='electronics'").get().id;
 const product=await admin.request('/api/manage/products','POST',{seller_id:seller.cookie?db.prepare("SELECT id FROM users WHERE email='seller@nova.test'").get().id:null,category_id:category,title:'محصول مالی آزمون',description:'برای آزمون چرخه مالی',price:100,stock:10,sku:'NOVA-FIN-001'});
 assert.equal(product.status,200,JSON.stringify(product.data));

 await register(buyer,'مشتری آزمون','buyer@nova.test');
 const orderBody={items:[{id:product.data.id,quantity:2}],address:'Berlin, Test Street 10'};
 const order=await buyer.request('/api/orders','POST',orderBody,{'Idempotency-Key':'nova-order-test-0001'});
 assert.equal(order.status,201,JSON.stringify(order.data));assert.equal(order.data.paymentMode,'test');assert.equal(order.data.paymentStatus,'pending');assert.equal(order.data.total,200);
 const duplicate=await buyer.request('/api/orders','POST',orderBody,{'Idempotency-Key':'nova-order-test-0001'});
 assert.equal(duplicate.status,200);assert.equal(duplicate.data.orderId,order.data.orderId);assert.equal(duplicate.data.paymentReference,order.data.paymentReference);
 const snapshot=db.prepare('SELECT commission_rate,commission_amount FROM order_items WHERE order_id=?').get(order.data.orderId);
 assert.equal(snapshot.commission_rate,12);assert.equal(snapshot.commission_amount,24);
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.data.id).stock,10);

 const paid=await buyer.request('/api/payments/test/confirm','POST',{reference:order.data.paymentReference});
 assert.equal(paid.status,200,JSON.stringify(paid.data));assert.equal(paid.data.ok,true);
 const paidAgain=await buyer.request('/api/payments/test/confirm','POST',{reference:order.data.paymentReference});
 assert.equal(paidAgain.status,200);assert.equal(paidAgain.data.alreadyPaid,true);
 assert.equal(db.prepare("SELECT status FROM payment_transactions WHERE reference=?").get(order.data.paymentReference).status,'paid');
 assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(order.data.orderId).payment_status,'paid');
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.data.id).stock,8);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM seller_wallet_entries WHERE reference_key LIKE ?").get('payment:%').n,1);
 assert.equal(db.prepare('SELECT balance FROM (SELECT SUM(CASE WHEN type="credit" THEN amount ELSE -amount END) balance FROM seller_wallet_entries WHERE seller_id=?)').get(db.prepare("SELECT id FROM users WHERE email='seller@nova.test'").get().id).balance,176);

 const wallet=await seller.request('/api/seller/wallet');
 assert.equal(wallet.status,200);assert.equal(wallet.data.balances[0].balance,176);
 const settlement=await seller.request('/api/seller/settlements','POST',{amount:100,currency:'EUR'});
 assert.equal(settlement.status,201,JSON.stringify(settlement.data));
 const held=await seller.request('/api/seller/wallet');
 assert.equal(held.data.balances[0].heldSettlement,100);assert.equal(held.data.balances[0].available,76);
 const approvedSettlement=await admin.request('/api/admin/settlements/'+settlement.data.id,'PATCH',{status:'approved'});
 assert.equal(approvedSettlement.status,200);
 const noReference=await admin.request('/api/admin/settlements/'+settlement.data.id,'PATCH',{status:'paid'});
 assert.equal(noReference.status,409);
 const paidSettlement=await admin.request('/api/admin/settlements/'+settlement.data.id,'PATCH',{status:'paid',payout_reference:'MANUAL-TEST-REF-001'});
 assert.equal(paidSettlement.status,200);assert.equal(paidSettlement.data.manualOnly,true);
 const afterSettlement=await seller.request('/api/seller/wallet');
 assert.equal(afterSettlement.data.balances[0].balance,76);

 const secondSettlement=await seller.request('/api/seller/settlements','POST',{amount:50,currency:'EUR'});
 assert.equal(secondSettlement.status,201);
 const rejected=await admin.request('/api/admin/settlements/'+secondSettlement.data.id,'PATCH',{status:'rejected'});
 assert.equal(rejected.status,200);
 const afterReject=await seller.request('/api/seller/wallet');
 assert.equal(afterReject.data.balances[0].available,76);

 const refundRequest=await buyer.request('/api/orders/'+order.data.orderId+'/refund','POST',{reason:'آزمون بازپرداخت'});
 assert.equal(refundRequest.status,201);assert.equal(refundRequest.data.simulationOnly,true);
 const refundHold=await seller.request('/api/seller/wallet');
 assert.equal(refundHold.data.balances[0].heldRefund,176);
 const refund=await admin.request('/api/admin/refunds/'+refundRequest.data.id,'PATCH',{status:'approved',admin_note:'تأیید آزمایشی'});
 assert.equal(refund.status,200);assert.equal(refund.data.simulationOnly,true);
 assert.equal(db.prepare('SELECT status FROM payment_transactions WHERE order_id=?').get(order.data.orderId).status,'refunded');
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.data.orderId).status,'refunded');
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.data.id).stock,10);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM marketplace_commission_reversals WHERE order_id=?').get(order.data.orderId).n,1);

 const failedOrder=await buyer.request('/api/orders','POST',{items:[{id:product.data.id,quantity:1}],address:'Berlin, Test Street 10'},{'Idempotency-Key':'nova-order-test-0002'});
 assert.equal(failedOrder.status,201);
 const failed=await buyer.request('/api/payments/test/fail','POST',{reference:failedOrder.data.paymentReference});
 assert.equal(failed.status,200);assert.equal(failed.data.status,'failed');
 assert.equal(db.prepare('SELECT status FROM payment_transactions WHERE order_id=?').get(failedOrder.data.orderId).status,'failed');

 const forbidden=await buyer.request('/api/admin/settings');
 assert.equal(forbidden.status,403);
 const commissionLedger=await admin.request('/api/admin/commissions');
 assert.equal(commissionLedger.status,200);assert.ok(commissionLedger.data.length>=1);
});

test('legacy database receives additive finance migrations without losing existing records',()=>{
 const legacyPath=path.join(temp,'legacy.sqlite'),old=new Database(legacyPath);
 old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',status TEXT NOT NULL DEFAULT 'active',created_at TEXT DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE orders(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,total REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'EUR',status TEXT NOT NULL DEFAULT 'new',address TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE order_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,product_id INTEGER NOT NULL,seller_id INTEGER,title TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price REAL NOT NULL);"+
 "CREATE TABLE payment_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL UNIQUE,provider TEXT NOT NULL DEFAULT 'mock',mode TEXT NOT NULL DEFAULT 'test',amount REAL NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reference TEXT NOT NULL UNIQUE,provider_reference TEXT,payload_json TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP,paid_at TEXT);"+
 "CREATE TABLE seller_applications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,shop_name TEXT NOT NULL,description TEXT DEFAULT '',contact_phone TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',admin_note TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,reviewed_at TEXT,UNIQUE(user_id));"+
 "CREATE TABLE seller_wallet_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,seller_id INTEGER NOT NULL,order_id INTEGER,settlement_id INTEGER,type TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,description TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP);"+
 "CREATE TABLE settlements(id INTEGER PRIMARY KEY AUTOINCREMENT,seller_id INTEGER NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',payout_reference TEXT,admin_note TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,reviewed_at TEXT);"+
 "CREATE TABLE refund_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL UNIQUE,customer_id INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'requested',admin_note TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,reviewed_at TEXT);"+
 "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
 const user=old.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Legacy Customer','legacy@nova.test','x','customer')").run();
 const order=old.prepare("INSERT INTO orders(customer_id,total,currency,status,address) VALUES(?,100,'EUR','new','Legacy address')").run(user.lastInsertRowid);
 old.prepare("INSERT INTO payment_transactions(order_id,amount,currency,status,reference) VALUES(?,100,'EUR','paid','LEGACY-PAID-001')").run(order.lastInsertRowid);
 old.close();
 const child=spawnSync(process.execPath,['-e',"const app=require('./server');app.db.close()"],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:{...process.env,DATABASE_PATH:legacyPath,ADMIN_EMAIL:'migration-admin@nova.test',ADMIN_PASSWORD:'MigrationAdminPass123!',SESSION_SECRET:'migration-session-secret-long-enough-for-tests',NODE_ENV:'test'}});
 assert.equal(child.status,0,child.stderr||child.stdout);
 const upgraded=new Database(legacyPath);
 const orderColumns=upgraded.prepare('PRAGMA table_info(orders)').all().map(x=>x.name);
 const paymentColumns=upgraded.prepare('PRAGMA table_info(payment_transactions)').all().map(x=>x.name);
 assert.ok(orderColumns.includes('payment_status'));assert.ok(orderColumns.includes('commission_total'));
 assert.ok(paymentColumns.includes('idempotency_key'));assert.ok(paymentColumns.includes('request_hash'));
 assert.equal(upgraded.prepare('SELECT payment_status FROM orders WHERE id=?').get(order.lastInsertRowid).payment_status,'paid');
 assert.equal(upgraded.prepare('SELECT reference FROM payment_transactions WHERE order_id=?').get(order.lastInsertRowid).reference,'LEGACY-PAID-001');
 assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'").get());
 upgraded.close();
});
