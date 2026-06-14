const functions = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const https = require("https"); // eslint-disable-line no-unused-vars
admin.initializeApp();
const db = admin.firestore();

const fetch = require("node-fetch");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
// firebase functions:secrets:set CRON_SECRET  (chaîne aléatoire longue)
const CRON_SECRET = defineSecret("CRON_SECRET");

// ── Prix parsing ──────────────────────────────────────────────────

function parseAudPrice(html) {
  const candidates = [];

  // 1. JSON-LD / JSON "price" field (le plus fiable)
  const jsonRe = /"price"\s*:\s*"?([\d]{2,5}(?:\.\d{1,2})?)"?/g;
  let m;
  while ((m = jsonRe.exec(html)) !== null) {
    const p = parseFloat(m[1]);
    if (p >= 50 && p <= 15000) candidates.push(p);
  }

  // 2. Attributs data-price ou data-sale-price
  const dataRe = /data-(?:sale-)?price="([\d]{2,5}(?:\.\d{1,2})?)"/g;
  while ((m = dataRe.exec(html)) !== null) {
    const p = parseFloat(m[1]);
    if (p >= 50 && p <= 15000) candidates.push(p);
  }

  // 3. Signe dollar — fallback large
  const dollarRe = /\$\s*([\d,]{2,7}(?:\.\d{2})?)/g;
  while ((m = dollarRe.exec(html)) !== null) {
    const p = parseFloat(m[1].replace(/,/g, ""));
    if (p >= 50 && p <= 15000) candidates.push(p);
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a - b);
  // Retourne le prix le plus bas plausible (prix catalogue, pas les accessoires)
  // On prend la médiane basse pour éviter les prix d'accessoires parasites
  const filtered = candidates.filter((p) => p >= 99);
  return filtered.length > 0 ? filtered[0] : candidates[0];
}

