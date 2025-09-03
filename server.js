// ===== Alice EntrepreBot Server (CommonJS, zero Business-ID required) =====
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const nodemailer = require("nodemailer");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ---------------- In-memory data ----------------
const businesses = {};   // id -> { name, industry, timezone }
const bizIndex = {};     // key -> businessId  (key = normalized "name|industry" or contact)
const bookings = [];
const leads = [];
const staff = [];
const attendance = [];
const overtime = [];
const faqs = {};
const subscriptions = {};     // businessId -> { packageId, status, currentPeriodEnd }
const usageCounts = {};       // businessId -> number (free basic calls)
const pendingApprovals = {};  // token -> { businessId|null, packageId, amount, provisionalRef, businessName, industry, contact, requestedAt }

// ===== Packages =====
const PACKAGES = {
  basic: {
    id: "basic",
    name: "R150 – Basic (Self-Service Alice EntrepreBot Assistant)",
    price: 150,
    benefits: [
      "Weekly industry insights & trending hooks",
      "What to post, when to post, which platform",
      "Payday awareness (15th, 25th–30th)",
      "Simple revenue forecasts",
      "Core ops: Bookings, Leads, FAQs, Staff login, Agenda, Clock-in/out"
    ]
  },
  pro: {
    id: "pro",
    name: "R250 – Pro (Alice Assistant + Virtual Consultations)",
    price: 250,
    benefits: [
      "Everything in Basic",
      "2× Virtual Consultations per month",
      "Automatic reminders to staff/clients",
      "Priority CEO/staff scheduling"
    ]
  },
  elite: {
    id: "elite",
    name: "R500 – Elite (Tailor-Made Business Consulting by Alice)",
    price: 500,
    benefits: [
      "Everything in Pro",
      "Tailored strategy & ROI planning",
      "More consultations (4–6/month)",
      "Premium analytics & KPI dashboards",
      "Referral & reward automation"
    ]
  }
};

// ===== Email transport =====
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_KEY   = process.env.ADMIN_KEY || "change-me";
const BASE_URL    = process.env.PUBLIC_BASE_URL || "http://localhost:8080";

// ===== Helpers =====
const nowIso = () => new Date().toISOString();
const norm = (s="") => String(s).trim().toLowerCase();

// Create or find a business automatically (no headers)
function ensureBusiness({ businessName, industry, contact }) {
  const name = businessName || "Auto Business";
  const ind  = industry || "general";
  const key1 = `${norm(name)}|${norm(ind)}`;
  const key2 = contact ? `c:${norm(contact)}` : null;

  let bid = bizIndex[key1] || (key2 ? bizIndex[key2] : null);
  if (bid && businesses[bid]) return bid;

  bid = uuid();
  businesses[bid] = { name, industry: ind, timezone: "Africa/Johannesburg" };
  faqs[bid] = faqs[bid] || [
    { q: "What are your hours?", a: "Mon–Sat 09:00–18:00" },
    { q: "Do you accept walk-ins?", a: "Yes, subject to availability." }
  ];
  bizIndex[key1] = bid;
  if (key2) bizIndex[key2] = bid;
  return bid;
}

function hasActiveSub(bid, packageId) {
  const s = subscriptions[bid];
  const now = Math.floor(Date.now()/1000);
  return !!(s && s.status === "active" && s.packageId === packageId && (!s.currentPeriodEnd || s.currentPeriodEnd > now));
}

// Gate: Basic gets 40 free calls; Pro/Elite paid
function gateByPackage(packageId = "basic") {
  return (req, res, next) => {
    const { businessName, industry, contact } = req.body || {};
    const bid = ensureBusiness({ businessName, industry, contact });

    if (hasActiveSub(bid, packageId)) {
      req.businessId = bid;
      return next();
    }

    if (packageId === "basic") {
      usageCounts[bid] = (usageCounts[bid] || 0) + 1;
      if (usageCounts[bid] <= 40) {
        req.businessId = bid;
        return next();
      }
    }

    return res.status(402).json({
      error: "Subscription required",
      message: "Choose a package to continue: R150 / R250 / R500",
      packages: Object.values(PACKAGES).map(p => ({
        id: p.id, name: p.name, price: p.price, benefits: p.benefits
      }))
    });
  };
}

