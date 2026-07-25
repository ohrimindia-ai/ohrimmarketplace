const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'ohrimmarketplace_secret_key_2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

[DB_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { shops: {}, products: {}, orders: {}, nextProductId: 1, nextOrderId: 1 };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const db = loadDB();
if (!db.shops['1']) {
  const hash = bcrypt.hashSync('shop123', 10);
  db.shops['1'] = { id: 1, shopNumber: '1', password: hash, name: 'Shop 1', createdAt: new Date().toISOString() };
  saveDB(db);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `product_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function authShop(req, res, next) {
  const token = req.cookies.shopToken;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.shopId = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function authAdmin(req, res, next) {
  const token = req.cookies.adminToken;
  if (!token) return res.status(401).json({ error: 'Not admin' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    next();
  } catch { res.status(401).json({ error: 'Invalid admin token' }); }
}

// PUBLIC: List all products
app.get('/api/products', (req, res) => {
  const db = loadDB();
  const { shop, search, sort } = req.query;
  let products = Object.values(db.products).filter(p => p.active);
  if (shop) products = products.filter(p => String(p.shopId) === String(shop));
  if (search) {
    const q = search.toLowerCase();
    products = products.filter(p => p.name.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)));
  }
  if (sort === 'price_low') products.sort((a, b) => a.price - b.price);
  else if (sort === 'price_high') products.sort((a, b) => b.price - a.price);
  else if (sort === 'newest') products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const enriched = products.map(p => ({
    ...p,
    shopNumber: db.shops[String(p.shopId)]?.shopNumber || '?',
    image: p.image ? `/uploads/${p.image}` : null,
  }));
  res.json({ products: enriched });
});

// PUBLIC: Single product
app.get('/api/products/:id', (req, res) => {
  const db = loadDB();
  const product = db.products[req.params.id];
  if (!product) return res.status(404).json({ error: 'Not found' });
  const shop = db.shops[String(product.shopId)];
  res.json({ ...product, shopNumber: shop?.shopNumber || '?', image: product.image ? `/uploads/${product.image}` : null });
});

// PUBLIC: Place order
app.post('/api/orders', (req, res) => {
  const db = loadDB();
  const { productId, customerName, customerPhone, customerAddress, quantity } = req.body;
  if (!productId || !customerName || !customerPhone || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const product = db.products[String(productId)];
  if (!product || !product.active) return res.status(404).json({ error: 'Product not found' });

  const id = db.nextOrderId++;
  db.orders[String(id)] = {
    id, productId: Number(productId), shopId: product.shopId,
    productName: product.name, productPrice: product.price, productImage: product.image,
    shopNumber: db.shops[String(product.shopId)]?.shopNumber || '?',
    customerName, customerPhone, customerAddress: customerAddress || '',
    quantity: Number(quantity), totalAmount: product.price * Number(quantity),
    status: 'pending', createdAt: new Date().toISOString()
  };
  saveDB(db);
  res.json({ success: true, orderId: id });
});

// PUBLIC: Shops list
app.get('/api/shops', (req, res) => {
  const db = loadDB();
  const shops = Object.values(db.shops).map(s => ({
    id: s.id, shopNumber: s.shopNumber,
    productCount: Object.values(db.products).filter(p => p.shopId === s.id && p.active).length
  }));
  res.json({ shops });
});

// AUTH: Shop login
app.post('/api/shop/login', (req, res) => {
  const { shopNumber, password } = req.body;
  const db = loadDB();
  const shop = Object.values(db.shops).find(s => s.shopNumber === String(shopNumber));
  if (!shop || !bcrypt.compareSync(password, shop.password)) {
    return res.status(401).json({ error: 'Invalid shop number or password' });
  }
  const token = jwt.sign({ id: shop.id, shopNumber: shop.shopNumber }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('shopToken', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ success: true, shopNumber: shop.shopNumber });
});

// AUTH: Shop logout
app.post('/api/shop/logout', (req, res) => {
  res.clearCookie('shopToken');
  res.json({ success: true });
});

// AUTH: Shop - get own products
app.get('/api/shop/products', authShop, (req, res) => {
  const db = loadDB();
  const products = Object.values(db.products).filter(p => p.shopId === req.shopId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ products: products.map(p => ({ ...p, image: p.image ? `/uploads/${p.image}` : null })) });
});

// AUTH: Shop - add product
app.post('/api/shop/products', authShop, upload.single('image'), (req, res) => {
  const db = loadDB();
  const { name, price, description, category } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });

  const id = db.nextProductId++;
  db.products[String(id)] = {
    id, shopId: req.shopId, name, price: Number(price),
    description: description || '', category: category || '',
    image: req.file ? req.file.filename : null,
    active: true, createdAt: new Date().toISOString()
  };
  saveDB(db);
  res.json({ success: true, product: db.products[String(id)] });
});

// AUTH: Shop - edit product
app.put('/api/shop/products/:id', authShop, upload.single('image'), (req, res) => {
  const db = loadDB();
  const product = db.products[req.params.id];
  if (!product || product.shopId !== req.shopId) return res.status(404).json({ error: 'Not found' });

  const { name, price, description, category, active } = req.body;
  if (name) product.name = name;
  if (price) product.price = Number(price);
  if (description !== undefined) product.description = description;
  if (category !== undefined) product.category = category;
  if (active !== undefined) product.active = active === 'true' || active === true;
  if (req.file) {
    if (product.image) {
      const oldPath = path.join(UPLOAD_DIR, product.image);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    product.image = req.file.filename;
  }
  saveDB(db);
  res.json({ success: true, product });
});

// AUTH: Shop - delete product
app.delete('/api/shop/products/:id', authShop, (req, res) => {
  const db = loadDB();
  const product = db.products[req.params.id];
  if (!product || product.shopId !== req.shopId) return res.status(404).json({ error: 'Not found' });
  product.active = false;
  saveDB(db);
  res.json({ success: true });
});

// AUTH: Shop - get own orders
app.get('/api/shop/orders', authShop, (req, res) => {
  const db = loadDB();
  const orders = Object.values(db.orders).filter(o => o.shopId === req.shopId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

// ADMIN: Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('adminToken', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('adminToken');
  res.json({ success: true });
});

// ADMIN: All orders
app.get('/api/admin/orders', authAdmin, (req, res) => {
  const db = loadDB();
  const { status, shop } = req.query;
  let orders = Object.values(db.orders);
  if (status) orders = orders.filter(o => o.status === status);
  if (shop) orders = orders.filter(o => String(o.shopId) === String(shop));
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

// ADMIN: Update order status
app.put('/api/admin/orders/:id', authAdmin, (req, res) => {
  const db = loadDB();
  const order = db.orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body;
  if (['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'].includes(status)) {
    order.status = status;
    saveDB(db);
  }
  res.json({ success: true, order });
});

// ADMIN: Add shop
app.post('/api/admin/shops', authAdmin, (req, res) => {
  const db = loadDB();
  const { shopNumber, password } = req.body;
  if (!shopNumber || !password) return res.status(400).json({ error: 'Shop number and password required' });
  const exists = Object.values(db.shops).find(s => s.shopNumber === String(shopNumber));
  if (exists) return res.status(400).json({ error: 'Shop already exists' });

  const id = Math.max(...Object.keys(db.shops).map(Number)) + 1;
  const hash = bcrypt.hashSync(password, 10);
  db.shops[String(id)] = { id, shopNumber: String(shopNumber), password: hash, createdAt: new Date().toISOString() };
  saveDB(db);
  res.json({ success: true, shop: { id, shopNumber } });
});

// ADMIN: Dashboard stats
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const db = loadDB();
  const orders = Object.values(db.orders);
  const products = Object.values(db.products).filter(p => p.active);
  const shops = Object.values(db.shops);
  res.json({
    totalOrders: orders.length,
    pendingOrders: orders.filter(o => o.status === 'pending').length,
    totalRevenue: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.totalAmount, 0),
    totalProducts: products.length,
    totalShops: shops.length,
  });
});

// ADMIN: All shops
app.get('/api/admin/shops', authAdmin, (req, res) => {
  const db = loadDB();
  const shops = Object.values(db.shops).map(s => ({
    ...s, password: undefined,
    productCount: Object.values(db.products).filter(p => p.shopId === s.id && p.active).length
  }));
  res.json({ shops });
});

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ohrimmarketplace running at http://localhost:${PORT}`);
});
