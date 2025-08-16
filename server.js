import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ---------------- In-memory data (swap to DB later) ----------------
const businesses = {};   // id -> { name, industry, timezone }
const bookings = [];     // { id, businessId, clientName, contact, service, when, staffId, notes, status }
const leads = [];        // { id, businessId, name, contact, service, budget, source, notes }
const staff = [];        // { id, businessId, name, nationalId, pin, role }
const attendance = [];   // { id, businessId, staffId, type: "in"|"out", timestamp }
const overtime = [];     // { id, businessId, staffId, hours, reason, status }
const faqs = {};         // businessId -> [{ q, a }]

// ---------------- Helpers ----------------
const nowIso = () => new Date().toISOString();

const requireBusinessId = (req, res, next) => {
  const bid = req.headers["x-business-id"];
  if (!bid || !businesses[bid]) {
    return res.status(401).json({ error: "Missing or invalid X-Business-Id" });
  }
  req.businessId = bid;
  next();
};

const requireStaffAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Missing Authorization header" });
  try {
    const token = auth.replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { staffId, businessId, role, iat, exp }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ---------------- Health ----------------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Alice Starter API", time: nowIso() });
});

// ---------------- Business ----------------
app.post("/business/create", (req, res) => {
  const { name, industry, timezone } = req.body || {};
  if (!name || !industry) return res.status(400).json({ error: "name and industry required" });
  const id = uuid();
  businesses[id] = { name, industry, timezone: timezone || "Africa/Johannesburg" };
  // seed a couple FAQs for convenience
  faqs[id] = faqs[id] || [
    { q: "What are your hours?", a: "Mon–Sat 09:00–18:00" },
    { q: "Do you accept walk-ins?", a: "Yes, subject to availability." }
  ];
  res.json({ businessId: id, business: businesses[id] });
});

// ---------------- Staff ----------------
app.post("/staff/create", requireBusinessId, (req, res) => {
  const { name, nationalId, pin, role } = req.body || {};
  if (!name || !nationalId || !pin) return res.status(400).json({ error: "name, nationalId, pin required" });
  const id = uuid();
  staff.push({ id, businessId: req.businessId, name, nationalId, pin, role: role || "staff" });
  res.json({ id });
});

app.post("/staff/login", requireBusinessId, (req, res) => {
  const { name, nationalId, pin } = req.body || {};
  const person = staff.find(
    s => s.businessId === req.businessId && s.name === name && s.nationalId === nationalId && s.pin === pin
  );
  if (!person) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ staffId: person.id, businessId: req.businessId, role: person.role }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, staff: { id: person.id, name: person.name, role: person.role } });
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
  if (typeof hours !== "number" || hours <= 0) return res.status(400).json({ error: "hours must be a positive number" });
  const entry = { id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, hours, reason: reason || "", status: "pending" };
  overtime.push(entry);
  res.json(entry);
});

// ---------------- Bookings ----------------
app.get("/bookings", requireBusinessId, (req, res) => {
  const list = bookings.filter(b => b.businessId === req.businessId);
  res.json(list);
});
app.post("/bookings", requireBusinessId, (req, res) => {
  const { clientName, contact, service, when, staffId, notes } = req.body || {};
  if (!clientName || !contact || !service || !when) return res.status(400).json({ error: "clientName, contact, service, when required" });
  const entry = {
    id: uuid(),
    businessId: req.businessId,
    clientName,
    contact,
    service,
    when,
    staffId: staffId || null,
    notes: notes || "",
    status: "confirmed"
  };
  bookings.push(entry);
  res.json(entry);
});

// ---------------- Leads ----------------
app.post("/leads", requireBusinessId, (req, res) => {
  const { name, contact, service, budget, source, notes } = req.body || {};
  if (!name || !contact || !service) return res.status(400).json({ error: "name, contact, service required" });
  const entry = { id: uuid(), businessId: req.businessId, name, contact, service, budget: budget || "", source: source || "", notes: notes || "" };
  leads.push(entry);
  res.json(entry);
});

// ---------------- FAQs ----------------
app.get("/faqs", requireBusinessId, (req, res) => {
  res.json(faqs[req.businessId] || []);
});
app.post("/faqs", requireBusinessId, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
  faqs[req.businessId] = items;
  res.json({ ok: true });
});

// ---------------- Insights (mocked logic for MVP) ----------------
app.post("/insights/weekly", requireBusinessId, (req, res) => {
  const biz = businesses[req.businessId];
  const industry = biz?.industry || "general";
  const plan = {
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
    bestTimes: { Instagram: ["18:00"], TikTok: ["11:00"], Facebook: ["12:30"] },
    paydayWindows: ["15th", "25th–30th"],
    forecastNote: "Assumes +8–15% uplift around payday; adjust with your past weeks’ data."
  };
  res.json(plan);
});

app.post("/insights/forecast", requireBusinessId, (req, res) => {
  const { baselineWeeklyRevenue = 10000, marketingSpend = 1500 } = req.body || {};
  const paydayBoost = 0.12;
  const trendBoost = 0.05;
  const projected = Math.round(baselineWeeklyRevenue * (1 + paydayBoost + trendBoost));
  const estimatedROI = Number((((projected - baselineWeeklyRevenue) - marketingSpend) / Math.max(marketingSpend, 1)).toFixed(2));
  res.json({
    baselineWeeklyRevenue,
    projectedWeeklyRevenue: projected,
    assumedLifts: { paydayBoost, trendBoost },
    marketingSpend,
    estimatedROI
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Alice API listening on :${PORT}`));