// Staff JWT (kept for completeness; not needed by GPT)
function requireStaffAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Missing Authorization header" });
  try {
    const token = auth.replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function sendEmail(to, subject, html) {
  try { await mailer.sendMail({ from: process.env.SMTP_USER, to, subject, html }); }
  catch (e) { console.error("Email error:", e.message); }
}

// ================= Health =================
app.get("/", (_req, res) => res.json({ ok: true, service: "Alice API", time: nowIso() }));
app.get("/healthz", (_req, res) => res.json({ ok: true, time: nowIso() }));

// ================= Business (optional; still usable) =================
app.post("/business/create", (req, res) => {
  const { name, industry, timezone } = req.body || {};
  if (!name || !industry) return res.status(400).json({ error: "name and industry required" });
  const id = ensureBusiness({ businessName: name, industry, contact: null });
  businesses[id].timezone = timezone || "Africa/Johannesburg";
  res.json({ businessId: id, business: businesses[id] });
});

// ================= Staff (optional JWT features) =================
app.post("/staff/create", (req, res) => {
  const { businessName, industry, contact, name, nationalId, pin, role } = req.body || {};
  if (!name || !nationalId || !pin) return res.status(400).json({ error: "name, nationalId, pin required" });
  const bid = ensureBusiness({ businessName, industry, contact });
  const id = uuid();
  staff.push({ id, businessId: bid, name, nationalId, pin, role: role || "staff" });
  res.json({ id, businessId: bid });
});

app.post("/staff/login", (req, res) => {
  const { businessName, industry, contact, name, nationalId, pin } = req.body || {};
  const bid = ensureBusiness({ businessName, industry, contact });
  const person = staff.find(
    s => s.businessId === bid && s.name === name && s.nationalId === nationalId && s.pin === pin
  );
  if (!person) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ staffId: person.id, businessId: bid, role: person.role }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, staff: { id: person.id, name: person.name, role: person.role }, businessId: bid });
});

app.get("/staff/agenda", requireStaffAuth, (req, res) => {
  const items = bookings.filter(b => b.businessId === req.user.businessId && b.staffId === req.user.staffId && b.status !== "cancelled");
  res.json({ bookings: items });
});
app.post("/staff/clock-in", requireStaffAuth, (req, res) => {
  attendance.push({ id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, type: "in", timestamp: nowIso() });
  res.json({ ok: true });
});
app.post("/staff/clock-out", requireStaffAuth, (req, res) => {
  attendance.push({ id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, type: "out", timestamp: nowIso() });
  res.json({ ok: true });
});
app.post("/staff/overtime", requireStaffAuth, (req, res) => {
  const { hours, reason } = req.body || {};
  if (typeof hours !== "number" || hours <= 0) return res.status(400).json({ error: "hours must be positive" });
  const entry = { id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, hours, reason: reason || "", status: "pending" };
  overtime.push(entry);
  res.json(entry);
});

// ================= Bookings (no Business-ID; auto) =================
app.get("/bookings", (req, res) => {
  const { businessName, industry, contact } = req.query || {};
  const bid = ensureBusiness({ businessName, industry, contact });
  const list = bookings.filter(b => b.businessId === bid);
  res.json({ businessId: bid, bookings: list });
});
app.post("/bookings", (req, res) => {
  const { businessName, industry, contact, clientName, clientContact, service, when, staffId, notes } = req.body || {};
  if (!clientName || !(contact || clientContact) || !service || !when) {
    return res.status(400).json({ error: "clientName, contact/clientContact, service, when required" });
  }
  const bid = ensureBusiness({ businessName, industry, contact: contact || clientContact });
  const entry = {
    id: uuid(),
    businessId: bid,
    clientName,
    contact: contact || clientContact,
    service,
    when,
    staffId: staffId || null,
    notes: notes || "",
    status: "confirmed"
  };
  bookings.push(entry);
  res.json({ businessId: bid, booking: entry });
});

