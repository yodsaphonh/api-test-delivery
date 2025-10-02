// server.js
import express from "express";
import cors from "cors";
import admin from "firebase-admin";

/* -------------------- Firebase Admin init (ใช้ ENV จาก Render) --------------------
   ใน Render → Service → Environment ใส่:
   - FIREBASE_PROJECT_ID
   - FIREBASE_CLIENT_EMAIL
   - FIREBASE_PRIVATE_KEY   (แปะทั้งบล็อก โดยแทนขึ้นบรรทัดเป็น \n)
   - (optional) FIREBASE_DATABASE_URL
----------------------------------------------------------------------------------- */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  });
}
const db = admin.firestore();

/* ---------------------------------- Express ---------------------------------- */
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

/* -------------------------------- Collections -------------------------------- */
const USER_COL  = "user";          // role: 0=user, 1=rider
const ADDR_COL  = "user_address";  // address_id, user_id, address, lat, lng
const RIDER_COL = "rider_car";     // rider_id, user_id, image_car, plate_number, car_type
const COUNTERS  = "_counters";     // seq storage

/* --------------------------------- Healthcheck -------------------------------- */
app.get("/", (_, res) => res.send("API on Render 🚀"));
app.get("/users/:id", async (req, res) => {
  try {
    const doc = await db.collection(USER_COL).doc(String(req.params.id)).get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/users", async (req, res) => {
  try {
    const snap = await db.collection(USER_COL).get();
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ count: users.length, users });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


/* ---------------------- Auto-increment Counter (transaction) ---------------------- */
async function nextId(sequence) {
  const ref = db.collection(COUNTERS).doc(sequence);
  const val = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().value || 0) : 0;
    const next = current + 1;
    if (!snap.exists) tx.set(ref, { value: next });
    else tx.update(ref, { value: next });
    return next;
  });
  return val; // number
}

/* ----------------------------------- Helpers ----------------------------------- */
async function assertPhoneNotDuplicate(phone) {
  const snap = await db.collection(USER_COL)
    .where("phone", "==", String(phone))
    .limit(1)
    .get();
  if (!snap.empty) {
    const d = snap.docs[0];
    const err = new Error("phone already exists");
    err.code = 409;
    err.payload = { id: d.id, ...d.data() };
    throw err;
  }
}

function normalizeRoleInt(role) {
  const r = Number(role ?? 0);
  if (r !== 0 && r !== 1) {
    const e = new Error("role must be 0 or 1");
    e.code = 400;
    throw e;
  }
  return r;
}

/* --------------------------------- Creators --------------------------------- */
async function createUser({ name, password, phone, picture, role }) {
  if (!name || !password || !phone) {
    const e = new Error("name, password, phone are required");
    e.code = 400; throw e;
  }
  const roleInt = normalizeRoleInt(role);
  await assertPhoneNotDuplicate(phone);

  const idNum = await nextId("user_seq");     // 1,2,3,...
  const id = String(idNum);

  const data = {
    user_id: idNum,
    name: String(name),
    password: String(password),               // DEMO: โปรดใช้ bcrypt ในโปรดักชัน
    phone: String(phone),
    picture: picture ? String(picture) : null,
    role: roleInt,                            // int: 0/1
  };

  await db.collection(USER_COL).doc(id).set(data);
  return { id, ...data };
}

async function createRiderCar({ user_id, image_car, plate_number, car_type }) {
  if (!user_id || !plate_number || !car_type) {
    const e = new Error("user_id, plate_number, car_type are required");
    e.code = 400; throw e;
  }
  const riderIdNum = await nextId("rider_seq");
  const riderId = String(riderIdNum);

  const payload = {
    rider_id: riderIdNum,
    user_id: isNaN(Number(user_id)) ? String(user_id) : Number(user_id),
    image_car: image_car ? String(image_car) : null,
    plate_number: String(plate_number),
    car_type: String(car_type),
  };

  await db.collection(RIDER_COL).doc(riderId).set(payload);
  return { id: riderId, ...payload };
}

/* ------------------------------ Address creator ------------------------------ */
/*  - Auto-increment address_id จาก _counters/address_seq (global)
    - ตรวจ user มีจริง + เก็บ createdAt/updatedAt                           */
async function createAddress({ user_id, address, lat, lng }) {
  if (!user_id || !address) {
    const e = new Error("user_id and address are required");
    e.code = 400; throw e;
  }

  // ตรวจว่ามี user จริง
  const uid = Number(user_id);
  const userDoc = await db.collection(USER_COL).doc(String(uid)).get();
  if (!userDoc.exists) {
    const e = new Error("user not found");
    e.code = 404; throw e;
  }

  // Auto-increment address_id จาก _counters/address_seq
  const addressIdNum = await nextId("address_seq"); // 1,2,3,...
  const docId = String(addressIdNum);

  const payload = {
    address_id: addressIdNum,     // number
    user_id: uid,                 // number
    address: String(address),
    lat: lat == null ? null : Number(lat),
    lng: lng == null ? null : Number(lng),
  };

  await db.collection(ADDR_COL).doc(docId).set(payload);
  return { id: docId, ...payload };
}