async function fetchPrice(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return parseAudPrice(html);
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function getBestPrice(nom) {
  const q = encodeURIComponent(nom);
  const urls = [
    `https://www.apple.com/au/search/${q}?src=serp`,
    `https://www.jbhifi.com.au/search?query=${q}`,
    `https://www.harveynorman.com.au/search?q=${q}`,
  ];
  const results = await Promise.allSettled(urls.map(fetchPrice));
  const prices = results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
  if (prices.length === 0) return null;
  prices.sort((a, b) => a - b);
  return prices[0]; // prix le plus bas parmi les 3 sources
}

// ── Core sync logic ────────────────────────────────────────────────

async function runSync(resendApiKey) {
  const snapshot = await db.collection("technc_catalogue").get();
  const changes = [];
  const errors = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const nom = data.nom || "";
    if (!nom) continue;

    try {
      const prixAUD = await getBestPrice(nom);

      if (prixAUD !== null) {
        const ancienPrix = data.prixAUD || 0;
        const changed = Math.abs(prixAUD - ancienPrix) > 0.5;
        if (changed) {
          await docSnap.ref.update({
            prixAUD: prixAUD,
            gst: Math.round(prixAUD * 0.1 * 100) / 100,
            disponible: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        changes.push({
          nom,
          marque: data.marque || "",
          ancienPrix,
          nouveauPrix: prixAUD,
          status: changed ? "mis à jour" : "inchangé",
          disponible: true,
        });
      } else {
        await docSnap.ref.update({
          disponible: false,
          visible: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        changes.push({
          nom,
          marque: data.marque || "",
          ancienPrix: data.prixAUD || 0,
          nouveauPrix: null,
          status: "introuvable",
          disponible: false,
        });
      }
    } catch (e) {
      errors.push({ nom, error: e.message });
    }

    // Délai entre produits pour éviter le rate-limiting
    await new Promise((r) => setTimeout(r, 600));
  }

  const date = new Date().toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Pacific/Noumea",
  });

  if (resendApiKey) {
    try {
      await sendSummaryEmail(resendApiKey, date, changes, errors);
    } catch (e) {
      console.error("Email send error:", e.message);
    }
  }

  return {
    date,
    total: snapshot.size,
    updated: changes.filter((c) => c.status === "mis à jour").length,
    notFound: changes.filter((c) => c.status === "introuvable").length,
    unchanged: changes.filter((c) => c.status === "inchangé").length,
    errorCount: errors.length,
    changes,
    errors,
  };
}

// ── Email résumé via Resend ───────────────────────────────────────

async function sendSummaryEmail(apiKey, date, changes, errors) {
  const updated = changes.filter((c) => c.status === "mis à jour");
  const notFound = changes.filter((c) => c.status === "introuvable");

  const rows = changes
    .map((c) => {
      const statusColor =
        c.status === "mis à jour" ? "#1a9e5c" : c.status === "introuvable" ? "#c92b2b" : "#888";
      const statusLabel =
        c.status === "mis à jour" ? "✅ mis à jour" : c.status === "introuvable" ? "❌ introuvable" : "— inchangé";
      const delta =
        c.ancienPrix && c.nouveauPrix && c.status === "mis à jour"
          ? (c.nouveauPrix - c.ancienPrix > 0 ? "+" : "") +
            (c.nouveauPrix - c.ancienPrix).toFixed(0) + " AUD"
          : "";
      return `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:8px 12px;font-size:12px;">${c.marque} ${c.nom}</td>
        <td style="padding:8px 12px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:#888;">
          ${c.ancienPrix ? "A$" + c.ancienPrix.toLocaleString("en-AU") : "—"}
        </td>
        <td style="padding:8px 12px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">
          ${c.nouveauPrix ? "A$" + c.nouveauPrix.toLocaleString("en-AU") : "—"}
        </td>
        <td style="padding:8px 12px;text-align:right;font-size:11px;color:${delta.startsWith("+") ? "#c92b2b" : "#1a9e5c"};">
          ${delta}
        </td>
        <td style="padding:8px 12px;text-align:center;font-size:11px;color:${statusColor};">${statusLabel}</td>
      </tr>`;
    })
    .join("");

  const statsHtml = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="padding:14px;background:#f0faf5;border-radius:10px;text-align:center;width:33%;">
          <div style="font-size:28px;font-weight:700;color:#1a9e5c;">${updated.length}</div>
          <div style="font-size:11px;color:#888;margin-top:3px;">mis à jour</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:14px;background:#fff5f5;border-radius:10px;text-align:center;width:33%;">
          <div style="font-size:28px;font-weight:700;color:#c92b2b;">${notFound.length}</div>
          <div style="font-size:11px;color:#888;margin-top:3px;">introuvables</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:14px;background:#f5f5f7;border-radius:10px;text-align:center;width:33%;">
          <div style="font-size:28px;font-weight:700;color:#1d1d1f;">${changes.length}</div>
          <div style="font-size:11px;color:#888;margin-top:3px;">scannés</div>
        </td>
      </tr>
    </table>`;

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,Helvetica Neue,Arial,sans-serif;max-width:720px;margin:0 auto;padding:32px 24px;color:#1d1d1f;background:#fff;">
  <table style="width:100%;margin-bottom:24px;border-bottom:2px solid #0071e3;padding-bottom:16px;">
    <tr>
      <td>
        <span style="font-size:20px;font-weight:700;">Tech<span style="color:#0071e3;">NC</span></span>
        <span style="font-size:13px;color:#888;margin-left:10px;">Sync catalogue</span>
      </td>
      <td style="text-align:right;font-size:12px;color:#888;">${date}</td>
    </tr>
  </table>
  ${statsHtml}
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead>
      <tr style="background:#f5f5f7;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;">Produit</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;">Ancien</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;">Nouveau</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;">Δ</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;">Statut</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${
    errors.length > 0
      ? `<p style="color:#c92b2b;margin-top:16px;font-size:11px;"><strong>Erreurs (${errors.length}) :</strong> ${errors.map((e) => `${e.nom} — ${e.error}`).join(" · ")}</p>`
      : ""
  }
  <p style="font-size:10px;color:#ccc;margin-top:32px;border-top:1px solid #eee;padding-top:12px;">
    Généré automatiquement · TechNC Cloud Functions · chaque nuit 3h NC
  </p>
</body>
</html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Remplace par ton domaine vérifié dans Resend (ex: sync@technc.nc)
      // Pour tester sans domaine : utilise "onboarding@resend.dev" (envoi vers ton email seulement)
      from: "TechNC <onboarding@resend.dev>",
      to: ["niko.sirot@gmail.com"],
      subject: `TechNC — Sync catalogue ${date}`,
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend ${response.status}: ${body}`);
  }
}

// ── StaticICE scraper ─────────────────────────────────────────────

const KNOWN_MERCHANTS = [
  "JB Hi-Fi", "Harvey Norman", "Officeworks", "Apple Store",
  "Amazon", "Bing Lee", "Kogan", "BIG W", "Myer", "Centre Com",
  "Scorptec", "CPL Online", "PB Tech", "Mighty Ape",
];

// Structure HTML StaticICE :
// <tr valign="top">
//   <td><a alt="MERCHANT: Click to see..." href="/cgi-bin/redirect.cgi?...&newurl=ENCODED_URL">$1,999.00</a></td>
//   <td>[SKU] Product Name<br><font>...<a>Merchant</a>...</font></td>
// </tr>
function parseStaticIce(html) {
  const results = [];
  const SKIP_KEYWORDS = /\b(case|cover|protector|screen|tempered|glass|cable|charger|adapter|skin|film|pouch|sleeve|bag|strap|band|shell|hardshell|dux|studio shell|mount|stand|hub|dock|folio|wallet|bumper|grip|ring|holder|hook|clip|bracket)\b/i;

  const rowRe = /<tr valign="top">([\s\S]*?)<\/tr>/gi;
  let rowM;

  while ((rowM = rowRe.exec(html)) !== null && results.length < 10) {
    const row = rowM[1];

    // Price: text of first <a> that starts with $
    const priceM = row.match(/<a[^>]*>\s*\$([\d,]+(?:\.\d{2})?)\s*<\/a>/);
    if (!priceM) continue;
    const prix = parseFloat(priceM[1].replace(/,/g, ""));
    if (prix < 50 || prix > 15000) continue;

    // Merchant: from alt="MERCHANT: Click to see…"
    const altM = row.match(/alt="([^:]+):\s*Click to see/i);
    const revendeur = altM ? altM[1].trim() : "Autre";

    // Product name: text in second <td> before <br>, strip SKU brackets
    const tds = row.split(/<td[^>]*>/);
    const secondTd = tds[2] || "";
    const nomRaw = secondTd.match(/^([^<]+)/);
    const nom = nomRaw
      ? nomRaw[1].replace(/\[[^\]]+\]/g, "").replace(/&amp;/g, "&").trim()
      : "";

    // Skip accessories
    if (SKIP_KEYWORDS.test(nom)) continue;

    // Real destination URL from newurl= param
    const newurlM = row.match(/newurl=([^&">\s]+)/);
    const url = newurlM ? decodeURIComponent(newurlM[1]) : "";

    const isDup = results.some(
      (r) => Math.abs(r.prix - prix) < 1 && r.revendeur === revendeur
    );
    if (!isDup) results.push({ nom, prix, revendeur, url });
  }

  return results.sort((a, b) => a.prix - b.prix).slice(0, 5);
}

async function fuzzyUpdateCatalogue(nomRecherche, bestResult) {
  const normalize = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");
  const tokens = (s) => normalize(s).split(/\s+/).filter((t) => t.length > 2);

  const queryTokens = tokens(nomRecherche);
  if (queryTokens.length === 0) return null;

  const snapshot = await db.collection("technc_catalogue").get();
  let bestDoc = null;
  let bestScore = 0;

  for (const doc of snapshot.docs) {
    const docTokens = tokens(doc.data().nom || "");
    const matches = queryTokens.filter((t) =>
      docTokens.some((d) => d.includes(t) || t.includes(d))
    );
    const score = matches.length / queryTokens.length;
    if (score > bestScore) { bestScore = score; bestDoc = doc; }
  }

  if (bestDoc && bestScore >= 0.5) {
    await bestDoc.ref.update({
      prixAUD: bestResult.prix,
      gst: Math.round(bestResult.prix * 0.1 * 100) / 100,
      fournisseur: bestResult.revendeur,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { docId: bestDoc.id, nom: bestDoc.data().nom, score: Math.round(bestScore * 100) };
  }
  return null;
}

// ── Cloud Functions exports ────────────────────────────────────────

// Cron HTTP : appelé par cron-job.org chaque nuit à 16h UTC (= 3h NC)
// URL à configurer dans cron-job.org :
//   https://us-central1-technc-ec348.cloudfunctions.net/syncPrix?secret=VOTRE_CRON_SECRET
exports.syncPrix = functions.https.onRequest(
  {
    timeoutSeconds: 540,
    memory: "256MiB",
    secrets: [RESEND_API_KEY, CRON_SECRET],
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).send("");
      return;
    }
    // Vérification clé secrète pour éviter les appels non autorisés
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    try {
      const result = await runSync(RESEND_API_KEY.value());
      console.log(
        "Sync cron terminé :",
        JSON.stringify({ updated: result.updated, notFound: result.notFound, errors: result.errorCount })
      );
      res.status(200).json({ ok: true, ...result });
    } catch (e) {
      console.error("syncCataloguePrix error:", e);
      res.status(500).json({ error: e.message });
    }
  }
);

// HTTP : scrape StaticICE.com.au et met à jour Firestore si match
exports.scrapeAUPrix = functions.https.onRequest(
  { timeoutSeconds: 30, memory: "256MiB", cors: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }

    const nom = (req.query.nom || "").trim();
    if (!nom) return res.status(400).json({ error: "Paramètre 'nom' manquant" });

    const q = encodeURIComponent(nom);
    const url =
      `https://www.staticice.com.au/cgi-bin/search.cgi` +
      `?q=${q}&stype=1&etype=&ptype=&min=50&max=15000&cid=&sorder=p&ltype=1&rcnt=10`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "en-AU,en;q=0.9",
          Referer: "https://www.staticice.com.au/",
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        return res.status(502).json({ error: `StaticICE HTTP ${response.status}` });
      }

      const html = await response.text();
      const results = parseStaticIce(html);

      let updated = null;
      if (results.length > 0) {
        updated = await fuzzyUpdateCatalogue(nom, results[0]);
      }

      res.status(200).json({ results, updated });
    } catch (e) {
      if (e.name === "AbortError") {
        return res.status(504).json({ error: "Timeout — StaticICE n'a pas répondu" });
      }
      res.status(500).json({ error: e.message });
    }
  }
);

// HTTP : déclenchement manuel depuis l'admin (sans vérification de secret)
exports.syncCataloguePrixManuel = functions.https.onRequest(
  {
    timeoutSeconds: 540,
    memory: "256MiB",
    secrets: [RESEND_API_KEY],
    cors: true,
  },
  async (req, res) => {
    // Preflight CORS
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, GET");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).send("");
      return;
    }
    try {
      const result = await runSync(RESEND_API_KEY.value());
      res.status(200).json(result);
    } catch (e) {
      console.error("syncCataloguePrixManuel error:", e);
      res.status(500).json({ error: e.message });
    }
  }
);
