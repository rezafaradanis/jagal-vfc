/**
 * PENERIMA DATA EA DARI LAPTOP — JAGAL
 * ─────────────────────────────────────────────────────────────
 * EA/Akamai menolak (403) permintaan yang datang dari IP server Netlify,
 * tapi biasanya TIDAK menolak permintaan yang datang dari IP rumahan biasa
 * (seperti laptop pribadi yang buka game/app EA sehari-hari).
 *
 * Jadi alurnya dibalik untuk endpoint ini:
 *   1. Skrip kecil di laptop (scripts/update-ea.mjs di paket ini) yang
 *      mengambil data LANGSUNG dari EA memakai internet rumah/laptop.
 *   2. Skrip itu mengirim hasilnya ke sini (fungsi Netlify ini).
 *   3. Fungsi ini menyimpan data itu ke cache bersama yang SAMA dengan
 *      yang dipakai functions/ea.mjs — jadi begitu tersimpan, semua
 *      pengunjung situs otomatis melihat data ini tanpa perlu fetch
 *      langsung ke EA dari server Netlify sama sekali.
 *
 * KEAMANAN
 * Endpoint ini dilindungi kunci rahasia (KUNCI_UPDATE) yang harus dikirim
 * lewat header 'x-kunci-update'. Tanpa kunci yang cocok, permintaan
 * ditolak. Kunci ini diatur lewat Netlify Environment Variable bernama
 * KUNCI_UPDATE — BUKAN ditulis langsung di file ini atau di mana pun
 * yang dikemas/dibagikan.
 */

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') {
    return balas(405, { galat: 'Method tidak didukung, pakai POST.' });
  }

  const kunciDiharapkan = process.env.KUNCI_UPDATE;
  if (!kunciDiharapkan) {
    console.error('KUNCI_UPDATE belum diatur di Netlify Environment Variables.');
    return balas(500, { galat: 'Endpoint belum dikonfigurasi — hubungi admin JAGAL VFC.' });
  }

  const kunciDikirim = req.headers.get('x-kunci-update');
  if (kunciDikirim !== kunciDiharapkan) {
    return balas(401, { galat: 'Kunci tidak valid.' });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return balas(400, { galat: 'Body permintaan bukan JSON yang valid.' });
  }

  // payload berbentuk: { entri: [ { jalur: 'members/stats', pencarian: 'platform=...&clubId=...', data: {...} }, ... ] }
  // PENTING: kunci cache dibuat oleh buatKunciCache() di bawah, yang HARUS
  // sama persis dengan fungsi bernama sama di functions/ea.mjs.
  const entri = Array.isArray(payload?.entri) ? payload.entri : null;
  if (!entri || !entri.length) {
    return balas(400, { galat: 'Field "entri" kosong atau tidak berbentuk array.' });
  }

  const store = getStore('cache-ea');
  let tersimpan = 0;
  const detail = [];

  for (const item of entri) {
    const jalur = String(item?.jalur || '').replace(/^\/+/, '');
    if (!jalur || item?.data === undefined) {
      detail.push({ jalur: jalur || '(kosong)', ok: false, sebab: 'jalur atau data kosong' });
      continue;
    }
    const kunciCache = buatKunciCache(jalur, String(item?.pencarian || '').replace(/^\?/, ''));
    try {
      const teks = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
      await store.setJSON(kunciCache, { teks, waktu: Date.now(), sumber: 'laptop' });
      tersimpan++;
      detail.push({ jalur: kunciCache, ok: true });
    } catch (e) {
      detail.push({ jalur: kunciCache, ok: false, sebab: e.message });
    }
  }

  console.log(`Update dari laptop: ${tersimpan}/${entri.length} entri tersimpan ke cache.`);
  return balas(200, { ok: true, tersimpan, total: entri.length, detail });
};

// HARUS sama persis dengan buatKunciCache di ea.mjs.
function buatKunciCache(jalur, search) {
  const p = new URLSearchParams(search || '');
  p.delete('_');
  const pasangan = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}-${v}`);
  return `${jalur}__${pasangan.join('_')}`.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function balas(status, isi) {
  return new Response(JSON.stringify(isi, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Sengaja TIDAK memakai custom path (export const config = { path: ... }).
// Fungsi ini diakses lewat alamat default Netlify:
//   https://jagal.fun/.netlify/functions/terima-data
// Alamat default ini terbukti bisa dijangkau (sama seperti ea), sedangkan
// custom path sempat menghasilkan 404.
