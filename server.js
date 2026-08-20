const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'ohrimmarketplace_secret_key_2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '2666f879b314106c4ee434bb754b6584';

async function uploadToImgBB(buffer, filename) {
  const base64 = buffer.toString('base64');
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const formData = new URLSearchParams();
      formData.append('key', IMGBB_API_KEY);
      formData.append('image', base64);
      formData.append('name', filename);
      const resp = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: formData });
      const data = await resp.json();
      if (data.success) return data.data.url;
      lastErr = new Error((data.error && (data.error.message || data.error.code)) || 'ImgBB rejected upload');
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw lastErr || new Error('ImgBB upload failed');
}

function saveLocalData(buffer, mimetype) {
  return { mime: mimetype || 'image/jpeg', data: buffer.toString('base64') };
}

async function storeImage(buffer, mimetype) {
  try {
    const url = await uploadToImgBB(buffer, `product_${Date.now()}`);
    return { url, host: 'imgbb' };
  } catch (err) {
    console.error('ImgBB upload failed, falling back to database storage:', err.message);
    return { host: 'local', ...saveLocalData(buffer, mimetype) };
  }
}

async function saveImageForProduct(productId, img) {
  if (!img || img.host === 'imgbb') return img ? img.url : null;
  await pool.query(`
    INSERT INTO product_images (product_id, mime, data)
    VALUES ($1, $2, $3)
    ON CONFLICT (product_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data
  `, [productId, img.mime, img.data]);
  return `/api/image/${productId}`;
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      shop_number TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER REFERENCES shops(id),
      name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      image TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS product_images (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id),
      shop_id INTEGER REFERENCES shops(id),
      product_name TEXT,
      product_price NUMERIC,
      product_image TEXT,
      shop_number TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_address TEXT DEFAULT '',
      quantity INTEGER DEFAULT 1,
      total_amount NUMERIC,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY,
      product_name TEXT NOT NULL,
      image TEXT,
      quantity TEXT DEFAULT '',
      estimated_price TEXT DEFAULT '',
      description TEXT DEFAULT '',
      buyer_name TEXT NOT NULL,
      city TEXT DEFAULT '',
      phone TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const res = await pool.query('SELECT id FROM shops WHERE shop_number = $1', ['1']);
  if (res.rows.length === 0) {
    const hash = bcrypt.hashSync('shop123', 10);
    await pool.query('INSERT INTO shops (shop_number, password, name) VALUES ($1, $2, $3)', ['1', hash, 'Shop 1']);
  }

  const defaultCats = ['General', 'Clothing', 'Electronics', 'Grocery', 'Footwear', 'Accessories', 'Home & Kitchen', 'Beauty', 'Sports', 'Other'];
  for (const name of defaultCats) {
    await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  }
  const legacy = await pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != \'\'');
  for (const r of legacy.rows) {
    await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [r.category]);
  }

  console.log('Database initialized');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported image type. Please upload JPG, PNG, GIF, WebP or HEIC.'));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

const cache = {};
function cached(key, ttlMs, handler) {
  return async (req, res) => {
    const now = Date.now();
    if (cache[key] && now - cache[key].ts < ttlMs) {
      res.set('Cache-Control', 'public, s-maxage=' + Math.round(ttlMs/1000) + ', max-age=60');
      return res.json(cache[key].data);
    }
    const origJson = res.json.bind(res);
    res.json = (data) => {
      cache[key] = { data, ts: now };
      res.set('Cache-Control', 'public, s-maxage=' + Math.round(ttlMs/1000) + ', max-age=60');
      return origJson(data);
    };
    await handler(req, res);
  };
}

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
app.get('/api/products', cached('products', 300000, async (req, res) => {
  const { shop, search, sort, category } = req.query;
  let query = `
    SELECT p.*, s.shop_number
    FROM products p JOIN shops s ON p.shop_id = s.id
    WHERE p.active = true
  `;
  const params = [];
  let i = 1;

  if (shop) { query += ` AND p.shop_id = $${i++}`; params.push(shop); }
  if (search) { query += ` AND (LOWER(p.name) LIKE $${i} OR LOWER(p.description) LIKE $${i})`; params.push(`%${search.toLowerCase()}%`); i++; }
  if (category) { query += ` AND LOWER(p.category) = LOWER($${i++})`; params.push(category); }

  if (sort === 'price_low') query += ' ORDER BY p.price ASC';
  else if (sort === 'price_high') query += ' ORDER BY p.price DESC';
  else query += ' ORDER BY p.created_at DESC';

  const result = await pool.query(query, params);
  const products = result.rows.map(p => ({
    id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
    description: p.description, category: p.category,
    image: p.image || null,
    active: p.active, createdAt: p.created_at, shopNumber: p.shop_number
  }));
  res.json({ products });
}));

