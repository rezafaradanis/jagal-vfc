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

  // Setelah data tersimpan: kirim rekap laga BARU ke Discord (kalau ada).
  // Gagal kirim rekap tidak membatalkan penyimpanan data di atas.
  let rekap;
  try {
    rekap = await kirimRekapLagaBaru(entri);
  } catch (e) {
    console.error('Rekap Discord gagal —', e.message);
    rekap = { galat: e.message };
  }

  return balas(200, { ok: true, tersimpan, total: entri.length, detail, rekap });
};

/* ══════════════════════════════════════════════════════════
   REKAP LAGA → DISCORD
   Memakai data laga yang baru dikirim laptop (bukan mengambil dari EA,
   karena EA memblokir server Netlify). Setiap laga hanya dikirim sekali:
   ID laga yang sudah dikirim dicatat di Netlify Blobs.
   Webhook diambil dari Environment Variable DISCORD_WEBHOOK_REKAP.
   ══════════════════════════════════════════════════════════ */
const KLUB_ID = '438867';

// Nama pemain di EA (huruf kecil) → Discord User ID (angka).
// Pemain yang terdaftar di sini di-tag di rekap; yang tidak ada, ditulis nama EA-nya.
// Cara dapat ID: Discord → Settings → Advanced → nyalakan Developer Mode →
// klik kanan nama orangnya → Copy User ID.
const DISCORD_ID = {
  'keenarok': '1036305251487191070', // KeenArok
  'gee-zoneplay': '558576386529427457', // GEE-ZONEPLAY
  'latern7': '396025684876853249', // laTern7
  'youngcrowheart': '1141025280534781973', // youngcrowheart
  'n0oootz': '396806701199654950', // N0oootz
  'driftking696911': '1088073183531388989', // driftking696911
  'kngsmn21': '275966698782195714', // Kngsmn21
  'doubleh5435': '1200129614283018342', // Doubleh5435
  'donnyalexandro13': '815384898058977301', // donnyalexandro13
  'leoawinz': '346719379125436417', // LeoAwinz
  'xzxgumgum': '306951542924115968', // XzXgumgum
  'fhmdayat': '541098505037414411', // fhmdayat
  'critze08': '216445737880387584', // critze08
};
function sebut(nama) {
  const id = DISCORD_ID[String(nama || '').trim().toLowerCase()];
  return id ? `<@${id}>` : nama;
}
const LABEL_TIPE = { leagueMatch: 'Liga', playoffMatch: 'Playoff', friendlyMatch: 'Friendly' };
// Saat fitur ini pertama kali jalan, laga lama tidak dikirim semua sekaligus:
// hanya laga dalam rentang ini yang dikirim, sisanya ditandai "sudah".
const BATAS_LAGA_AWAL_MS = 3 * 60 * 60 * 1000; // 3 jam

async function kirimRekapLagaBaru(entri) {
  const webhook = process.env.DISCORD_WEBHOOK_REKAP;
  if (!webhook) return { dilewati: 'DISCORD_WEBHOOK_REKAP belum diatur' };

  // Kumpulkan laga dari entri clubs/matches (liga, playoff, friendly).
  const laga = new Map();
  for (const item of entri) {
    if (String(item?.jalur || '').replace(/^\/+/, '') !== 'clubs/matches') continue;
    const tipe = new URLSearchParams(String(item.pencarian || '')).get('matchType') || '';
    let daftar;
    try { daftar = typeof item.data === 'string' ? JSON.parse(item.data) : item.data; } catch { continue; }
    for (const mm of Array.isArray(daftar) ? daftar : []) {
      if (mm?.matchId && !laga.has(String(mm.matchId))) laga.set(String(mm.matchId), { ...mm, _tipe: tipe });
    }
  }
  if (!laga.size) return { dicek: 0, terkirim: 0 };

  // Lama → baru, supaya urutan di Discord kronologis.
  const urut = [...laga.values()].sort((a, b) => (+a.timestamp || 0) - (+b.timestamp || 0));
  const store = getStore('rekap-match-terkirim');

  // Jalan pertama kali: tandai laga lama sebagai sudah dikirim (tanpa posting).
  if (!(await store.get('_mulai'))) {
    for (const mm of urut) {
      if (Date.now() - (+mm.timestamp || 0) * 1000 > BATAS_LAGA_AWAL_MS) {
        await store.set(String(mm.matchId), JSON.stringify({ dilewati: 'laga lama saat fitur mulai' }));
      }
    }
    await store.set('_mulai', new Date().toISOString());
  }

  let terkirim = 0;
  for (const mm of urut) {
    const id = String(mm.matchId);
    if (await store.get(id)) continue;
    if (await kirimKeDiscord(webhook, mm)) {
      await store.set(id, JSON.stringify({ dikirim: new Date().toISOString() }));
      terkirim++;
    }
  }
  console.log(`Rekap Discord: ${terkirim} laga baru dikirim dari ${urut.length} laga dicek.`);
  return { dicek: urut.length, terkirim };
}

