/**
 * JEMBATAN KE DATA EA — JAGAL
 * ─────────────────────────────────────────────────────────────
 * Halaman memanggil /ea/members/stats?... dan sejenisnya. Fungsi ini
 * meneruskan permintaan itu ke server resmi EA Pro Clubs dari sisi
 * server Netlify (bukan dari browser pengunjung), lalu mengirim balik
 * hasilnya ke halaman.
 *
 * CATATAN JUJUR SOAL KEANDALAN
 * EA melindungi API mereka dengan Akamai, dan endpoint ini TIDAK
 * didokumentasikan resmi oleh EA — perilaku dan strukturnya bisa
 * berubah kapan saja. Permintaan dari server (termasuk Netlify)
 * KADANG ditolak ("Access Denied" / 403) dan KADANG diloloskan.
 * Untuk memperbesar peluang lolos:
 *   1. Kirim header yang menyerupai permintaan dari browser sungguhan
 *      (User-Agent, Referer, Origin) — Akamai sering menyaring
 *      permintaan yang terlihat seperti bot/server polos.
 *   2. Coba ulang otomatis 1x kalau percobaan pertama gagal (jaringan
 *      EA kadang menolak sesaat lalu meloloskan permintaan berikutnya).
 *   3. Simpan hasil sukses ke cache bersama (Netlify Blobs) selama
 *      CACHE_TTL_MS supaya tidak semua pengunjung memicu fetch baru
 *      ke EA — mengurangi risiko kena rate-limit dan mempercepat
 *      halaman. Kalau fetch EA gagal tapi cache lama masih ada,
 *      cache itu yang dipakai (lebih baik data agak basi daripada
 *      error ke pengunjung).
 * Kalau semua di atas tetap gagal, fungsi ini mengembalikan error
 * yang jelas (dengan kode status EA apa adanya) ke halaman, dan
 * halaman akan menampilkan data cadangan (snapshot terakhir yang
 * tertanam di kode) supaya situs tidak pernah kosong.
 */

import { getStore } from '@netlify/blobs';

const LANGSUNG = 'https://proclubs.ea.com/api/fc';
const BATAS_MS = 8000;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 menit — cukup segar, cukup jarang memanggil EA.
const LAPTOP_TTL_MS = 30 * 60 * 1000; // data kiriman laptop dipakai langsung sampai 30 menit.

