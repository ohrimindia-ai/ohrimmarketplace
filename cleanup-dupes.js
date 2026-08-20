const BASE = 'https://ohrimmarketplace-1.onrender.com';

async function main() {
  // Login as shop 1
  const loginRes = await fetch(`${BASE}/api/shop/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopNumber: '1', password: 'shop123' })
  });
  const loginData = await loginRes.json();
  const cookie = loginRes.headers.get('set-cookie');
  console.log('Logged in:', loginData);

  // Get shop products
  const prodRes = await fetch(`${BASE}/api/shop/products`, { headers: { Cookie: cookie } });
  const { products } = await prodRes.json();
  console.log(`Total products for shop 1: ${products.length}`);

  // Find duplicates by name+price
  const seen = new Map();
  const dupes = [];
  for (const p of products) {
    const key = `${p.name}|${p.price}`;
    if (seen.has(key)) {
      dupes.push(p.id);
    } else {
      seen.set(key, p.id);
    }
  }
  console.log(`Duplicates to delete: ${dupes.length}`);

  // Delete duplicates
  let deleted = 0;
  let failed = 0;
  for (const id of dupes) {
    try {
      const res = await fetch(`${BASE}/api/shop/products/${id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
      });
      const data = await res.json();
      if (data.success) deleted++;
      else { failed++; console.log(`Failed delete ${id}:`, JSON.stringify(data)); }
    } catch (e) {
      failed++;
      console.log(`Error deleting ${id}:`, e.message);
    }
    if (deleted % 50 === 0 && deleted > 0) console.log(`Deleted ${deleted}/${dupes.length}`);
  }
  console.log(`Done! Deleted ${deleted}, failed ${failed}. Remaining: ${products.length - deleted}`);
}

main().catch(console.error);