// PUBLIC: Single product
app.get('/api/products/:id', async (req, res) => {
  res.set('Cache-Control', 'public, s-maxage=300, max-age=60');
  const result = await pool.query(`
    SELECT p.*, s.shop_number FROM products p JOIN shops s ON p.shop_id = s.id WHERE p.id = $1
  `, [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const p = result.rows[0];
  res.json({
    id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
    description: p.description, category: p.category,
    image: p.image || null,
    active: p.active, createdAt: p.created_at, shopNumber: p.shop_number
  });
});

// PUBLIC: Database-stored image (fallback when ImgBB is unavailable)
app.get('/api/image/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT mime, data FROM product_images WHERE product_id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).send('Not found');
    const row = result.rows[0];
    const buf = Buffer.from(row.data, 'base64');
    res.set('Content-Type', row.mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (err) {
    console.error('Image fetch failed:', err.message);
    res.status(500).send('Error');
  }
});

// PUBLIC: Place order
app.post('/api/orders', async (req, res) => {
  const { productId, customerName, customerPhone, customerAddress, quantity } = req.body;
  if (!productId || !customerName || !customerPhone || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const pResult = await pool.query('SELECT p.*, s.shop_number FROM products p JOIN shops s ON p.shop_id = s.id WHERE p.id = $1 AND p.active = true', [productId]);
  if (pResult.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  const p = pResult.rows[0];

  const result = await pool.query(`
    INSERT INTO orders (product_id, shop_id, product_name, product_price, product_image, shop_number, customer_name, customer_phone, customer_address, quantity, total_amount)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
  `, [productId, p.shop_id, p.name, p.price, p.image, p.shop_number, customerName, customerPhone, customerAddress || '', Number(quantity), p.price * Number(quantity)]);
  res.json({ success: true, orderId: result.rows[0].id });
});

// PUBLIC: Submit a product inquiry
app.post('/api/inquiries', upload.single('image'), async (req, res) => {
  const { productName, quantity, estimatedPrice, description, buyerName, city, phone } = req.body;
  if (!productName || !buyerName || !phone) {
    return res.status(400).json({ error: 'Product name, buyer name and phone are required' });
  }

  let image = null;
  if (req.file) {
    try {
      const img = await storeImage(req.file.buffer, req.file.mimetype);
      image = img.host === 'imgbb' ? img.url : `data:${img.mime};base64,${img.data}`;
    } catch (err) {
      console.error('Inquiry image upload failed:', err.message);
      return res.status(500).json({ error: 'Image could not be uploaded. Please try again with a JPG or PNG under 5MB.' });
    }
  }

  const result = await pool.query(`
    INSERT INTO inquiries (product_name, image, quantity, estimated_price, description, buyer_name, city, phone)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
  `, [productName.trim(), image, quantity || '', estimatedPrice || '', description || '', buyerName.trim(), city || '', phone.trim()]);
  res.json({ success: true, inquiryId: result.rows[0].id });
});

// PUBLIC: List approved inquiries (no buyer name/phone)
app.get('/api/inquiries', async (req, res) => {
  const result = await pool.query(`
    SELECT id, product_name, image, quantity, estimated_price, description, city, created_at
    FROM inquiries WHERE status = 'approved'
    ORDER BY created_at DESC
  `);
  const inquiries = result.rows.map(r => ({
    id: r.id, productName: r.product_name, image: r.image, quantity: r.quantity,
    estimatedPrice: r.estimated_price, description: r.description, city: r.city, createdAt: r.created_at
  }));
  res.json({ inquiries });
});

// ADMIN: All inquiries with buyer contact details
app.get('/api/admin/inquiries', authAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM inquiries ORDER BY created_at DESC');
  const inquiries = result.rows.map(r => ({
    id: r.id, productName: r.product_name, image: r.image, quantity: r.quantity,
    estimatedPrice: r.estimated_price, description: r.description,
    buyerName: r.buyer_name, city: r.city, phone: r.phone,
    status: r.status, createdAt: r.created_at
  }));
  res.json({ inquiries });
});

// ADMIN: Approve / reject an inquiry
app.put('/api/admin/inquiries/:id', authAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const result = await pool.query('UPDATE inquiries SET status = $1 WHERE id = $2 RETURNING id', [status, req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ADMIN: Delete an inquiry
app.delete('/api/admin/inquiries/:id', authAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM inquiries WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// PUBLIC: Shops list
app.get('/api/shops', async (req, res) => {
  const result = await pool.query(`
    SELECT s.id, s.shop_number,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.active = true) AS product_count
    FROM shops s ORDER BY s.id
  `);
  const shops = result.rows.map(s => ({ id: s.id, shopNumber: s.shop_number, productCount: Number(s.product_count) }));
  res.json({ shops });
});

// PUBLIC: Categories list (managed categories + legacy product categories, with active product counts)
app.get('/api/categories', cached('categories', 600000, async (req, res) => {
  const result = await pool.query(`
    SELECT name, COUNT(t.id) AS count FROM (
      SELECT c.name AS name, p.id
      FROM categories c
      LEFT JOIN products p ON LOWER(p.category) = LOWER(c.name) AND p.active = true
      UNION ALL
      SELECT p.category AS name, p.id
      FROM products p
      WHERE p.active = true AND p.category IS NOT NULL AND p.category != ''
        AND NOT EXISTS (SELECT 1 FROM categories c WHERE LOWER(c.name) = LOWER(p.category))
    ) t
    GROUP BY name
    ORDER BY count DESC, name
  `);
  res.json({ categories: result.rows.map(r => ({ name: r.name, count: Number(r.count) })) });
}));

// AUTH: Shop login
app.post('/api/shop/login', async (req, res) => {
  const { shopNumber, password } = req.body;
  const result = await pool.query('SELECT * FROM shops WHERE shop_number = $1', [String(shopNumber)]);
  if (result.rows.length === 0 || !bcrypt.compareSync(password, result.rows[0].password)) {
    return res.status(401).json({ error: 'Invalid shop number or password' });
  }
  const shop = result.rows[0];
  const token = jwt.sign({ id: shop.id, shopNumber: shop.shop_number }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('shopToken', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ success: true, shopNumber: shop.shop_number });
});

// AUTH: Shop logout
app.post('/api/shop/logout', (req, res) => {
  res.clearCookie('shopToken');
  res.json({ success: true });
});

// AUTH: Shop - get own products
app.get('/api/shop/products', authShop, async (req, res) => {
  const result = await pool.query('SELECT * FROM products WHERE shop_id = $1 ORDER BY created_at DESC', [req.shopId]);
  const products = result.rows.map(p => ({
    id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
    description: p.description, category: p.category,
    image: p.image || null,
    active: p.active, createdAt: p.created_at
  }));
  res.json({ products });
});

// AUTH: Shop - add product
app.post('/api/shop/products', authShop, upload.single('image'), async (req, res) => {
  const { name, price, description, category, imageUrl: imageUrlBody, unit, stock } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });

  let imageHost = 'none';
  let img = null;
  if (req.file) {
    try {
      img = await storeImage(req.file.buffer, req.file.mimetype);
      imageHost = img.host;
    } catch (err) {
      console.error('Image storage failed:', err.message);
      return res.status(500).json({ error: 'Image could not be uploaded. Please try again with a JPG or PNG under 5MB.' });
    }
  }

  let finalImage = null;
  if (img && img.host === 'imgbb') {
    finalImage = img.url;
  } else if (imageUrlBody) {
    finalImage = imageUrlBody;
  }

  const result = await pool.query(`
    INSERT INTO products (shop_id, name, price, description, category, image)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [req.shopId, name, Number(price), description || '', category || '', finalImage]);
  const p = result.rows[0];

  if (img && img.host === 'local') {
    const localUrl = await saveImageForProduct(p.id, img);
    await pool.query('UPDATE products SET image = $1 WHERE id = $2', [localUrl, p.id]);
    p.image = localUrl;
  }
  res.json({
    success: true, product: {
      id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
      description: p.description, category: p.category,
      image: p.image || null,
      active: p.active, createdAt: p.created_at
    },
    imageHost
  });
});

// AUTH: Shop - edit product
app.put('/api/shop/products/:id', authShop, upload.single('image'), async (req, res) => {
  const check = await pool.query('SELECT * FROM products WHERE id = $1 AND shop_id = $2', [req.params.id, req.shopId]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });

  const { name, price, description, category, active } = req.body;
  const product = check.rows[0];

  let image = product.image;
  let imageHost = 'none';
  let img = null;
  if (req.file) {
    try {
      img = await storeImage(req.file.buffer, req.file.mimetype);
      imageHost = img.host;
      image = img.host === 'imgbb' ? img.url : null;
    } catch (err) {
      console.error('Image storage failed:', err.message);
      return res.status(500).json({ error: 'Image could not be uploaded. Please try again with a JPG or PNG under 5MB.' });
    }
  }

  const result = await pool.query(`
    UPDATE products SET
      name = COALESCE($1, name),
      price = COALESCE($2, price),
      description = COALESCE($3, description),
      category = COALESCE($4, category),
      active = COALESCE($5, active),
      image = COALESCE($6, image)
    WHERE id = $7 AND shop_id = $8 RETURNING *
  `, [name || null, price ? Number(price) : null, description !== undefined ? description : null, category !== undefined ? category : null, active !== undefined ? (active === 'true' || active === true) : null, image || null, req.params.id, req.shopId]);

  const p = result.rows[0];

  if (img && img.host === 'local') {
    image = await saveImageForProduct(p.id, img);
    await pool.query('UPDATE products SET image = $1 WHERE id = $2', [image, p.id]);
    p.image = image;
  }
  res.json({
    success: true, product: {
      id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
      description: p.description, category: p.category,
      image: p.image || null,
      active: p.active, createdAt: p.created_at
    },
    imageHost
  });
  delete cache['products'];
  delete cache['categories'];
});

// AUTH: Shop - delete product (soft delete)
app.delete('/api/shop/products/:id', authShop, async (req, res) => {
  const check = await pool.query('SELECT * FROM products WHERE id = $1 AND shop_id = $2', [req.params.id, req.shopId]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE products SET active = false WHERE id = $1', [req.params.id]);
  res.json({ success: true });
  delete cache['products'];
  delete cache['categories'];
});

// AUTH: Shop - get own orders
app.get('/api/shop/orders', authShop, async (req, res) => {
  const result = await pool.query('SELECT * FROM orders WHERE shop_id = $1 ORDER BY created_at DESC', [req.shopId]);
  const orders = result.rows.map(o => ({
    id: o.id, productId: o.product_id, shopId: o.shop_id,
    productName: o.product_name, productPrice: Number(o.product_price),     productImage: o.product_image,
    shopNumber: o.shop_number, customerName: o.customer_name, customerPhone: o.customer_phone,
    customerAddress: o.customer_address, quantity: o.quantity, totalAmount: Number(o.total_amount),
    status: o.status, createdAt: o.created_at
  }));
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
app.get('/api/admin/orders', authAdmin, async (req, res) => {
  const { status, shop } = req.query;
  let query = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  let i = 1;
  if (status) { query += ` AND status = $${i++}`; params.push(status); }
  if (shop) { query += ` AND shop_id = $${i++}`; params.push(shop); }
  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, params);
  const orders = result.rows.map(o => ({
    id: o.id, productId: o.product_id, shopId: o.shop_id,
    productName: o.product_name, productPrice: Number(o.product_price), productImage: o.product_image,
    shopNumber: o.shop_number, customerName: o.customer_name, customerPhone: o.customer_phone,
    customerAddress: o.customer_address, quantity: o.quantity, totalAmount: Number(o.total_amount),
    status: o.status, createdAt: o.created_at
  }));
  res.json({ orders });
});

// ADMIN: Update order status
app.put('/api/admin/orders/:id', authAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const result = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const o = result.rows[0];
  res.json({
    success: true, order: {
      id: o.id, productId: o.product_id, shopId: o.shop_id,
      productName: o.product_name, productPrice: Number(o.product_price),
      shopNumber: o.shop_number, customerName: o.customer_name, customerPhone: o.customer_phone,
      customerAddress: o.customer_address, quantity: o.quantity, totalAmount: Number(o.total_amount),
      status: o.status, createdAt: o.created_at
    }
  });
});

// ADMIN: Add shop
app.post('/api/admin/shops', authAdmin, async (req, res) => {
  const { shopNumber, password } = req.body;
  if (!shopNumber || !password) return res.status(400).json({ error: 'Shop number and password required' });

  const exists = await pool.query('SELECT id FROM shops WHERE shop_number = $1', [String(shopNumber)]);
  if (exists.rows.length > 0) return res.status(400).json({ error: 'Shop already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = await pool.query('INSERT INTO shops (shop_number, password) VALUES ($1, $2) RETURNING id, shop_number', [String(shopNumber), hash]);
  res.json({ success: true, shop: { id: result.rows[0].id, shopNumber: result.rows[0].shop_number } });
});

// ADMIN: Dashboard stats
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  const [orders, products, shops] = await Promise.all([
    pool.query('SELECT status, total_amount FROM orders'),
    pool.query('SELECT COUNT(*) AS count FROM products WHERE active = true'),
    pool.query('SELECT COUNT(*) AS count FROM shops')
  ]);
  const allOrders = orders.rows;
  res.json({
    totalOrders: allOrders.length,
    pendingOrders: allOrders.filter(o => o.status === 'pending').length,
    totalRevenue: allOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + Number(o.total_amount), 0),
    totalProducts: Number(products.rows[0].count),
    totalShops: Number(shops.rows[0].count),
  });
});

// ADMIN: All shops
app.get('/api/admin/shops', authAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT s.*,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.active = true) AS product_count
    FROM shops s ORDER BY s.id
  `);
  const shops = result.rows.map(s => ({
    id: s.id, shopNumber: s.shop_number, name: s.name, createdAt: s.created_at,
    productCount: Number(s.product_count)
  }));
  res.json({ shops });
});

// ADMIN: All products
app.get('/api/admin/products', authAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT p.*, s.shop_number
    FROM products p JOIN shops s ON p.shop_id = s.id
    ORDER BY p.created_at DESC
  `);
  const products = result.rows.map(p => ({
    id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
    description: p.description, category: p.category,
    image: p.image || null,
    active: p.active, createdAt: p.created_at, shopNumber: p.shop_number
  }));
  res.json({ products });
});

// ADMIN: Update product (name, price, category, description, active)
app.put('/api/admin/products/:id', authAdmin, async (req, res) => {
  const { name, price, description, category, active } = req.body;
  const result = await pool.query(`
    UPDATE products SET
      name = COALESCE($1, name),
      price = COALESCE($2, price),
      description = COALESCE($3, description),
      category = COALESCE($4, category),
      active = COALESCE($5, active)
    WHERE id = $6 RETURNING *
  `, [
    name !== undefined ? name : null,
    price !== undefined ? Number(price) : null,
    description !== undefined ? description : null,
    category !== undefined ? category : null,
    active !== undefined ? (active === 'true' || active === true) : null,
    req.params.id
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const p = result.rows[0];
  res.json({
    success: true, product: {
      id: p.id, shopId: p.shop_id, name: p.name, price: Number(p.price),
      description: p.description, category: p.category,
      image: p.image || null, active: p.active, createdAt: p.created_at
    }
  });
});

// ADMIN: Categories list (with active product counts)
app.get('/api/admin/categories', authAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT c.id, c.name,
      (SELECT COUNT(*) FROM products p WHERE LOWER(p.category) = LOWER(c.name) AND p.active = true) AS count
    FROM categories c
    ORDER BY c.name
  `);
  res.json({ categories: result.rows.map(r => ({ id: r.id, name: r.name, count: Number(r.count) })) });
});

// ADMIN: Add category
app.post('/api/admin/categories', authAdmin, async (req, res) => {
  const raw = (req.body && req.body.name) || '';
  const name = String(raw).trim();
  if (!name) return res.status(400).json({ error: 'Category name required' });
  try {
    const result = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name]);
    res.json({ success: true, category: { id: result.rows[0].id, name: result.rows[0].name } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Category already exists' });
    res.status(500).json({ error: 'Could not add category' });
  }
});

// ADMIN: Rename category (also updates all products in that category)
app.put('/api/admin/categories/:id', authAdmin, async (req, res) => {
  const raw = (req.body && req.body.name) || '';
  const newName = String(raw).trim();
  if (!newName) return res.status(400).json({ error: 'Category name required' });
  const old = await pool.query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
  if (old.rows.length === 0) return res.status(404).json({ error: 'Not found' });

  const dup = await pool.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND id != $2', [newName, req.params.id]);
  if (dup.rows.length > 0) return res.status(400).json({ error: 'Category already exists' });

  await pool.query('UPDATE categories SET name = $1 WHERE id = $2', [newName, req.params.id]);
  await pool.query('UPDATE products SET category = $1 WHERE LOWER(category) = LOWER($2)', [newName, old.rows[0].name]);
  res.json({ success: true, name: newName });
});

// ADMIN: Delete category (moves its products to General)
app.delete('/api/admin/categories/:id', authAdmin, async (req, res) => {
  const old = await pool.query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
  if (old.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  await pool.query('UPDATE products SET category = $1 WHERE LOWER(category) = LOWER($2)', ['General', old.rows[0].name]);
  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/inquiry', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inquiry.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.message && err.message.startsWith('Unsupported image type')) {
    return res.status(400).json({ error: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Image too large (max 5MB). Please use a smaller image.' });
  }
  res.status(500).json({ error: 'Something went wrong' });
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ohrimmarketplace running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