// Kunci cache tanpa karakter khusus (?, &, =) supaya aman disimpan dan dibaca
// Netlify Blobs. HARUS sama persis dengan fungsi yang sama di terima-data.mjs.
// Parameter "_" (penanda anti-cache) diabaikan, urutan parameter disamakan.
function buatKunciCache(jalur, search) {
  const p = new URLSearchParams(search || '');
  p.delete('_');
  const pasangan = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}-${v}`);
  return `${jalur}__${pasangan.join('_')}`.replace(/[^A-Za-z0-9_.-]/g, '-');
}
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export default async (req) => {
  const masuk = new URL(req.url);
  // Fungsi ini bisa dipanggil lewat custom path (/ea/...) ATAU lewat alamat
  // default Netlify Functions (/.netlify/functions/ea/...) — tergantung mana
  // yang berhasil di-route oleh CDN. Kedua awalan itu dilepas di sini supaya
  // parsing jalurnya tetap benar apa pun rutenya.
  const jalur = masuk.pathname
    .replace(/^\/\.netlify\/functions\/ea\/?/, '')
    .replace(/^\/ea\/?/, '')
    .replace(/^\/+/, '');
  if (!jalur) return balas(400, { galat: 'Jalur EA tidak disebutkan.' });

  const kunciCache = buatKunciCache(jalur, masuk.search);
  const store = getStore('cache-ea');

  // 1) Coba cache bersama dulu — kalau masih segar, langsung pakai tanpa panggil EA.
  //    Data kiriman laptop (sumber: 'laptop') dianggap segar lebih lama, karena
  //    laptop mengirim ulang tiap 10 menit selama menyala.
  let entriCache = null;
  let galatCache = null;
  try {
    entriCache = await store.get(kunciCache, { type: 'json' });
  } catch (e) { galatCache = e.message; }

  const umurCache = entriCache ? Date.now() - entriCache.waktu : Infinity;
  const batasSegar = entriCache?.sumber === 'laptop' ? LAPTOP_TTL_MS : CACHE_TTL_MS;
  if (entriCache && umurCache < batasSegar) {
    return new Response(entriCache.teks, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Sumber-Cache': entriCache.sumber === 'laptop' ? 'laptop' : 'hit',
        'X-Cache-Umur-Ms': String(umurCache),
        // Kapan data ini diambil dari EA (ms sejak 1970) — dipakai label di situs.
        'X-Data-Waktu': String(entriCache.waktu),
      },
    });
  }

  // 2) Cache basi/tidak ada — coba ambil dari EA langsung, dengan 1x retry.
  const pemisah = masuk.search ? '&' : '?';
  const url = `${LANGSUNG}/${jalur}${masuk.search}${pemisah}_=${Date.now()}`;

  let percobaanTerakhir = null;
  for (let percobaan = 0; percobaan < 2; percobaan++) {
    try {
      const r = await ambil(url);
      const teks = await r.text();
      const awal = teks.trim().charAt(0);
      if (r.ok && (awal === '{' || awal === '[')) {
        // Sukses — simpan ke cache bersama supaya pengunjung berikutnya tidak perlu fetch ulang.
        try {
          await store.setJSON(kunciCache, { teks, waktu: Date.now() });
        } catch { /* gagal simpan cache bukan fatal, tetap balas sukses ke pengunjung */ }
        return new Response(teks, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'X-Sumber-Cache': 'miss',
            'X-Data-Waktu': String(Date.now()),
          },
        });
      }
      percobaanTerakhir = { status: r.status, teks };
      console.error(`EA menolak (percobaan ${percobaan + 1}) —`, r.status, teks.slice(0, 200));
    } catch (e) {
      percobaanTerakhir = { status: 0, teks: e.message, abort: e.name === 'AbortError' };
      console.error(`EA tidak terjangkau (percobaan ${percobaan + 1}) —`, e.message);
    }
  }

  // 3) Kedua percobaan gagal. Kalau masih ada cache lama (walau sudah lewat TTL),
  //    lebih baik pakai itu daripada mengembalikan error kosong ke halaman.
  if (entriCache) {
    return new Response(entriCache.teks, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Sumber-Cache': 'stale',
        'X-Cache-Umur-Ms': String(Date.now() - entriCache.waktu),
        'X-Data-Waktu': String(entriCache.waktu),
      },
    });
  }

  // 4) Tidak ada cache sama sekali — balas error apa adanya ke halaman
  //    (halaman lalu menampilkan data cadangan bawaan kode).
  return balas(502, {
    galat: percobaanTerakhir?.abort ? 'Data EA tidak terjangkau.' : 'Data EA tidak tersedia saat ini.',
    status: percobaanTerakhir?.status ?? null,
    kunciCache,
    galatCache,
    catatan: percobaanTerakhir?.abort
      ? `tidak menjawab dalam ${BATAS_MS} ms`
      : (percobaanTerakhir?.teks || '').includes('Access Denied')
        ? 'Ditolak Akamai (403 Access Denied) — endpoint EA tidak resmi/tidak didokumentasikan, bisa ditolak sewaktu-waktu'
        : (percobaanTerakhir?.teks || '').slice(0, 200),
  });
};

async function ambil(url) {
  const batal = new AbortController();
  const jam = setTimeout(() => batal.abort(), BATAS_MS);
  try {
    return await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA_BROWSER,
        Referer: 'https://www.ea.com/',
        Origin: 'https://www.ea.com',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: batal.signal,
    });
  } finally {
    clearTimeout(jam);
  }
}

function balas(status, isi) {
  return new Response(JSON.stringify(isi, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Sengaja TANPA custom path: fungsi dipanggil lewat alamat bawaan Netlify
// (/.netlify/functions/ea/...). Custom path membuat alamat bawaan mati dan
// sempat menyebabkan 404.
