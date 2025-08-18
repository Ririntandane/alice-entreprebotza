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
const tasks = [];        // { id, businessId, staffId, title, category, due, status }

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
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, time: nowIso() });
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

