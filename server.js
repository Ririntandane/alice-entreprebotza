// ===== Alice EntrepreBot Server (CommonJS) =====
// Zero Business-ID required: businesses are auto-created/matched by name + industry + contact.

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

// ---------------- In-memory state ----------------
const businesses = {};   // id -> { name, industry, timezone }
const bizIndex = {};     // normalized key -> businessId (key: "name|industry" and/or "c:<contact>")
const bookings = [];     // { id, businessId, clientName, contact, service, when, staffId, notes, status }
const leads = [];        // { id, businessId, name, contact, service, budget, source, notes }
const staff = [];        // { id, businessId, name, nationalId, pin, role }
const attendance = [];   // { id, businessId, staffId, type, timestamp }
const overtime = [];     // { id, businessId, staffId, hours, reason, status }
const faqs = {};         // businessId -> [{ q, a }]

// Subscriptions & approvals
const subscriptions = {};     // businessId -> { packageId, status, currentPeriodEnd }
const usageCounts = {};       // businessId -> number (free basic calls)
const pendingApprovals = {};  // token -> { businessId|null, packageId, amount, provisionalRef, businessName, industry, contact, requestedAt }

// ---------------- Packages (includes R500/R1000/R4000/R7000) ----------------
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
    name: "R500 – Elite (Exclusive consulting access, 30-day window)",
    price: 500,
    benefits: [
      "Everything in Pro",
      "Elite concierge access",
      "30–31 day strategy window per cycle",
      "Creation cap: up to 6 assets (images/mockups/PDF/docs) per 30 days",
      "Tailored insights, competitor checks, ROI planning"
    ]
  },
  elite_plus: {
    id: "elite_plus",
    name: "R1000 – Elite+ Monthly (expanded creation cap)",
    price: 1000,
    benefits: [
      "Everything in Elite",
      "30–31 day strategy & campaign planning per cycle",
      "Creation cap: up to 15 assets per 30 days",
      "Priority turnarounds & extended reviews"
    ]
  },
  elite_6mo: {
    id: "elite_6mo",
    name: "R4000 – Elite (6 Months, upfront)",
    price: 4000,
    benefits: [
      "6-month engagement, upfront payment",
      "Half-year roadmaps & projects (plan for the year, deliver 6 months)",
      "All creation needs unlocked (fair-use), priority support",
      "Mid-cycle reviews & adjustments"
    ]
  },
  elite_12mo: {
    id: "elite_12mo",
    name: "R7000 – Elite (12 Months, upfront)",
    price: 7000,
    benefits: [
      "12-month engagement, upfront payment",
      "Annual plan, quarterly reviews, all creation unlocked (fair-use)",
      "Full campaign orchestration & premium analytics",
      "Highest priority, annual retrospective & replan"
    ]
  }
};

// ---------------- Email transport (Gmail App Password) ----------------
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_KEY   = process.env.ADMIN_KEY || "change-me";
const BASE_URL    = process.env.PUBLIC_BASE_URL || "http://localhost:8080";

async function sendEmail(to, subject, html) {
  try {
    const info = await mailer.sendMail({ from: process.env.SMTP_USER, to, subject, html });
    console.log("Email sent:", info.messageId);
  } catch (e) {
    console.error("Email error:", e && e.response ? e.response : e);
  }
}

// ---------------- Helpers ----------------
const nowIso = () => new Date().toISOString();
const norm = (s="") => String(s).trim().toLowerCase();

// Auto-create or match a business (by name + industry + contact)
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
  const now = Math.floor(Date.now() / 1000);
  return !!(s && s.status === "active" && s.packageId === packageId && (!s.currentPeriodEnd || s.currentPeriodEnd > now));
}

// Gate: Basic gets 40 free calls; everything else requires active sub
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
      message: "Choose a package to continue: R150 / R250 / R500 / R1000 / R4000 / R7000",
      packages: Object.values(PACKAGES).map(p => ({
        id: p.id, name: p.name, price: p.price, benefits: p.benefits
      }))
    });
  };
}

// Staff JWT (optional)
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

