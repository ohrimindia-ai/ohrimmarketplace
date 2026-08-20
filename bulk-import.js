const fs = require('fs');
const path = require('path');

const csvPath = '/Users/manishshah/Downloads/ohrim catalog - Sheet1.csv';
const BASE = 'https://ohrimmarketplace-1.onrender.com';

// Read CSV
const raw = fs.readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
const products = [];

// Parse CSV (handle commas in quoted fields)
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { parts.push(current.trim()); current = ''; continue; }
    current += c;
  }
  parts.push(current.trim());

  const [name, description, category, priceStr, unit, stock, imageUrl] = parts;
  if (!name || !priceStr) continue;

  // Parse price - extract number from strings like "450 RS", "70RS", "22RS/MTR"
  const priceMatch = priceStr.match(/(\d+(?:\.\d+)?)/);
  const price = priceMatch ? Number(priceMatch[1]) : 0;

  // Parse stock
  const stockNum = stock ? Number(stock) || 50 : 50;

  products.push({ name, description: description || '', category: category || '', price, unit: unit || 'PC', stock: stockNum, imageUrl: imageUrl || '' });
}

console.log(`Parsed ${products.length} products from CSV`);

async function login() {
  const res = await fetch(`${BASE}/api/shop/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopNumber: '1', password: 'shop123' })
  });
  const data = await res.json();
  if (!data.success) throw new Error('Login failed: ' + JSON.stringify(data));
  const cookie = res.headers.get('set-cookie');
  console.log('Logged in as Shop 1');
  return cookie;
}

async function createProduct(cookie, product, index) {
  const body = {
    name: product.name,
    price: product.price,
    description: product.description,
    category: product.category,
    imageUrl: product.imageUrl,
    unit: product.unit,
    stock: product.stock
  };

  const res = await fetch(`${BASE}/api/shop/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data;
}

async function main() {
  const cookie = await login();
  let success = 0, failed = 0;

  const SKIP = parseInt(process.argv[2] || '0', 10);
  for (let i = SKIP; i < products.length; i++) {
    const p = products[i];
    try {
      const result = await createProduct(cookie, p, i);
      if (result.success) {
        success++;
        if ((i + 1) % 20 === 0) console.log(`Progress: ${i + 1}/${products.length} (success: ${success}, failed: ${failed})`);
      } else {
        failed++;
        console.log(`Failed [${i + 1}] ${p.name}: ${JSON.stringify(result)}`);
      }
    } catch (err) {
      failed++;
      console.log(`Error [${i + 1}] ${p.name}: ${err.message}`);
    }
  }

  console.log(`\nDone! Success: ${success}, Failed: ${failed}, Total: ${products.length}`);
}

main().catch(console.error);