async function kirimKeDiscord(webhook, mm) {
  const kami = mm.clubs?.[KLUB_ID];
  const lawanId = Object.keys(mm.clubs || {}).find((k) => k !== KLUB_ID);
  const lawan = mm.clubs?.[lawanId];
  if (!kami || !lawan) return false;

  const golKami = +kami.goals || 0;
  const golLawan = +lawan.goals || 0;
  const hasil = golKami > golLawan ? 'MENANG' : golKami < golLawan ? 'KALAH' : 'SERI';
  const warna = golKami > golLawan ? 0x2fbf71 : golKami < golLawan ? 0xe0263c : 0xe0b823;
  const emoji = golKami > golLawan ? '🟢' : golKami < golLawan ? '🔴' : '🟡';

  // Nama field sesuai data asli EA (dicek 25 Sep 2026).
  const pemain = Object.values(mm.players?.[KLUB_ID] || {})
    .map((pl) => ({
      nama: pl.playername || 'Pemain',
      gol: +pl.goals || 0,
      assist: +pl.assists || 0,
      tembakan: +pl.shots || 0,
      passSukses: +pl.passesmade || 0,
      passCoba: +pl.passattempts || 0,
      tekel: +pl.tacklesmade || 0,
      save: +pl.saves || 0,
      kartuMerah: +pl.redcards || 0,
      kiper: pl.pos === 'goalkeeper',
      rating: Math.round((+pl.rating || 0) * 10) / 10,
      mom: pl.mom === '1' || pl.mom === 1,
    }))
    .sort((a, b) => b.rating - a.rating);

  const potong = (s) => (s.length > 1024 ? s.slice(0, 1020) + '…' : s) || '-';
  const pencetakGol = potong(pemain.filter((p) => p.gol > 0).map((p) => `⚽ ${sebut(p.nama)} (${p.gol})`).join('\n'));
  const pemberiAssist = potong(pemain.filter((p) => p.assist > 0).map((p) => `🅰️ ${sebut(p.nama)} (${p.assist})`).join('\n'));
  const motm = pemain.find((p) => p.mom);
  const rincian = potong(pemain.map((p) => {
    const bagian = [`**${p.rating.toFixed(1)}**`];
    if (p.gol || p.assist) bagian.push(`${p.gol}G ${p.assist}A`);
    if (p.tembakan) bagian.push(`${p.tembakan} tembakan`);
    if (p.passCoba) bagian.push(`pass ${p.passSukses}/${p.passCoba}`);
    if (p.tekel) bagian.push(`${p.tekel} tekel`);
    if (p.kiper || p.save) bagian.push(`${p.save} save`);
    if (p.kartuMerah) bagian.push('🟥');
    return `${p.mom ? '⭐ ' : ''}${sebut(p.nama)} — ${bagian.join(' · ')}`;
  }).join('\n'));

  const namaLawan = lawan.details?.name || 'Lawan';
  const tanggal = new Date((+mm.timestamp || 0) * 1000);
  const fields = [
    { name: 'Pencetak Gol', value: pencetakGol, inline: true },
    { name: 'Assist', value: pemberiAssist, inline: true },
  ];
  if (motm) fields.push({ name: 'Man of the Match', value: `⭐ ${sebut(motm.nama)} (${motm.rating.toFixed(1)})`, inline: true });
  fields.push({ name: 'Rating & Statistik Pemain', value: rincian, inline: false });

  // Tag di dalam embed tampil sebagai mention tapi TIDAK mengirim notifikasi,
  // jadi pemain yang ikut main dan punya ID juga di-tag di baris 'content'.
  const idMain = [...new Set(pemain.map((p) => DISCORD_ID[p.nama.trim().toLowerCase()]).filter(Boolean))];
  const payload = {
    content: idMain.length ? `Line-up: ${idMain.map((id) => `<@${id}>`).join(' ')}` : undefined,
    allowed_mentions: { users: idMain },
    embeds: [{
      title: `${emoji} ${hasil} — JAGAL VFC ${golKami} – ${golLawan} ${namaLawan}`,
      description: `**${LABEL_TIPE[mm._tipe] || 'Pro Clubs'}** · ${tanggal.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' })}`,
      color: warna,
      fields,
      footer: { text: 'JAGAL VFC · EA SPORTS FC 27 Pro Clubs · jagal.fun' },
      timestamp: tanggal.toISOString(),
    }],
  };

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error('Discord menolak rekap —', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Gagal kirim rekap ke Discord —', e.message);
    return false;
  }
}

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