// ---------------- Health ----------------
app.get("/", (_req, res) => res.json({ ok: true, service: "Alice API", time: nowIso() }));
app.get("/healthz", (_req, res) => res.json({ ok: true, time: nowIso() }));

// ---------------- Onboarding (WELCOME) ----------------
// Use this first to collect details & create/match a business immediately.
app.post("/onboard/welcome", (req, res) => {
  const { businessName, industry, contact } = req.body || {};
  if (!businessName || !industry) {
    return res.status(400).json({ error: "businessName and industry required" });
  }
  const bid = ensureBusiness({ businessName, industry, contact });
  const msg = `Welcome to Alice ✨ — I’ve registered **${businessName}** (${industry})${contact ? " with contact " + contact : ""}. We’re ready to proceed.`;
  res.json({ ok: true, businessId: bid, business: businesses[bid], message: msg });
});

// Resolve or create business and return ID (useful for greeting/personal touch)
app.post("/business/resolve", (req, res) => {
  const { businessName, industry, contact } = req.body || {};
  const bid = ensureBusiness({ businessName, industry, contact });
  res.json({ businessId: bid, business: businesses[bid] });
});

// Optional explicit create
app.post("/business/create", (req, res) => {
  const { name, industry, timezone } = req.body || {};
  if (!name || !industry) return res.status(400).json({ error: "name and industry required" });
  const id = ensureBusiness({ businessName: name, industry, contact: null });
  businesses[id].timezone = timezone || "Africa/Johannesburg";
  res.json({ businessId: id, business: businesses[id] });
});

// ---------------- Staff (optional JWT features) ----------------
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
  const person = staff.find(s => s.businessId === bid && s.name === name && s.nationalId === nationalId && s.pin === pin);
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

// ---------------- Bookings (auto business) ----------------
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

// ---------------- Leads ----------------
app.post("/leads", (req, res) => {
  const { businessName, industry, contact, name, service, budget, source, notes } = req.body || {};
  const clientContact = req.body.clientContact || contact;
  if (!name || !clientContact || !service) return res.status(400).json({ error: "name, contact, service required" });
  const bid = ensureBusiness({ businessName, industry, contact: clientContact });
  const entry = { id: uuid(), businessId: bid, name, contact: clientContact, service, budget: budget || "", source: source || "", notes: notes || "" };
  leads.push(entry);
  res.json({ businessId: bid, lead: entry });
});

// ---------------- FAQs ----------------
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

// ---------------- Insights (auto business; Basic gated to 40 free) ----------------
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

// ---------------- Billing ----------------
app.get("/billing/packages", (_req, res) => {
  res.json(Object.values(PACKAGES).map(p => ({
    id: p.id, name: p.name, price: p.price, benefits: p.benefits
  })));
});

// Start EFT — uses provided businessName/industry/contact for a sticky identity
app.post("/billing/eft/start", (req, res) => {
  const { packageId = "basic", businessName = "New Business", industry = "general", contact = "" } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;
  // stickiness: ensure business now (so it exists through the flow)
  const bid = ensureBusiness({ businessName, industry, contact });

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

  res.json({
    ok: true,
    businessId: bid,
    packageId: pack.id,
    amount: pack.price,
    message,
    provisionalRef,
    businessName, industry, contact
  });
});

