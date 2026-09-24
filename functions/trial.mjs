/**
 * PENERIMA FORM TRIAL → DISCORD WEBHOOK
 * ─────────────────────────────────────────────────────────────
 * Halaman /trial mengirim data form ke sini (bukan langsung ke Discord),
 * supaya URL webhook Discord tidak pernah muncul di kode yang dikirim
 * ke browser pengunjung (index.html hanya berisi HTML/CSS/JS statis —
 * apa pun yang ditulis di sana bisa dilihat siapa saja lewat "View
 * Source", jadi webhook tidak boleh ada di situ).
 *
 * Webhook disimpan sebagai Netlify Environment Variable bernama
 * DISCORD_WEBHOOK_TRIAL — diatur lewat Netlify dashboard:
 *   Site settings → Environment variables → Add a variable
 * BUKAN ditulis langsung di file ini atau file manapun yang dikemas
 * ke zip/dibagikan ke orang lain.
 */

export default async (req) => {
  if (req.method !== 'POST') {
    return balas(405, { galat: 'Method tidak didukung.' });
  }

  const webhook = process.env.DISCORD_WEBHOOK_TRIAL;
  if (!webhook) {
    console.error('DISCORD_WEBHOOK_TRIAL belum diatur di Netlify Environment Variables.');
    return balas(500, { galat: 'Form belum terhubung ke Discord — hubungi admin JAGAL VFC.' });
  }

  let data;
  try {
    data = await req.json();
  } catch {
    return balas(400, { galat: 'Data form tidak valid.' });
  }

  const baris = (nama, lv) => (nama ? `${nama}${lv ? ' (Lv ' + lv + ')' : ''}` : null);
  const archetypeList =
    [baris(data.archetype1, data.level1), baris(data.archetype2, data.level2), baris(data.archetype3, data.level3)]
      .filter(Boolean)
      .join('\n') || '(tidak diisi)';

  const payload = {
    embeds: [
      {
        title: '📝 Pendaftaran Trial Baru — JAGAL VFC',
        description: 'EA SPORTS FC 27 · Pro Clubs',
        color: 0xe0263c,
        fields: [
          { name: 'Nama Akun', value: teks(data.namaAkun), inline: true },
          { name: 'Platform', value: teks(data.platform), inline: true },
          { name: 'Posisi Utama', value: teks(data.posisiUtama), inline: true },
          { name: 'Posisi Kedua', value: teks(data.posisiKedua, '– tidak ada –'), inline: true },
          { name: 'Username Discord', value: teks(data.discordId), inline: true },
          { name: 'Archetype & Level', value: archetypeList, inline: false },
          { name: 'Klub Sebelumnya', value: teks(data.klubSebelumnya, '(tidak diisi)'), inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error('Discord menolak webhook trial —', r.status, await r.text());
      return balas(502, { galat: 'Discord menolak pengiriman. Coba lagi nanti.' });
    }
    return balas(200, { ok: true });
  } catch (e) {
    console.error('Gagal kirim ke Discord —', e.message);
    return balas(502, { galat: 'Gagal terhubung ke Discord.' });
  }
};

function teks(v, fallback = '-') {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || fallback;
}

function balas(status, isi) {
  return new Response(JSON.stringify(isi), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const config = { path: '/trial-submit' };
