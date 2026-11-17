const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const helmet=require('helmet');
const path=require('path');
const crypto=require('crypto');
if(process.env.NODE_ENV==='production'&&(!process.env.ADMIN_PASSWORD||!process.env.SESSION_SECRET))throw new Error('Set ADMIN_PASSWORD and SESSION_SECRET before production startup');
const db=require('./db');
class BetterSqliteSessionStore extends session.Store{
 get(sid,callback){
  try{const row=db.prepare('SELECT sess,expired FROM sessions WHERE sid=?').get(sid);if(!row)return callback(null,null);if(row.expired<=Date.now()){db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);return callback(null,null)}callback(null,JSON.parse(row.sess))}catch(err){callback(err)}
 }
 set(sid,sess,callback){
  try{const expires=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires).getTime():Date.now()+7*864e5;db.prepare('INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expired=excluded.expired').run(sid,JSON.stringify(sess),expires);if(callback)callback(null)}catch(err){if(callback)callback(err)}
 }
 touch(sid,sess,callback){
  try{const expires=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires).getTime():Date.now()+7*864e5;db.prepare('UPDATE sessions SET expired=? WHERE sid=?').run(expires,sid);if(callback)callback(null)}catch(err){if(callback)callback(err)}
 }
 destroy(sid,callback){
  try{db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);if(callback)callback(null)}catch(err){if(callback)callback(err)}
 }
}
const app=express();
const PORT=process.env.PORT||3000;
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({store:new BetterSqliteSessionStore(),secret:process.env.SESSION_SECRET||'development-only-change-me',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*864e5}}));
app.use(express.static(path.join(__dirname,'public')));

