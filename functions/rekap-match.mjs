/**
 * REKAP MATCH OTOMATIS → DISCORD — JAGAL VFC
 * ─────────────────────────────────────────────────────────────
 * Fungsi ini berjalan SENDIRI secara terjadwal (lihat konfigurasi
 * "schedule" di bawah, dan blok [functions] di netlify.toml), tanpa
 * perlu ada pengunjung yang membuka website. Setiap kali berjalan, ia:
 *
 *   1. Mengambil daftar match terbaru klub JAGAL dari EA Pro Clubs API.
 *   2. Membandingkan dengan daftar match yang SUDAH pernah dikirim
 *      (disimpan di Netlify Blobs — penyimpanan key-value bawaan
 *      Netlify, gratis, tidak perlu setup database sendiri).
 *   3. Untuk setiap match yang BELUM pernah dikirim, menyusun pesan
 *      embed Discord (skor, rating tiap pemain, pencetak gol & assist)
 *      dan mengirimkannya ke webhook.
 *   4. Menandai match itu sebagai "sudah dikirim" supaya tidak
 *      terkirim dobel di jadwal berikutnya.
 *
 * CATATAN JUJUR SOAL KEANDALAN
 * - EA melindungi API mereka dengan Akamai; permintaan dari server
 *   (termasuk Netlify) kadang ditolak. Kalau gagal, fungsi ini akan
 *   diam dan mencoba lagi di jadwal berikutnya — tidak ada match yang
 *   "terlewat", karena daftar match terbaru selalu dicek ulang.
 * - Kalau Discord webhook belum diisi atau salah, fungsi ini akan
 *   berhenti tanpa error yang mengganggu pengunjung situs (fungsi ini
 *   tidak dipanggil dari halaman manapun).
 */

import { getStore } from '@netlify/blobs';

const EA_BASE = 'https://proclubs.ea.com/api/fc';
const BATAS_MS = 9000;

// ── Pengaturan klub — SAMAKAN dengan CONFIG di index.html ──
const KLUB = { id: '438867', nama: 'JAGAL', platform: 'common-gen5' };
// Webhook diambil dari Netlify Environment Variable (Site settings →
// Environment variables → DISCORD_WEBHOOK_REKAP), BUKAN ditulis di sini —
// supaya tidak pernah ikut terekspos kalau kode ini dibagikan/dikemas ulang.
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_REKAP;

const LABEL_TIPE = { leagueMatch: 'Liga', playoffMatch: 'Playoff', friendlyMatch: 'Friendly' };

export default async () => {
  if (!DISCORD_WEBHOOK) {
    console.log('DISCORD_WEBHOOK_REKAP belum diatur di Netlify Environment Variables — lewati.');
    return new Response('ok');
  }

  const store = getStore('rekap-match-terkirim');

  let matchBaru = [];
  for (const tipe of ['leagueMatch', 'playoffMatch', 'friendlyMatch']) {
    try {
      const mt = await ambilJSON(
        `${EA_BASE}/clubs/matches?matchType=${tipe}&platform=${KLUB.platform}&clubIds=${KLUB.id}&maxResultCount=5`
      );
      (mt || []).forEach((mm) => {
        if (mm.matchId) matchBaru.push({ ...mm, _tipe: tipe });
      });
    } catch (e) {
      console.error(`Gagal ambil ${tipe} —`, e.message);
    }
  }

  if (!matchBaru.length) {
    console.log('Tidak ada data match dari EA saat ini (mungkin ditolak Akamai).');
    return new Response('ok');
  }

  // Urutkan lama → baru supaya kalau ada beberapa match baru sekaligus,
  // urutan kirim ke Discord tetap kronologis.
  matchBaru.sort((a, b) => a.timestamp - b.timestamp);

  let terkirim = 0;
  for (const mm of matchBaru) {
    const idUnik = String(mm.matchId);
    const sudahAda = await store.get(idUnik);
    if (sudahAda) continue; // sudah pernah dikirim, lewati

    const kirimSukses = await kirimKeDiscord(mm);
    // Tandai sebagai terkirim HANYA kalau berhasil, supaya kalau Discord
    // gagal sesaat, match itu tetap dicoba lagi di jadwal berikutnya.
    if (kirimSukses) {
      await store.set(idUnik, JSON.stringify({ dikirim: new Date().toISOString() }));
      terkirim++;
    }
  }

  console.log(`Selesai. ${terkirim} match baru dikirim ke Discord dari ${matchBaru.length} match dicek.`);
  return new Response('ok');
};