// DONE — email admin; client gets confirmation after admin approval
app.post("/billing/eft/done", async (req, res) => {
  const { packageId = "basic", provisionalRef = "", businessName = "New Business", industry = "general", contact = "" } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;
  const token = uuid().slice(0, 6).toUpperCase();

  pendingApprovals[token] = {
    businessId: null,
    packageId: pack.id,
    amount: pack.price,
    requestedAt: Date.now(),
    provisionalRef: provisionalRef || ("P-" + uuid().slice(0,6).toUpperCase()),
    businessName, industry, contact
  };

  const days =
    packageId === "elite_6mo" ? 180 :
    packageId === "elite_12mo" ? 365 :
    30;

  const approveLink = `${BASE_URL}/admin/approve?token=${token}&days=${days}&key=${encodeURIComponent(ADMIN_KEY)}`;
  const denyLink    = `${BASE_URL}/admin/deny?token=${token}&key=${encodeURIComponent(ADMIN_KEY)}`;

  const html = `
    <h3>EFT Claim</h3>
    <p><b>Ref:</b> ${pendingApprovals[token].provisionalRef}</p>
    <p><b>Package:</b> ${pack.name} (R${pack.price})</p>
    <p><b>Business Name:</b> ${businessName}</p>
    <p><b>Industry:</b> ${industry}</p>
    <p><b>Contact:</b> ${contact}</p>
    <p><a href="${approveLink}">✅ Approve</a> | <a href="${denyLink}">❌ Deny</a></p>
  `;
  await sendEmail(ADMIN_EMAIL, `[Alice EFT] ${pack.name} — Ref ${pendingApprovals[token].provisionalRef}`, html);

  res.json({ ok: true, message: "Claim sent to admin. You’ll be unlocked after verification.", token });
});

// Approve — activates sub, sends client confirmation (with Business ID)
app.get("/admin/approve", async (req, res) => {
  const { token, days = "30", key } = req.query || {};
  if (key !== process.env.ADMIN_KEY) return res.status(401).send("Unauthorized");
  const pending = pendingApprovals[token];
  if (!pending) return res.status(400).send("Invalid token");

  // Create/match business for a sticky identity
  const bid = ensureBusiness({
    businessName: pending.businessName,
    industry: pending.industry,
    contact: pending.contact
  });

  const expiresAt = Date.now() + Number(days) * 24 * 3600 * 1000;
  subscriptions[bid] = {
    status: "active",
    packageId: pending.packageId,
    currentPeriodEnd: Math.floor(expiresAt / 1000)
  };

  const adminHtml = `
    <h3>Approved</h3>
    <p><b>BusinessId:</b> ${bid}</p>
    <p><b>Package:</b> ${pending.packageId}</p>
    <p><b>Expires:</b> ${new Date(expiresAt).toISOString()}</p>
    <p><b>Ref:</b> ${pending.provisionalRef}</p>
    <p><b>Name/Industry:</b> ${pending.businessName} / ${pending.industry}</p>
  `;
  const clientHtml = `
    <h3>Your Alice EntrepreBot subscription is active ✅</h3>
    <p><b>Business:</b> ${pending.businessName} (${pending.industry || "general"})</p>
    <p><b>Business ID:</b> ${bid}</p>
    <p><b>Package:</b> ${PACKAGES[pending.packageId]?.name || pending.packageId}</p>
    <p><b>Active until:</b> ${new Date(expiresAt).toLocaleString()}</p>
    <p>You can now ask Alice for insights, bookings, and more using your business details.</p>
  `;

  // Notify admin and (if email provided) the client
  await sendEmail(ADMIN_EMAIL, `Approved: ${pending.businessName} (${pending.packageId})`, adminHtml);
  if (pending.contact && /@/.test(pending.contact)) {
    await sendEmail(pending.contact, "Welcome to Alice EntrepreBot — Access Activated", clientHtml);
  }

  delete pendingApprovals[token];
  res.setHeader("Content-Type", "text/html");
  res.send(adminHtml);
});

// Deny
app.get("/admin/deny", (req, res) => {
  const { token, key } = req.query || {};
  if (key !== process.env.ADMIN_KEY) return res.status(401).send("Unauthorized");
  delete pendingApprovals[token];
  res.send("<h3>Denied</h3>");
});

// ---------------- Subscription status (handy for GPT to check) ----------------
app.post("/billing/status", (req, res) => {
  const { businessName, industry, contact } = req.body || {};
  const bid = ensureBusiness({ businessName, industry, contact });
  const s = subscriptions[bid] || null;
  const active = !!(s && s.status === "active" && (!s.currentPeriodEnd || s.currentPeriodEnd > Math.floor(Date.now()/1000)));
  res.json({
    businessId: bid,
    active,
    packageId: s?.packageId || null,
    currentPeriodEnd: s?.currentPeriodEnd || null
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Alice API listening on :${PORT}`));