const safe=u=>u?({id:u.id,name:u.name,email:u.email,role:u.role}):null;
const now=()=>new Date().toISOString();
const positiveId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const readSettings=()=>Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value]));
const publicSettings=()=>{const s=readSettings();return {currency:{code:s.currency_code||'IRR',symbol:s.currency_symbol||'تومان',name:s.currency_name||'تومان'},commissionRate:Number(s.commission_rate||10),paymentMode:'test'}};
function auth(req,res,next){
 if(!req.session.user)return res.status(401).json({error:'ابتدا وارد حساب شوید'});
 const current=db.prepare('SELECT id,name,email,role,status FROM users WHERE id=?').get(req.session.user.id);
 if(!current||current.status!=='active'){req.session.destroy(()=>{});return res.status(401).json({error:'حساب کاربری فعال نیست'})}
 req.session.user=safe(current);next();
}
function role(...roles){return(req,res,next)=>{if(!req.session.user||!roles.includes(req.session.user.role))return res.status(403).json({error:'اجازه دسترسی ندارید'});if(roles.includes('vendor')){const v=db.prepare('SELECT status FROM vendors WHERE user_id=?').get(req.session.user.id);if(!v||v.status!=='approved')return res.status(403).json({error:'دسترسی فروشندگی تا تأیید مدیر فعال نمی‌شود'})}next()}}
function audit(actor,action,details){db.prepare('INSERT INTO audit_logs(actor_id,action,details) VALUES(?,?,?)').run(actor||null,action,String(details||''))}
function getVendor(userId){return db.prepare('SELECT * FROM vendors WHERE user_id=?').get(userId)}
function getWallet(vendorId){db.prepare('INSERT OR IGNORE INTO wallets(vendor_id,balance) VALUES(?,0)').run(vendorId);return db.prepare('SELECT * FROM wallets WHERE vendor_id=?').get(vendorId)}
function addWalletEntry(entry){
 const w=getWallet(entry.vendorId);
 if(entry.amount<0&&w.balance < -entry.amount)throw new Error('موجودی قابل برداشت کافی نیست');
 const result=db.prepare('INSERT OR IGNORE INTO wallet_transactions(vendor_id,order_id,type,amount,note,ref_key) VALUES(?,?,?,?,?,?)').run(entry.vendorId,entry.orderId||null,entry.type,entry.amount,entry.note||'',entry.refKey||null);
 if(result.changes)db.prepare('UPDATE wallets SET balance=balance+? WHERE vendor_id=?').run(entry.amount,entry.vendorId);
 return result.changes===1;
}
function regenerateSession(req,res,user,statusCode){
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'ساخت نشست امن انجام نشد'});req.session.user=safe(user);res.status(statusCode||200).json({user:req.session.user})});
}
function requestHash(items){return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex')}
function paymentReference(){return 'NOVA-TEST-'+crypto.randomBytes(8).toString('hex').toUpperCase()}
function statusLabel(s){return ({pending:'در انتظار بررسی',approved:'تأیید شده برای پرداخت دستی',paid_manual:'پرداخت دستی ثبت شد',rejected:'رد شده',needs_review:'نیازمند بررسی'}[s]||s)}

app.get('/health',(req,res)=>res.json({ok:true,service:'nova-market',version:'2.1.0'}));
app.get('/api/public/config',(req,res)=>res.json(publicSettings()));
app.get('/api/me',(req,res)=>res.json({user:safe(req.session.user)}));
app.post('/api/register',(req,res)=>{
 const name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
 if(name.length<2||name.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>190||password.length<10||password.length>200)return res.status(400).json({error:'نام، ایمیل معتبر و رمز حداقل ۱۰ کاراکتری لازم است'});
 try{const info=db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'customer')").run(name,email,bcrypt.hashSync(password,12));regenerateSession(req,res,db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid),201)}catch(e){res.status(409).json({error:'این ایمیل قبلاً ثبت شده است'})}
});
app.post('/api/login',(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
 const u=db.prepare('SELECT * FROM users WHERE email=? AND status=?').get(email,'active');
 if(!u||!bcrypt.compareSync(password,u.password_hash))return res.status(401).json({error:'ایمیل یا رمز عبور اشتباه است'});
 regenerateSession(req,res,u,200);
});
app.post('/api/logout',(req,res)=>req.session.destroy(err=>{if(err)return res.status(500).json({error:'خروج انجام نشد'});res.clearCookie('connect.sid');res.json({ok:true})}));

app.get('/api/categories',(req,res)=>res.json(db.prepare('SELECT * FROM categories ORDER BY name').all()));
app.get('/api/products',(req,res)=>{
 const q=String(req.query.q||'').trim().slice(0,100),cat=positiveId(req.query.category);
 const rows=db.prepare("SELECT p.id,p.name,p.description,p.price,p.stock,p.image,c.name category,v.store_name vendor FROM products p JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.status='active' AND v.status='approved' AND (?='' OR p.name LIKE ? OR p.description LIKE ?) AND (? IS NULL OR p.category_id=?) ORDER BY p.id DESC LIMIT 100").all(q,'%'+q+'%','%'+q+'%',cat,cat);
 res.json(rows);
});
app.get('/api/products/:id',(req,res)=>{const id=positiveId(req.params.id);if(!id)return res.status(400).json({error:'شناسه محصول نامعتبر است'});const p=db.prepare("SELECT p.*,v.store_name vendor,c.name category FROM products p JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.status='active' AND v.status='approved'").get(id);if(!p)return res.status(404).json({error:'محصول پیدا نشد'});res.json(p)});

app.get('/api/vendor/application',auth,(req,res)=>{const v=getVendor(req.session.user.id);res.json({application:v?{id:v.id,store_name:v.store_name,description:v.description,status:v.status}:null})});
app.post('/api/vendor/apply',auth,(req,res)=>{
 if(req.session.user.role!=='customer')return res.status(400).json({error:'این حساب در حال حاضر امکان درخواست فروشندگی ندارد'});
 const name=String(req.body?.store_name||'').trim(),description=String(req.body?.description||'').trim();
 if(name.length<2||name.length>100||description.length>1000)return res.status(400).json({error:'نام فروشگاه باید ۲ تا ۱۰۰ نویسه و توضیحات حداکثر ۱۰۰۰ نویسه باشد'});
 try{
  const existing=getVendor(req.session.user.id);
  if(existing&&['pending','approved','suspended'].includes(existing.status))return res.status(409).json({error:'برای این حساب درخواست فعال یا فروشگاه موجود است'});
  if(existing){db.prepare("UPDATE vendors SET store_name=?,description=?,status='pending' WHERE id=?").run(name,description,existing.id);audit(req.session.user.id,'vendor.resubmit',existing.id+':'+name);return res.status(200).json({id:existing.id,status:'pending'})}
  const r=db.prepare("INSERT INTO vendors(user_id,store_name,description,status) VALUES(?,?,?,'pending')").run(req.session.user.id,name,description);
  audit(req.session.user.id,'vendor.apply',r.lastInsertRowid+':'+name);res.status(201).json({id:r.lastInsertRowid,status:'pending'});
 }catch(e){res.status(409).json({error:'درخواست فروشندگی قبلاً ثبت شده است'})}
});

app.get('/api/vendor/summary',auth,role('vendor'),(req,res)=>{
 const v=getVendor(req.session.user.id),wallet=getWallet(v.id);
 res.json({vendor:v,products:db.prepare('SELECT COUNT(*) n FROM products WHERE vendor_id=?').get(v.id).n,wallet:wallet.balance,availableBalance:wallet.balance,orders:db.prepare('SELECT COUNT(DISTINCT oi.order_id) n FROM order_items oi WHERE oi.vendor_id=?').get(v.id).n,transactions:db.prepare('SELECT * FROM wallet_transactions WHERE vendor_id=? ORDER BY id DESC LIMIT 50').all(v.id),settlements:db.prepare('SELECT * FROM settlements WHERE vendor_id=? ORDER BY id DESC LIMIT 30').all(v.id)});
});
app.post('/api/vendor/products',auth,role('vendor'),(req,res)=>{
 const v=getVendor(req.session.user.id),name=String(req.body?.name||'').trim(),description=String(req.body?.description||'').trim(),price=Number(req.body?.price),stock=Number(req.body?.stock),categoryId=req.body?.category_id?positiveId(req.body.category_id):null,image=String(req.body?.image||'');
 if(name.length<2||name.length>160||description.length>3000||!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(stock)||stock<0||image.length>200000||!/^$|^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/i.test(image))return res.status(400).json({error:'اطلاعات محصول معتبر نیست'});
 if(categoryId&&!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId))return res.status(400).json({error:'دسته‌بندی انتخاب‌شده معتبر نیست'});
 const r=db.prepare('INSERT INTO products(vendor_id,category_id,name,description,price,stock,image) VALUES(?,?,?,?,?,?,?)').run(v.id,categoryId,name,description,price,stock,image);audit(req.session.user.id,'product.create',r.lastInsertRowid+':'+name);res.status(201).json({id:r.lastInsertRowid});
});
app.get('/api/vendor/products',auth,role('vendor'),(req,res)=>{const v=getVendor(req.session.user.id);res.json(db.prepare('SELECT * FROM products WHERE vendor_id=? ORDER BY id DESC').all(v.id))});
app.get('/api/vendor/products/:id',auth,role('vendor'),(req,res)=>{const id=positiveId(req.params.id),v=getVendor(req.session.user.id);const p=id&&db.prepare('SELECT * FROM products WHERE id=? AND vendor_id=?').get(id,v.id);if(!p)return res.status(404).json({error:'محصول پیدا نشد'});res.json(p)});
app.patch('/api/vendor/products/:id',auth,role('vendor'),(req,res)=>{
 const id=positiveId(req.params.id),v=getVendor(req.session.user.id),p=id&&db.prepare('SELECT * FROM products WHERE id=? AND vendor_id=?').get(id,v.id);
 if(!p)return res.status(404).json({error:'محصول پیدا نشد'});
 const name=String(req.body?.name||'').trim(),description=String(req.body?.description||'').trim(),price=Number(req.body?.price),stock=Number(req.body?.stock),categoryId=req.body?.category_id?positiveId(req.body.category_id):null,image=String(req.body?.image||'');
 if(name.length<2||name.length>160||description.length>3000||!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(stock)||stock<0||image.length>200000||!/^$|^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/i.test(image))return res.status(400).json({error:'نام، قیمت، موجودی یا تصویر معتبر نیست'});
 if(categoryId&&!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId))return res.status(400).json({error:'دسته‌بندی معتبر نیست'});
 db.prepare('UPDATE products SET name=?,description=?,price=?,stock=?,category_id=?,image=? WHERE id=? AND vendor_id=?').run(name,description,price,stock,categoryId,image,id,v.id);audit(req.session.user.id,'product.update',id);res.json({ok:true});
});
app.delete('/api/vendor/products/:id',auth,role('vendor'),(req,res)=>{const id=positiveId(req.params.id),v=getVendor(req.session.user.id);const r=id?db.prepare("UPDATE products SET status='hidden' WHERE id=? AND vendor_id=?").run(id,v.id):{changes:0};if(!r.changes)return res.status(404).json({error:'محصول پیدا نشد'});audit(req.session.user.id,'product.hide',id);res.json({ok:true})});