// ================= Leads =================
app.post("/leads", (req, res) => {
  const { businessName, industry, contact, name, service, budget, source, notes } = req.body || {};
  const clientContact = req.body.clientContact || contact;
  if (!name || !clientContact || !service) return res.status(400).json({ error: "name, contact, service required" });
  const bid = ensureBusiness({ businessName, industry, contact: clientContact });
  const entry = { id: uuid(), businessId: bid, name, contact: clientContact, service, budget: budget || "", source: source || "", notes: notes || "" };
  leads.push(entry);
  res.json({ businessId: bid, lead: entry });
});

// ================= FAQs =================
app.get("/faqs", (req, res) => {
  const { businessName, industry, contact } = req.query || {};
  const bid = ensureBusiness({ businessName, industry, contact });
  res.json({ businessId: bid, items: faqs[bid] || [] });
});
app.post("/faqs", (req, res) => {
  const { businessName, industry, contact, items } = req.body || {};
  const bid = ensureBusiness({ businessName, industry, contact });
  if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
  faqs[bid] = items;
  res.json({ businessId: bid, ok: true });
});

// ================= Insights (mock logic; auto business) =================
app.post("/insights/weekly", gateByPackage("basic"), (req, res) => {
  const bid = req.businessId || ensureBusiness(req.body || {});
  const biz = businesses[bid] || {};
  const industry = biz.industry || "general";
  res.json({
    businessId: bid,
    weekOf: nowIso().slice(0, 10),
    industry,
    trends: [
      "Payday promos boost conversions (15th, 25th–30th)",
      "Short-form video (15–30s) outperforms",
      "UGC/testimonials increase trust"
    ],
    suggestedPosts: [
      { platform: "Instagram", day: "Thu", time: "18:00", caption: `Payday glow-up ✨ Book now & save 10%. #PaydaySpecial #${industry}` },
      { platform: "TikTok", day: "Sat", time: "11:00", caption: `Behind the scenes + quick tips 🎥 #${industry}Tips` },
      { platform: "Facebook", day: "Tue", time: "12:30", caption: "Client story + referral rewards 💬 #HappyClients" }
    ],
    bestTimes: { Instagram: ["18:00"], TikTok: ["11:00"], Facebook: ["12:30"] }
  });
});

app.post("/insights/forecast", gateByPackage("basic"), (req, res) => {
  const bid = req.businessId || ensureBusiness(req.body || {});
  const { baselineWeeklyRevenue = 10000, marketingSpend = 1500 } = req.body || {};
  const paydayBoost = 0.12, trendBoost = 0.05;
  const projected = Math.round(baselineWeeklyRevenue * (1 + paydayBoost + trendBoost));
  const estimatedROI = Number((((projected - baselineWeeklyRevenue) - marketingSpend) / Math.max(marketingSpend, 1)).toFixed(2));
  res.json({
    businessId: bid,
    baselineWeeklyRevenue,
    projectedWeeklyRevenue: projected,
    assumedLifts: { paydayBoost, trendBoost },
    marketingSpend,
    estimatedROI
  });
});

// ================= Pro / Elite demo gates =================
app.post("/consultations", gateByPackage("pro"), (req, res) => {
  const bid = req.businessId || ensureBusiness(req.body || {});
  res.json({ businessId: bid, ok: true, note: "Consultation booked (demo)" });
});
app.post("/upgrade/premium", gateByPackage("elite"), (req, res) => {
  const bid = req.businessId || ensureBusiness(req.body || {});
  res.json({ businessId: bid, ok: true, note: "Premium upgrade active (demo)" });
});

