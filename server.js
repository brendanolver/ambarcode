const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AM_BASE_URL = process.env.AM_BASE_URL;
const AM_API_TOKEN = process.env.AM_API_TOKEN;
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;

const pnHeaders = {
  'Authorization': 'Basic ' + Buffer.from(PRINTNODE_API_KEY + ':').toString('base64'),
  'Content-Type': 'application/json',
};

async function amFetch(endpoint, params = {}) {
  const url = new URL(`${AM_BASE_URL}/api/${endpoint}/?/${endpoint}`);
  url.searchParams.set('token', AM_API_TOKEN);
  url.searchParams.set('time', Math.floor(Date.now() / 1000).toString());
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  const res = await fetch(url.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`AM API ${res.status}: ${res.statusText}`);
  return res.json();
}

app.get('/api/products', async (req, res) => {
  try {
    const { search, category, collection, page } = req.query;
    const params = {
      'pagination[page_size]': '50',
      'pagination[page_number]': page || '1',
    };
    let filterIdx = 0;
    if (search) {
      params[`parameters[${filterIdx}][field]`] = 'description';
      params[`parameters[${filterIdx}][operator]`] = 'contains';
      params[`parameters[${filterIdx}][value]`] = search;
      filterIdx++;
    }
    if (category) {
      params[`parameters[${filterIdx}][field]`] = 'category';
      params[`parameters[${filterIdx}][operator]`] = '=';
      params[`parameters[${filterIdx}][value]`] = category;
      filterIdx++;
    }
    if (collection) {
      params[`parameters[${filterIdx}][field]`] = 'collection';
      params[`parameters[${filterIdx}][operator]`] = '=';
      params[`parameters[${filterIdx}][value]`] = collection;
      filterIdx++;
    }
    const data = await amFetch('products', params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const params = {
      'parameters[0][field]': 'product_id',
      'parameters[0][operator]': '=',
      'parameters[0][value]': req.params.id,
      'pagination[page_size]': '10',
    };
    const data = await amFetch('products', params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const data = await amFetch('products', {
      'pagination[page_size]': '1000',
    });
    const categories = [...new Set(
      data.response.map(p => p.category).filter(Boolean)
    )].sort();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/collections', async (req, res) => {
  try {
    const data = await amFetch('products', {
      'pagination[page_size]': '1000',
    });
    const collections = [...new Set(
      data.response.map(p => p.collection).filter(Boolean)
    )].sort();
    res.json(collections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventory/:productId', async (req, res) => {
  try {
    const params = {
      'parameters[0][field]': 'product_id',
      'parameters[0][operator]': '=',
      'parameters[0][value]': req.params.productId,
      'pagination[page_size]': '100',
    };
    const data = await amFetch('inventory', params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/printers', async (req, res) => {
  try {
    const r = await fetch('https://api.printnode.com/printers', { headers: pnHeaders });
    if (!r.ok) throw new Error(`PrintNode ${r.status}`);
    const printers = await r.json();
    const zebras = printers
      .filter(p => p.description.includes('GK420d') && p.state === 'online')
      .map(p => ({ id: p.id, name: p.name, computer: p.computer.name }));
    res.json(zebras);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/print', async (req, res) => {
  try {
    const { printerId, items } = req.body;
    if (!printerId || !items?.length) {
      return res.status(400).json({ error: 'printerId and items required' });
    }
    const results = [];
    for (const item of items) {
      const zpl = buildZPL(item);
      for (let i = 0; i < (item.qty || 1); i++) {
        const r = await fetch('https://api.printnode.com/printjobs', {
          method: 'POST',
          headers: pnHeaders,
          body: JSON.stringify({
            printerId: parseInt(printerId),
            title: `Barcode - ${item.styleNumber} ${item.size || ''}`.trim(),
            contentType: 'raw_base64',
            content: Buffer.from(zpl).toString('base64'),
            source: 'AM Barcode App',
          }),
        });
        if (!r.ok) throw new Error(`PrintNode ${r.status}: ${await r.text()}`);
        results.push(await r.json());
      }
    }
    res.json({ success: true, jobCount: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildZPL(item) {
  const barcode = item.styleNumber + (item.size ? '-' + item.size : '');
  return `^XA
^CF0,30
^FO50,30^FD${item.description}^FS
^CF0,22
^FO50,70^FD${item.styleNumber}${item.size ? '  Size: ' + item.size : ''}^FS
^FO50,100^FDRetail: $${item.retailPrice}^FS
^BY2,2,80
^FO50,140^BC,,Y,N,N^FD${barcode}^FS
^XZ`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AM Barcode app running on port ${PORT}`);
});