app.get('/api/admin/summary',auth,role('admin'),(req,res)=>res.json({customers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n,vendors:db.prepare('SELECT COUNT(*) n FROM vendors').get().n,pendingVendors:db.prepare("SELECT COUNT(*) n FROM vendors WHERE status='pending'").get().n,products:db.prepare('SELECT COUNT(*) n FROM products').get().n,orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,revenue:db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE payment_status='succeeded' OR status='paid_test'").get().n}));
app.get('/api/admin/settings',auth,role('admin'),(req,res)=>res.json(publicSettings()));
app.patch('/api/admin/settings',auth,role('admin'),(req,res)=>{
 const code=String(req.body?.currency_code||'').trim().toUpperCase(),symbol=String(req.body?.currency_symbol||'').trim(),name=String(req.body?.currency_name||'').trim(),rate=Number(req.body?.commission_rate);
 if(!/^[A-Z]{3}$/.test(code)||symbol.length<1||symbol.length>10||/[\u0000-\u001f<>]/.test(symbol)||name.length<1||name.length>24||!Number.isFinite(rate)||rate<0||rate>50)return res.status(400).json({error:'واحد پول یا کمیسیون معتبر نیست؛ کمیسیون باید بین صفر تا ۵۰ درصد باشد'});
 const values={currency_code:code,currency_symbol:symbol,currency_name:name,commission_rate:String(rate),payment_mode:'test'};
 const update=db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP");
 const tx=db.transaction(()=>{for(const k of Object.keys(values))update.run(k,values[k])});tx();audit(req.session.user.id,'settings.finance',JSON.stringify({currency_code:code,commission_rate:rate,payment_mode:'test'}));res.json(publicSettings());
});
app.get('/api/admin/vendors',auth,role('admin'),(req,res)=>res.json(db.prepare('SELECT v.*,u.name,u.email FROM vendors v JOIN users u ON u.id=v.user_id ORDER BY v.id DESC').all()));
app.patch('/api/admin/vendors/:id',auth,role('admin'),(req,res)=>{
 const id=positiveId(req.params.id);if(!id)return res.status(400).json({error:'شناسه فروشنده نامعتبر است'});
 const v=db.prepare('SELECT * FROM vendors WHERE id=?').get(id);if(!v)return res.status(404).json({error:'فروشنده پیدا نشد'});
 const status=req.body?.status;
 const override=req.body?.commission_override;
 if(status!==undefined&&!['approved','rejected','pending','suspended'].includes(status))return res.status(400).json({error:'وضعیت فروشنده نامعتبر است'});
 let commission=null;
 if(override!==undefined&&override!==null&&override!==''){commission=Number(override);if(!Number.isFinite(commission)||commission<0||commission>50)return res.status(400).json({error:'کمیسیون اختصاصی باید بین صفر تا ۵۰ درصد باشد'})}
 const tx=db.transaction(()=>{
  if(status!==undefined){db.prepare('UPDATE vendors SET status=? WHERE id=?').run(status,id);db.prepare('UPDATE users SET role=? WHERE id=?').run(status==='approved'?'vendor':'customer',v.user_id);if(status==='approved')getWallet(id)}
  if(override!==undefined)db.prepare('UPDATE vendors SET commission_override=? WHERE id=?').run(commission,id);
 });tx();audit(req.session.user.id,'vendor.update',JSON.stringify({id,status:status||v.status,commission_override:override===undefined?'unchanged':commission}));res.json({ok:true});
});
app.get('/api/admin/products',auth,role('admin'),(req,res)=>res.json(db.prepare('SELECT p.*,v.store_name vendor FROM products p JOIN vendors v ON v.id=p.vendor_id ORDER BY p.id DESC').all()));
app.patch('/api/admin/products/:id',auth,role('admin'),(req,res)=>{const id=positiveId(req.params.id),status=req.body?.status;if(!id||!['active','hidden'].includes(status))return res.status(400).json({error:'شناسه یا وضعیت محصول نامعتبر است'});const r=db.prepare('UPDATE products SET status=? WHERE id=?').run(status,id);if(!r.changes)return res.status(404).json({error:'محصول پیدا نشد'});audit(req.session.user.id,'product.status',id+':'+status);res.json({ok:true})});
app.post('/api/admin/categories',auth,role('admin'),(req,res)=>{const name=String(req.body?.name||'').trim(),slug=String(req.body?.slug||'').trim().toLowerCase();if(name.length<2||name.length>80||!/^[a-z0-9-]{2,40}$/.test(slug))return res.status(400).json({error:'نام و شناسه انگلیسی معتبر لازم است'});try{const r=db.prepare('INSERT INTO categories(name,slug) VALUES(?,?)').run(name,slug);audit(req.session.user.id,'category.create',name);res.status(201).json({id:r.lastInsertRowid})}catch(e){res.status(409).json({error:'این دسته‌بندی یا شناسه قبلاً ثبت شده است'})}});

app.post('/api/orders',auth,role('customer'),(req,res)=>{
 const raw=Array.isArray(req.body?.items)?req.body.items:[];if(!raw.length||raw.length>30)return res.status(400).json({error:'سبد خرید معتبر نیست'});
 const aggregated=new Map();
 for(const item of raw){const id=positiveId(item?.product_id),qty=Number(item?.quantity);if(!id||!Number.isSafeInteger(qty)||qty<1||qty>100)return res.status(400).json({error:'شناسه کالا یا تعداد معتبر نیست'});aggregated.set(id,(aggregated.get(id)||0)+qty)}
 const items=Array.from(aggregated.entries()).map(([product_id,quantity])=>({product_id,quantity})).sort((a,b)=>a.product_id-b.product_id);
 if(items.some(x=>x.quantity>100))return res.status(400).json({error:'تعداد یک کالا نمی‌تواند بیشتر از ۱۰۰ باشد'});
 const hash=requestHash(items),key=String(req.get('Idempotency-Key')||req.body?.idempotency_key||crypto.randomUUID()).trim();
 if(key.length<8||key.length>100)return res.status(400).json({error:'کلید تکرارپذیری درخواست معتبر نیست'});
 const previous=db.prepare('SELECT p.*,o.total,o.currency_code order_currency FROM payment_transactions p JOIN orders o ON o.id=p.order_id WHERE p.idempotency_key=?').get(key);
 if(previous){if(previous.customer_id!==req.session.user.id||previous.request_hash!==hash)return res.status(409).json({error:'کلید درخواست قبلاً برای سبد دیگری استفاده شده است'});return res.status(200).json({orderId:previous.order_id,paymentId:previous.id,paymentStatus:previous.status,paymentMode:'test',amount:previous.amount,currency:previous.currency_code,reference:previous.reference,reused:true})}
 const settings=publicSettings(),created=db.transaction(()=>{
  const lines=[];let total=0,commissionTotal=0;
  for(const item of items){
   const p=db.prepare("SELECT p.*,v.status vendor_status,v.commission_override FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=? AND p.status='active'").get(item.product_id);
   if(!p||p.vendor_status!=='approved'||p.stock<item.quantity)throw new Error('محصول فعال نیست یا موجودی کافی ندارد');
   const rate=p.commission_override===null||p.commission_override===undefined?settings.commissionRate:Number(p.commission_override);
   const lineTotal=p.price*item.quantity,commission=Math.round(lineTotal*rate/100);
   if(!Number.isSafeInteger(lineTotal)||!Number.isSafeInteger(commission))throw new Error('مبلغ سفارش بیش از حد مجاز است');
   total+=lineTotal;commissionTotal+=commission;lines.push({p,quantity:item.quantity,commission,rate});
  }
  if(!Number.isSafeInteger(total)||total>Number.MAX_SAFE_INTEGER)throw new Error('مبلغ سفارش معتبر نیست');
  const order=db.prepare("INSERT INTO orders(customer_id,total,status,currency_code,commission_total,payment_status) VALUES(?,?,? ,?,?,?)").run(req.session.user.id,total,'awaiting_payment',settings.currency.code,commissionTotal,'pending');
  const addItem=db.prepare('INSERT INTO order_items(order_id,product_id,vendor_id,quantity,unit_price,commission,commission_rate) VALUES(?,?,?,?,?,?,?)');
  for(const line of lines)addItem.run(order.lastInsertRowid,line.p.id,line.p.vendor_id,line.quantity,line.p.price,line.commission,line.rate);
  const payment=db.prepare("INSERT INTO payment_transactions(order_id,customer_id,provider,mode,status,amount,currency_code,reference,idempotency_key,request_hash) VALUES(?,?,'test_gateway','test','pending',?,?,?,?,?)").run(order.lastInsertRowid,req.session.user.id,total,settings.currency.code,paymentReference(),key,hash);
  return {orderId:order.lastInsertRowid,paymentId:payment.lastInsertRowid,paymentStatus:'pending',paymentMode:'test',amount:total,currency:settings.currency,reference:db.prepare('SELECT reference FROM payment_transactions WHERE id=?').get(payment.lastInsertRowid).reference};
 });
 try{const result=created(items);audit(req.session.user.id,'order.created',result.orderId+':test_payment_pending');res.status(201).json(result)}catch(e){res.status(400).json({error:e.message||'ثبت سفارش انجام نشد'})}
});

app.post('/api/payments/:id/test-confirm',auth,role('customer'),(req,res)=>{
 const id=positiveId(req.params.id);if(!id)return res.status(400).json({error:'شناسه پرداخت نامعتبر است'});
 const p=db.prepare('SELECT * FROM payment_transactions WHERE id=? AND customer_id=?').get(id,req.session.user.id);
 if(!p)return res.status(404).json({error:'تراکنش پیدا نشد'});
 if(p.mode!=='test'||readSettings().payment_mode!=='test')return res.status(409).json({error:'پرداخت آزمایشی فعال نیست'});
 if(p.status==='succeeded')return res.json({ok:true,paymentStatus:'succeeded',orderId:p.order_id,alreadyProcessed:true});
 if(p.status!=='pending')return res.status(409).json({error:'این تراکنش دیگر در انتظار پرداخت نیست'});
 let failure=null;
 const confirm=db.transaction(()=>{
  const current=db.prepare('SELECT * FROM payment_transactions WHERE id=?').get(id);
  if(current.status==='succeeded')return {ok:true,alreadyProcessed:true};
  if(current.status!=='pending')throw new Error('وضعیت تراکنش تغییر کرده است');
  const lines=db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(current.order_id);
  for(const line of lines){const stock=db.prepare('SELECT stock,status FROM products WHERE id=?').get(line.product_id);if(!stock||stock.status!=='active'||stock.stock<line.quantity){failure='موجودی یکی از کالاها هنگام تأیید پرداخت کافی نیست';break}}
  if(failure){db.prepare("UPDATE payment_transactions SET status='failed',failure_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(failure,id);db.prepare("UPDATE orders SET status='payment_failed',payment_status='failed' WHERE id=?").run(current.order_id);return {ok:false}}
  for(const line of lines){const update=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND status=\'active\'').run(line.quantity,line.product_id,line.quantity);if(!update.changes)throw new Error('موجودی کالا تغییر کرده است؛ پرداخت تأیید نشد')}
  const vendorTotals=db.prepare('SELECT vendor_id,SUM(unit_price*quantity-commission) net FROM order_items WHERE order_id=? GROUP BY vendor_id').all(current.order_id);
  for(const v of vendorTotals)addWalletEntry({vendorId:v.vendor_id,orderId:current.order_id,type:'sale_credit',amount:v.net,note:'اعتبار فروش پس از پرداخت آزمایشی',refKey:'payment:'+id+':vendor:'+v.vendor_id});
  db.prepare("UPDATE payment_transactions SET status='succeeded',paid_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(now(),id);
  db.prepare("UPDATE orders SET status='paid_test',payment_status='succeeded' WHERE id=?").run(current.order_id);
  audit(req.session.user.id,'payment.test.succeeded',id+':'+current.reference);
  return {ok:true};
 });
 try{const result=confirm();if(!result.ok)return res.status(409).json({error:failure||'پرداخت آزمایشی ناموفق بود',paymentStatus:'failed'});res.json({ok:true,paymentStatus:'succeeded',orderId:p.order_id,testMode:true})}catch(e){res.status(409).json({error:e.message||'تأیید پرداخت انجام نشد'})}
});
app.post('/api/payments/:id/test-fail',auth,role('customer'),(req,res)=>{
 const id=positiveId(req.params.id),p=id&&db.prepare('SELECT * FROM payment_transactions WHERE id=? AND customer_id=?').get(id,req.session.user.id);
 if(!p)return res.status(404).json({error:'تراکنش پیدا نشد'});if(p.mode!=='test'||p.status!=='pending')return res.status(409).json({error:'این تراکنش قابل تغییر نیست'});
 const tx=db.transaction(()=>{db.prepare("UPDATE payment_transactions SET status='failed',failure_reason='شبیه‌سازی شکست پرداخت',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(id);db.prepare("UPDATE orders SET status='payment_failed',payment_status='failed' WHERE id=?").run(p.order_id);audit(req.session.user.id,'payment.test.failed',id)});tx();res.json({ok:true,paymentStatus:'failed',testMode:true});
});
app.get('/api/payments/:id',auth,(req,res)=>{const id=positiveId(req.params.id);const p=id&&db.prepare('SELECT * FROM payment_transactions WHERE id=?').get(id);if(!p)return res.status(404).json({error:'تراکنش پیدا نشد'});if(req.session.user.role!=='admin'&&p.customer_id!==req.session.user.id)return res.status(403).json({error:'اجازه مشاهده این تراکنش را ندارید'});res.json(p)});
app.get('/api/admin/payments',auth,role('admin'),(req,res)=>res.json(db.prepare('SELECT p.*,u.name customer FROM payment_transactions p JOIN users u ON u.id=p.customer_id ORDER BY p.id DESC LIMIT 200').all()));

app.get('/api/orders',auth,role('customer','admin'),(req,res)=>{const rows=req.session.user.role==='admin'?db.prepare('SELECT o.*,u.name customer FROM orders o JOIN users u ON u.id=o.customer_id ORDER BY o.id DESC').all():db.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC').all(req.session.user.id);res.json(rows)});
app.get('/api/admin/orders',auth,role('admin'),(req,res)=>res.json(db.prepare('SELECT o.*,u.name customer FROM orders o JOIN users u ON u.id=o.customer_id ORDER BY o.id DESC').all()));
app.patch('/api/admin/orders/:id',auth,role('admin'),(req,res)=>{
 const id=positiveId(req.params.id),status=req.body?.status;if(!id||!['processing','shipped','delivered'].includes(status))return res.status(400).json({error:'شناسه یا وضعیت سفارش نامعتبر است'});
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!order)return res.status(404).json({error:'سفارش پیدا نشد'});
 if(order.payment_status!=='succeeded'&&order.status!=='paid_test')return res.status(409).json({error:'سفارش بدون پرداخت موفق قابل پردازش نیست'});
 const allowed={paid_test:['processing'],processing:['shipped'],shipped:['delivered']};
 if(!(allowed[order.status]||[]).includes(status))return res.status(409).json({error:'تغییر وضعیت سفارش با این ترتیب مجاز نیست'});
 db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);audit(req.session.user.id,'order.status',id+':'+status);res.json({ok:true});
});

app.post('/api/vendor/settlements',auth,role('vendor'),(req,res)=>{
 const v=getVendor(req.session.user.id),amount=Number(req.body?.amount);
 if(!Number.isSafeInteger(amount)||amount<1)return res.status(400).json({error:'مبلغ تسویه باید عدد صحیح مثبت باشد'});
 try{
  const create=db.transaction(()=>{
   const wallet=getWallet(v.id);if(amount>wallet.balance)throw new Error('مبلغ درخواست از مانده قابل برداشت بیشتر است');
   const row=db.prepare("INSERT INTO settlements(vendor_id,amount,status) VALUES(?,?,'pending')").run(v.id,amount);
   addWalletEntry({vendorId:v.id,type:'settlement_hold',amount:-amount,note:'رزرو مبلغ درخواست تسویه',refKey:'settlement_hold:'+row.lastInsertRowid});
   return row.lastInsertRowid;
  });
  const id=create();audit(req.session.user.id,'settlement.request',id+':'+amount);res.status(201).json({id,status:'pending',reservedAmount:amount});
 }catch(e){res.status(400).json({error:e.message||'ثبت درخواست تسویه انجام نشد'})}
});
app.post('/api/vendor/settlements/:id/cancel',auth,role('vendor'),(req,res)=>{
 const id=positiveId(req.params.id),v=getVendor(req.session.user.id),s=id&&db.prepare('SELECT * FROM settlements WHERE id=? AND vendor_id=?').get(id,v.id);
 if(!s)return res.status(404).json({error:'درخواست تسویه پیدا نشد'});if(s.status!=='pending')return res.status(409).json({error:'فقط درخواست در انتظار را می‌توان لغو کرد'});
 const tx=db.transaction(()=>{addWalletEntry({vendorId:v.id,type:'settlement_release',amount:s.amount,note:'آزادسازی رزرو پس از لغو درخواست',refKey:'settlement_release:'+id});db.prepare("UPDATE settlements SET status='rejected',rejection_reason='لغو توسط فروشنده',processed_at=?,processed_by=? WHERE id=? AND status='pending'").run(now(),req.session.user.id,id)});tx();audit(req.session.user.id,'settlement.cancel',id);res.json({ok:true,status:'rejected'});
});
app.get('/api/admin/settlements',auth,role('admin'),(req,res)=>res.json(db.prepare('SELECT s.*,v.store_name FROM settlements s JOIN vendors v ON v.id=s.vendor_id ORDER BY s.id DESC').all()));
app.patch('/api/admin/settlements/:id',auth,role('admin'),(req,res)=>{
 const id=positiveId(req.params.id),status=req.body?.status,reference=String(req.body?.external_reference||'').trim();
 if(!id||!['approved','rejected','paid_manual'].includes(status))return res.status(400).json({error:'وضعیت تسویه نامعتبر است'});
 const s=db.prepare('SELECT * FROM settlements WHERE id=?').get(id);if(!s)return res.status(404).json({error:'درخواست تسویه پیدا نشد'});
 try{
  const tx=db.transaction(()=>{
   const current=db.prepare('SELECT * FROM settlements WHERE id=?').get(id);
   if(status==='approved'){
    if(current.status==='needs_review'){
     addWalletEntry({vendorId:current.vendor_id,type:'settlement_hold',amount:-current.amount,note:'رزرو پس از بررسی دستی مدیر',refKey:'settlement_hold:'+id});
    }else if(current.status!=='pending')throw new Error('فقط درخواست در انتظار یا نیازمند بررسی قابل تأیید است');
    db.prepare("UPDATE settlements SET status='approved',processed_at=?,processed_by=?,rejection_reason=NULL WHERE id=?").run(now(),req.session.user.id,id);
   }else if(status==='rejected'){
    if(!['pending','approved','needs_review'].includes(current.status))throw new Error('این درخواست قابل رد نیست');
    if(current.status!=='needs_review')addWalletEntry({vendorId:current.vendor_id,type:'settlement_release',amount:current.amount,note:'آزادسازی مبلغ تسویه ردشده',refKey:'settlement_release:'+id});
    db.prepare("UPDATE settlements SET status='rejected',processed_at=?,processed_by=?,rejection_reason='رد توسط مدیر' WHERE id=?").run(now(),req.session.user.id,id);
   }else{
    if(current.status!=='approved')throw new Error('ابتدا درخواست باید تأیید شود');
    if(reference.length<3||reference.length>100)return false;
    db.prepare("UPDATE settlements SET status='paid_manual',processed_at=?,processed_by=?,external_reference=? WHERE id=?").run(now(),req.session.user.id,reference,id);
    db.prepare('INSERT OR IGNORE INTO wallet_transactions(vendor_id,type,amount,note,ref_key) VALUES(?,?,?,?,?)').run(current.vendor_id,'settlement_paid_manual',0,'ثبت دستی پرداخت خارج از سامانه: '+reference,'settlement_paid_manual:'+id);
   }
   return true;
  });
  const ok=tx();if(ok===false)return res.status(400).json({error:'شماره پیگیری دستی باید ۳ تا ۱۰۰ نویسه باشد'});
  audit(req.session.user.id,'settlement.status',id+':'+status);res.json({ok:true,status,label:statusLabel(status),manualOnly:status==='paid_manual'});
 }catch(e){res.status(409).json({error:e.message||'تغییر وضعیت تسویه انجام نشد'})}
});
app.get('/api/vendor/orders',auth,role('vendor'),(req,res)=>{const v=getVendor(req.session.user.id);res.json(db.prepare('SELECT o.id order_id,o.status,o.payment_status,o.created_at,o.currency_code,oi.quantity,oi.unit_price,p.name product FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE oi.vendor_id=? ORDER BY o.id DESC').all(v.id))});
app.get('/api/admin/audit',auth,role('admin'),(req,res)=>res.json(db.prepare('SELECT a.*,u.name actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100').all()));

app.use('/api',(req,res)=>res.status(404).json({error:'مسیر API پیدا نشد'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
if(require.main===module)app.listen(PORT,'0.0.0.0',()=>console.log('NOVA MARKET listening on '+PORT));
module.exports=app;