// ================= Billing: Packages & EFT (no business needed) =================
app.get("/billing/packages", (_req, res) => {
  res.json(Object.values(PACKAGES).map(p => ({
    id: p.id, name: p.name, price: p.price, benefits: p.benefits
  })));
});

// Start EFT — no business required
app.post("/billing/eft/start", (req, res) => {
  const { packageId = "basic", businessName = "New Business", industry = "general", contact = "" } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;
  const provisionalRef = "P-" + uuid().slice(0, 6).toUpperCase();

  const message = `💳 EFT Payment Instructions
Service: ${pack.name}
Total: R${pack.price}

Bank: FNB
Account Name: Alice N
Account Type: Cheque
Account Number: 63092455097
Reference: ${provisionalRef}

After payment, reply: DONE`;

  res.json({ ok: true, packageId: pack.id, amount: pack.price, message, provisionalRef, businessName, industry, contact });
});

// DONE — email admin; business created on approval if missing
app.post("/billing/eft/done", (req, res) => {
  const { packageId = "basic", provisionalRef = "", businessName = "New Business", industry = "general", contact = "" } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;
  const token = uuid().slice(0, 6).toUpperCase();

  pendingApprovals[token] = {
    businessId: null, packageId: pack.id, amount: pack.price, requestedAt: Date.now(),
    provisionalRef: provisionalRef || ("P-" + uuid().slice(0,6).toUpperCase()),
    businessName, industry, contact
  };

  const approveLink = `${BASE_URL}/admin/approve?token=${token}&days=30&key=${encodeURIComponent(ADMIN_KEY)}`;
  const denyLink    = `${BASE_URL}/admin/deny?token=${token}&key=${encodeURIComponent(ADMIN_KEY)}`;

  const html = `
    <h3>EFT Claim</h3>
    <p><b>Ref:</b> ${pendingApprovals[token].provisionalRef}</p>
    <p><b>Package:</b> ${pack.name} (R${pack.price})</p>
    <p><b>Business Name:</b> ${businessName}</p>
    <p><b>Industry:</b> ${industry}</p>
    <p><b>Contact:</b> ${contact}</p>
    <p><a href="${approveLink}">✅ Approve 30 days</a> | <a href="${denyLink}">❌ Deny</a></p>
  `;
  sendEmail(ADMIN_EMAIL, `[Alice EFT] ${pack.name} — Ref ${pendingApprovals[token].provisionalRef}`, html);

  res.json({ ok: true, message: "Claim sent to admin. You’ll be unlocked after verification.", token });
});

app.get("/admin/approve", (req, res) => {
  const { token, days = "30", key } = req.query || {};
  if (key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  const pending = pendingApprovals[token];
  if (!pending) return res.status(400).send("Invalid token");

  // Create business on approval
  const bid = ensureBusiness({ businessName: pending.businessName, industry: pending.industry, contact: pending.contact });

  const expiresAt = Date.now() + Number(days) * 24 * 3600 * 1000;
  subscriptions[bid] = {
    status: "active",
    packageId: pending.packageId,
    currentPeriodEnd: Math.floor(expiresAt / 1000)
  };

  const approvedHtml = `
    <h3>Approved</h3>
    <p><b>BusinessId:</b> ${bid}</p>
    <p><b>Package:</b> ${pending.packageId}</p>
    <p><b>Expires:</b> ${new Date(expiresAt).toISOString()}</p>
    <p><b>Ref:</b> ${pending.provisionalRef}</p>
    <p><b>Name/Industry:</b> ${pending.businessName} / ${pending.industry}</p>
  `;
  delete pendingApprovals[token];
  res.setHeader("Content-Type", "text/html");
  res.send(approvedHtml);
});

app.get("/admin/deny", (req, res) => {
  const { token, key } = req.query || {};
  if (key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  delete pendingApprovals[token];
  res.send("<h3>Denied</h3>");
});

// ================= Start =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Alice API listening on :${PORT}`));
