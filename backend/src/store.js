import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

import { STORE_URL } from './catalog.js';

const useSupabase =
  process.env.USE_SUPABASE === 'true' &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = useSupabase
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  : null;


// ---------------------------------------------------------
// LOCAL FALLBACK STORAGE
// ---------------------------------------------------------

const demoProducts = [];
const history = new Map();
const logs = new Map();


// Catalog logic lives in catalog.js
export { searchProducts, getCatalogProduct, getCatalog, catalogStatus } from './catalog.js';


// ---------------------------------------------------------
// LIST TRACKED PRODUCTS
// ---------------------------------------------------------

export async function listTracked() {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('tracked_products')
      .select('*')
      .order('created_at', {
        ascending: false,
      });

    if (error) {
      throw error;
    }

    return data;
  }

  return demoProducts;
}


// ---------------------------------------------------------
// GET ONE TRACKED PRODUCT
// ---------------------------------------------------------

export async function getTracked(id) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  return (
    demoProducts.find(
      (product) =>
        String(product.id) === String(id)
    ) || null
  );
}


// ---------------------------------------------------------
// TRACK PRODUCT
// ---------------------------------------------------------

export async function trackProduct(product) {
  const normalizedProduct = {
    id: String(product.id),

    name: product.name,

    url: `${STORE_URL}/product/${product.id}`, // always derived from id
    brand: product.brand || null,
    sku: product.sku || null,
  };

  if (useSupabase) {
    const { data, error } = await supabase
      .from('tracked_products')
      .upsert({
        id: normalizedProduct.id,
        name: normalizedProduct.name,
        url: normalizedProduct.url,
        brand: normalizedProduct.brand,
        sku: normalizedProduct.sku,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }


  const existing = demoProducts.find(
    (product) =>
      String(product.id) ===
      String(normalizedProduct.id)
  );

  if (existing) {
    return existing;
  }


  const storedProduct = {
    ...normalizedProduct,

    current_price: null,
    current_stock: null,
    last_scraped_at: null,
  };


  demoProducts.push(storedProduct);

  history.set(
    storedProduct.id,
    []
  );

  logs.set(
    storedProduct.id,
    []
  );

  return storedProduct;
}


// ---------------------------------------------------------
// SAVE PRICE OBSERVATION
// ---------------------------------------------------------

export async function saveObservation(id, obs) {
  const timestamp =
    obs.scraped_at ||
    new Date().toISOString();


  if (useSupabase) {
    // Ensure product exists.
    const {
      data: product,
      error: productError,
    } = await supabase
      .from('tracked_products')
      .select('current_price,current_stock')
      .eq('id', id)
      .single();

    if (productError) {
      throw productError;
    }


    // Save history.
    const { error: historyError } =
      await supabase
        .from('price_history')
        .insert({
          tracked_product_id: id,

          price: obs.price,

          stock: obs.stock,

          scraped_at: timestamp,
        });

    if (historyError) {
      throw historyError;
    }


    // Update latest state.
    const {
      data,
      error,
    } = await supabase
      .from('tracked_products')
      .update({
        current_price: obs.price,

        current_stock: obs.stock,

        last_scraped_at: timestamp,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }


  // Local fallback.
  const product = demoProducts.find(
    (product) =>
      String(product.id) === String(id)
  );

  if (!product) {
    throw new Error(
      'Tracked product not found'
    );
  }


  product.current_price =
    obs.price;

  product.current_stock =
    obs.stock;

  product.last_scraped_at =
    timestamp;


  const productHistory =
    history.get(String(id)) || [];


  productHistory.unshift({
    price: obs.price,

    stock: obs.stock,

    scraped_at: timestamp,
  });


  productHistory.splice(
    Number(
      process.env.HISTORY_LIMIT || 100
    )
  );


  history.set(
    String(id),
    productHistory
  );


  return product;
}


// ---------------------------------------------------------
// ADD SCRAPE LOG
// ---------------------------------------------------------

export async function addLog(id, log) {
  const row = {
    ...log,

    attempted_at:
      log.attempted_at ||
      new Date().toISOString(),
  };


  if (useSupabase) {
    const { error } = await supabase
      .from('scrape_logs')
      .insert({
        tracked_product_id: id,

        ...row,
      });

    if (error) {
      throw error;
    }

    return row;
  }


  const productLogs =
    logs.get(String(id)) || [];


  productLogs.unshift(row);

  productLogs.splice(100);


  logs.set(
    String(id),
    productLogs
  );


  return row;
}


// ---------------------------------------------------------
// GET PRICE HISTORY
// ---------------------------------------------------------

export async function getHistory(
  id,
  limit = 100
) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('price_history')
      .select(
        'price,stock,scraped_at'
      )
      .eq(
        'tracked_product_id',
        id
      )
      .order(
        'scraped_at',
        {
          ascending: false,
        }
      )
      .limit(limit);

    if (error) {
      throw error;
    }

    return data;
  }


  return (
    history.get(String(id)) || []
  ).slice(0, limit);
}


// ---------------------------------------------------------
// GET SCRAPE LOGS
// ---------------------------------------------------------

export async function getLogs(
  id,
  limit = 100
) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('scrape_logs')
      .select('*')
      .eq(
        'tracked_product_id',
        id
      )
      .order(
        'attempted_at',
        {
          ascending: false,
        }
      )
      .limit(limit);

    if (error) {
      throw error;
    }

    return data;
  }


  return (
    logs.get(String(id)) || []
  ).slice(0, limit);
}