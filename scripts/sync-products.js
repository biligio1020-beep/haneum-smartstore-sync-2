import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { classifyProduct } from './category-rules.js';

const STORE_SLUG = process.env.NAVER_STORE_SLUG || '1-2-';
const PROXY_URL = process.env.CAFE24_NAVER_PROXY_URL ||
  'https://rocknme.cafe24.com/newhome/api/naver-relay.php';
const OUTPUT = path.resolve('output/products.js');

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`필수 GitHub Secret 누락: ${name}`);
  return v;
}

async function relay(action, body, contentType, token = '') {
  const headers = {
    'Content-Type': contentType,
    'Accept': 'application/json',
    'X-Haneum-Key': must('HANEUM_PROXY_KEY')
  };
  if (token) headers['X-Naver-Token'] = token;

  const res = await fetch(`${PROXY_URL}?action=${action}`, {
    method: 'POST',
    headers,
    body
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cafe24 relay ${action} 실패 (${res.status}): ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cafe24 relay가 JSON이 아닌 값을 반환함: ${text}`);
  }
}

async function getAccessToken() {
  const clientId = must('NAVER_CLIENT_ID');
  const clientSecret = must('NAVER_CLIENT_SECRET');
  const timestamp = Date.now().toString();

  const password = `${clientId}_${timestamp}`;
  const bcryptHash = bcrypt.hashSync(password, clientSecret);
  const clientSecretSign = Buffer.from(bcryptHash, 'utf8').toString('base64');

  const form = new URLSearchParams({
    client_id: clientId,
    timestamp,
    grant_type: 'client_credentials',
    client_secret_sign: clientSecretSign,
    type: 'SELF'
  });

  const data = await relay(
    'token',
    form.toString(),
    'application/x-www-form-urlencoded'
  );

  if (!data.access_token) {
    throw new Error(`access_token 없음: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function fetchPage(token, page) {
  const body = JSON.stringify({
    productStatusTypes: ['SALE', 'OUTOFSTOCK', 'CLOSE'],
    page,
    size: 500,
    orderType: 'REG_DATE'
  });

  return relay('products', body, 'application/json', token);
}

function extractProducts(payload) {
  const out = [];

  for (const item of payload.contents || []) {
    for (const p of item.channelProducts || []) {
      if (p.channelServiceType && p.channelServiceType !== 'STOREFARM') continue;

      const c = classifyProduct(p.name || '', p.wholeCategoryName || '');
      const status = p.statusType || 'SALE';

      out.push({
        id: String(p.channelProductNo || ''),
        channelProductNo: String(p.channelProductNo || ''),
        name: p.name || '',
        price: Number(p.discountedPrice || p.salePrice || 0),
        originalPrice: Number(p.salePrice || 0),
        image: p.representativeImage?.url || '',
        status,
        soldout: status === 'OUTOFSTOCK' || status === 'CLOSE',
        category: c.group,
        subcategory: c.sub,
        wholeCategoryName: p.wholeCategoryName || '',
        brand: p.brandName || '',
        url: p.channelProductNo
          ? `https://smartstore.naver.com/${STORE_SLUG}/products/${p.channelProductNo}`
          : `https://smartstore.naver.com/${STORE_SLUG}`,
        regDate: p.regDate || '',
        modifiedDate: p.modifiedDate || ''
      });
    }
  }

  return out;
}

async function fetchAll(token) {
  let page = 1;
  const all = [];

  while (true) {
    const payload = await fetchPage(token, page);
    all.push(...extractProducts(payload));

    const last = payload.last === true ||
      page >= Number(payload.totalPages || 1);

    if (last) break;

    page++;
    if (page > 100) throw new Error('상품 조회가 100페이지를 초과했습니다.');
  }

  const dedup = new Map();
  for (const p of all) dedup.set(p.channelProductNo, p);

  return [...dedup.values()].sort(
    (a, b) => String(b.regDate).localeCompare(String(a.regDate))
  );
}

async function makeProductsJs(products) {
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });

  const text =
    '/* AUTO-GENERATED. DO NOT EDIT. */\n' +
    `window.HANEUM_PRODUCTS = ${JSON.stringify(products, null, 2)};\n`;

  await fs.writeFile(OUTPUT, text, 'utf8');
  return text;
}

async function publishProductsJs(text) {
  const res = await fetch(`${PROXY_URL}?action=publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/javascript; charset=UTF-8',
      'X-Haneum-Key': must('HANEUM_PROXY_KEY')
    },
    body: text
  });

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error(`Cafe24 publish 실패 (${res.status}): ${responseText}`);
  }

  if (!responseText.includes('PUBLISH_OK')) {
    throw new Error(`Cafe24 publish 응답 이상: ${responseText}`);
  }

  console.log(responseText.trim());
}

async function main() {
  console.log('1/4 네이버 인증 요청');
  const token = await getAccessToken();

  console.log('2/4 스마트스토어 상품 조회');
  const products = await fetchAll(token);
  console.log(`상품 ${products.length}개 확인`);

  console.log('3/4 products.js 생성');
  const productsJs = await makeProductsJs(products);

  console.log('4/4 Cafe24 홈페이지에 직접 반영');
  await publishProductsJs(productsJs);

  console.log('동기화 완료');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