async function kirimKeDiscord(mm) {
  const kami = mm.clubs?.[KLUB.id];
  const lawanId = Object.keys(mm.clubs || {}).find((k) => k !== String(KLUB.id));
  const lawan = mm.clubs?.[lawanId];
  if (!kami || !lawan) return false;

  const golKami = +kami.goals || 0;
  const golLawan = +lawan.goals || 0;
  const hasil = golKami > golLawan ? 'MENANG' : golKami < golLawan ? 'KALAH' : 'SERI';
  const warna = golKami > golLawan ? 0x2fbf71 : golKami < golLawan ? 0xe0263c : 0xe0b823;
  const emoji = golKami > golLawan ? '🟢' : golKami < golLawan ? '🔴' : '🟡';

  // Box score per pemain — sama seperti yang dipakai halaman Hasil Laga di web.
  const pemainRaw = mm.players?.[KLUB.id] || {};
  const pemain = Object.values(pemainRaw)
    .map((pl) => ({
      nama: pl.playername || 'Pemain',
      gol: +pl.goals || 0,
      assist: +pl.assists || 0,
      rating: Math.round((+pl.rating || 0) * 10) / 10,
      mom: pl.mom === '1' || pl.mom === 1,
    }))
    .sort((a, b) => b.rating - a.rating);

  const pencetakGol = pemain.filter((p) => p.gol > 0).map((p) => `⚽ ${p.nama} (${p.gol})`).join('\n') || '-';
  const pemberiAssist = pemain.filter((p) => p.assist > 0).map((p) => `🅰️ ${p.nama} (${p.assist})`).join('\n') || '-';
  const daftarRating = pemain.map((p) => `${p.mom ? '⭐ ' : ''}${p.nama} — **${p.rating.toFixed(1)}**`).join('\n') || '-';

  const namaLawan = lawan.details?.name || 'Lawan';
  const tanggal = new Date(mm.timestamp * 1000);

  const payload = {
    embeds: [
      {
        title: `${emoji} ${hasil} — JAGAL VFC ${golKami} – ${golLawan} ${namaLawan}`,
        description: `**${LABEL_TIPE[mm._tipe] || 'Pro Clubs'}** · ${tanggal.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`,
        color: warna,
        fields: [
          { name: 'Pencetak Gol', value: pencetakGol, inline: true },
          { name: 'Pemberi Assist', value: pemberiAssist, inline: true },
          { name: 'Rating Pemain', value: daftarRating, inline: false },
        ],
        footer: { text: 'JAGAL VFC · EA SPORTS FC 27 Pro Clubs' },
        timestamp: tanggal.toISOString(),
      },
    ],
  };

  try {
    const r = await ambil(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error('Discord menolak webhook —', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Gagal kirim ke Discord —', e.message);
    return false;
  }
}

async function ambil(url, opsi = {}) {
  const batal = new AbortController();
  const jam = setTimeout(() => batal.abort(), BATAS_MS);
  try {
    return await fetch(url, { ...opsi, signal: batal.signal, headers: { Accept: 'application/json', ...(opsi.headers || {}) } });
  } finally {
    clearTimeout(jam);
  }
}

async function ambilJSON(url) {
  const pemisah = url.includes('?') ? '&' : '?';
  const r = await ambil(`${url}${pemisah}_=${Date.now()}`);
  const teks = await r.text();
  const awal = teks.trim().charAt(0);
  if (!r.ok || (awal !== '{' && awal !== '[')) {
    throw new Error(`EA menolak (${r.status}): ${teks.slice(0, 150)}`);
  }
  return JSON.parse(teks);
}

// Jadwal: tiap 20 menit. Format cron standar (menit jam tgl bulan hari).
export const config = { schedule: '*/20 * * * *' };