/* ---------------------------------- Routes ---------------------------------- */
/** สมัครผู้ใช้ทั่วไป (เฉพาะ user) — ไม่สร้าง user_address ในเส้นนี้ */
app.post("/register/user", async (req, res) => {
  try {
    const { name, phone, password, picture } = req.body ?? {};
    const user = await createUser({ name, phone, password, picture, role: 0 });
    return res.status(201).json({ user });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

/** สมัครไรเดอร์ (user role=1 + rider_car) — ไม่มี address */
app.post("/register/rider", async (req, res) => {
  try {
    const { name, phone, password, picture, image_car, plate_number, car_type } = req.body ?? {};
    const user = await createUser({ name, phone, password, picture, role: 1 });
    const rider_car = await createRiderCar({ user_id: user.id, image_car, plate_number, car_type });
    return res.status(201).json({ user, rider_car });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body ?? {};
    if (!phone || !password)
      return res.status(400).json({ error: "phone and password are required" });

    const snap = await db.collection(USER_COL)
      .where("phone","==",String(phone))
      .limit(1)
      .get();

    if (snap.empty) return res.status(401).json({ error: "invalid credentials" });
    const d = snap.docs[0];
    const u = d.data();
    if (String(u.password) !== String(password))
      return res.status(401).json({ error: "invalid credentials" });

    res.json({ id: d.id, name: u.name, phone: u.phone, role: Number(u.role) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =============================== Addresses (BODY ONLY) =============================== */
/** CREATE — เพิ่มที่อยู่ให้ผู้ใช้
 *  POST /users/addresses
 *  body: { user_id:number, address:string, lat?:number, lng?:number }
 */
app.post("/users/addresses", async (req, res) => {
  try {
    const { user_id, address, lat, lng } = req.body ?? {};
    const doc = await createAddress({ user_id, address, lat, lng });
    return res.status(201).json(doc);
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message });
  }
});

/** LIST — ที่อยู่ทั้งหมดของ user (แบ่งหน้า)
 *  POST /users/addresses/list
 *  body: { user_id:number, limit?:number<=100, startAfter?:number(address_id) }
 */
app.post("/users/addresses/list", async (req, res) => {
  try {
    const { user_id, limit, startAfter } = req.body ?? {};
    if (user_id == null) return res.status(400).json({ error: "user_id is required" });

    const uid = Number(user_id);
    const take = Math.min(Number(limit || 50), 100);

    let q = db.collection(ADDR_COL)
      .where("user_id", "==", uid)
      .orderBy("address_id", "asc")
      .limit(take);

    if (startAfter != null) q = q.startAfter(Number(startAfter));

    const snap = await q.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const last = items.length ? items[items.length - 1].address_id : null;

    return res.json({ count: items.length, lastAddressId: last, items });
  } catch (e) {
    // ถ้าขึ้น "requires an index" ให้สร้าง composite index: WHERE user_id == + ORDER BY address_id ASC
    return res.status(400).json({ error: e.message });
  }
});

/** GET ONE — ดูที่อยู่ทีละรายการ
 *  POST /addresses/get
 *  body: { address_doc_id?:string, address_id?:number }  (อย่างใดอย่างหนึ่ง)
 */
app.post("/addresses/get", async (req, res) => {
  try {
    const { address_doc_id, address_id } = req.body ?? {};
    if (!address_doc_id && address_id == null) {
      return res.status(400).json({ error: "address_doc_id or address_id is required" });
    }

    if (address_doc_id) {
      const ref = db.collection(ADDR_COL).doc(String(address_doc_id));
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "not found" });
      return res.json({ id: doc.id, ...doc.data() });
    }

    const snap = await db.collection(ADDR_COL)
      .where("address_id", "==", Number(address_id))
      .limit(1).get();

    if (snap.empty) return res.status(404).json({ error: "not found" });
    const d = snap.docs[0];
    return res.json({ id: d.id, ...d.data() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** PATCH — แก้ไขบางฟิลด์ของที่อยู่ (อัปเดต updatedAt อัตโนมัติ)
 *  POST /addresses/patch
 *  body: { address_doc_id:string, address?:string, lat?:number, lng?:number }
 */
app.post("/addresses/patch", async (req, res) => {
  try {
    const { address_doc_id, address, lat, lng } = req.body ?? {};
    if (!address_doc_id) return res.status(400).json({ error: "address_doc_id is required" });

    const ref = db.collection(ADDR_COL).doc(String(address_doc_id));
    const before = await ref.get();
    if (!before.exists) return res.status(404).json({ error: "not found" });

    const patch = {};
    if (address !== undefined) patch.address = String(address);
    if (lat !== undefined)     patch.lat = (lat == null ? null : Number(lat));
    if (lng !== undefined)     patch.lng = (lng == null ? null : Number(lng));
    patch.updatedAt = new Date();

    if (Object.keys(patch).length === 1) { // มีแต่ updatedAt อย่างเดียว
      return res.status(400).json({ error: "nothing to update" });
    }

    await ref.update(patch);
    const after = await ref.get();
    return res.json({ id: after.id, ...after.data() });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/** DELETE — ลบที่อยู่
 *  POST /addresses/delete
 *  body: { address_doc_id:string }
 */
app.post("/addresses/delete", async (req, res) => {
  try {
    const { address_doc_id } = req.body ?? {};
    if (!address_doc_id) return res.status(400).json({ error: "address_doc_id is required" });

    const ref = db.collection(ADDR_COL).doc(String(address_doc_id));
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });

    await ref.delete();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


//upload and update Profile IMG
app.put("/users/photo/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const { photoUrl } = req.body;
    if (!photoUrl) return res.status(400).json({ error: "photoUrl is required" });

    await admin.firestore().collection("users").doc(uid).set(
      { photoUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
/* ------------------------------- Start server ------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
