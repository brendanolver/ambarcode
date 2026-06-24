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
      const skus = await amFetch('inventory', {
        'parameters[0][field]': 'product_id',
        'parameters[0][operator]': '=',
        'parameters[0][value]': item.productId,
        'pagination[page_size]': '100',
      });

      const skuList = skus.response || [];
      const matchingSkus = item.size
        ? skuList.filter(s => s.size === item.size)
        : skuList;

      if (!matchingSkus.length) {
        const fallbackZpl = buildZPL({
          barcode: item.styleNumber,
          description: item.description,
          colour: item.colour || '',
          size: item.size || '',
          styleNumber: item.styleNumber,
          audRetail: item.retailPrice,
          nzdRetail: (parseFloat(item.retailPrice) + 10).toFixed(2),
        });
        for (let i = 0; i < (item.qty || 1); i++) {
          const r = await sendPrintJob(printerId, item.styleNumber, item.size, fallbackZpl);
          results.push(r);
        }
        continue;
      }

      for (const sku of matchingSkus) {
        const audRetail = parseFloat(sku.retail_price || item.retailPrice || 0).toFixed(2);
        const nzdRetail = (parseFloat(audRetail) + 10).toFixed(2);
        const zpl = buildZPL({
          barcode: sku.upc_display || item.styleNumber,
          description: item.description,
          colour: sku.attr_2 || item.colour || '',
          size: sku.size || item.size || '',
          styleNumber: item.styleNumber,
          audRetail,
          nzdRetail,
        });
        for (let i = 0; i < (item.qty || 1); i++) {
          const r = await sendPrintJob(printerId, item.styleNumber, sku.size, zpl);
          results.push(r);
        }
      }
    }
    res.json({ success: true, jobCount: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendPrintJob(printerId, styleNumber, size, zpl) {
  const r = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: pnHeaders,
    body: JSON.stringify({
      printerId: parseInt(printerId),
      title: `Barcode - ${styleNumber} ${size || ''}`.trim(),
      contentType: 'raw_base64',
      content: Buffer.from(zpl).toString('base64'),
      source: 'AM Barcode App',
    }),
  });
  if (!r.ok) throw new Error(`PrintNode ${r.status}: ${await r.text()}`);
  return r.json();
}

function formatBarcodeDisplay(barcode) {
  if (barcode.length === 13) {
    return `${barcode[0]}  ${barcode.substring(1, 7)}  ${barcode.substring(7)}`;
  }
  return barcode;
}

function buildZPL(item) {
  return `~JC
^XA
^CI28
^MNY
^PW320
^LL320
^LH0,0
^FO4,24^A0N,28,28^FB280,1,0,R,0^FDWNDRR^FS
^FO84,62^BY1,3,70^BCN,70,N,N,N^FD${item.barcode}^FS
^FO4,140^A0N,20,20^FB312,1,0,C,0^FD${formatBarcodeDisplay(item.barcode)}^FS
^FO4,178^A0N,22,22^FD${item.description}^FS
^FO4,202^A0N,22,22^FD${item.colour}^FS
^FO4,226^A0N,22,22^FDSIZE: ${item.size}^FS
^FO4,252^A0N,22,22^FD${item.styleNumber}^FS
^FO4,252^A0N,22,22^FB290,1,0,R,0^FDAUD $${item.audRetail}^FS
^FO4,276^A0N,22,22^FB290,1,0,R,0^FDNZD $${item.nzdRetail}^FS
^XZ`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AM Barcode app running on port ${PORT}`);
});
