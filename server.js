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
const DELIVERY_COL = "delivery";   // delivery_id, user_id_sender, user_id_receiver, ...

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

app.post("/users/addresses/list", async (req, res) => {
  try {
    const { user_id } = req.body ?? {};
    if (user_id == null) return res.status(400).json({ error: "user_id is required" });

    const uid = Number(user_id);

    // ไม่มี orderBy -> ไม่ต้องใช้ composite index
    const snap = await db.collection(ADDR_COL)
      .where("user_id", "==", uid)
      .get();

    // เรียงในหน่วยความจำตาม address_id (asc)
    const items = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (Number(a.address_id || 0) - Number(b.address_id || 0)));

    return res.json({ count: items.length, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/users/by-phone", async (req, res) => {
  try {
    const { phone } = req.body ?? {};
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const snap = await db.collection(USER_COL)
      .where("phone", "==", String(phone))
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: "not found" });

    const d = snap.docs[0];
    return res.json({ id: d.id, ...d.data() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


//delete address
app.post("/users/addresses/delete", async (req, res) => {
  try {
    const { user_id, address_id } = req.body ?? {};

    if (user_id == null || address_id == null) {
      return res.status(400).json({ error: "user_id and address_id are required" });
    }

    const uid = Number(user_id);
    const aid = Number(address_id);

    // ตรวจว่า address นั้นมีอยู่จริง
    const docRef = db.collection(ADDR_COL).doc(String(aid));
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: "address not found" });
    }

    const data = docSnap.data();
    if (Number(data.user_id) !== uid) {
      return res.status(403).json({ error: "not authorized to delete this address" });
    }

    // ลบ document
    await docRef.delete();

    return res.json({ ok: true, message: `address_id ${aid} deleted successfully` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

//create delivery
/* ----------------------- 1. ค้นหาเบอร์ผู้รับ -----------------------
POST /delivery/search-receiver
body: { phone: "0822054489" }
------------------------------------------------------------------ */
app.post("/delivery/search-receiver", async (req, res) => {
  try {
    const { phone } = req.body ?? {};
    if (!phone) return res.status(400).json({ error: "phone is required" });

    // หา user จากเบอร์
    const userSnap = await db.collection(USER_COL)
      .where("phone", "==", String(phone))
      .limit(1)
      .get();

    if (userSnap.empty) {
      return res.status(404).json({ error: "receiver not found" });
    }

    const userDoc = userSnap.docs[0];
    const user = userDoc.data();

    // หา address ของ user_id นี้
    const addrSnap = await db.collection(ADDR_COL)
      .where("user_id", "==", Number(user.user_id))
      .get();

    const addresses = addrSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    return res.json({
      receiver: {
        user_id: user.user_id,
        name: user.name,
        phone: user.phone,
        addresses,
      },
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


/* ----------------------- 2. ฟังก์ชันสร้าง delivery ----------------------- */
async function createDelivery({
  user_id_sender,
  user_id_receiver,
  phone_receiver,
  address_id_sender,
  address_id_receiver,
  picture_status1,
  detail_product,
  amount,
  status
}) {
  if (!user_id_sender || !user_id_receiver || !address_id_sender || !address_id_receiver) {
    const e = new Error("user_id_sender, user_id_receiver, address_id_sender, address_id_receiver are required");
    e.code = 400; throw e;
  }

  // ตรวจสอบ sender / receiver
  const senderDoc = await db.collection(USER_COL).doc(String(user_id_sender)).get();
  if (!senderDoc.exists) {
    const e = new Error("sender not found");
    e.code = 404; throw e;
  }

  const receiverDoc = await db.collection(USER_COL).doc(String(user_id_receiver)).get();
  if (!receiverDoc.exists) {
    const e = new Error("receiver not found");
    e.code = 404; throw e;
  }

  // ตรวจ address sender/receiver
  const addrSender = await db.collection(ADDR_COL).doc(String(address_id_sender)).get();
  const addrReceiver = await db.collection(ADDR_COL).doc(String(address_id_receiver)).get();
  if (!addrSender.exists || !addrReceiver.exists) {
    const e = new Error("address sender or receiver not found");
    e.code = 404; throw e;
  }

  // Auto-increment id
  const deliveryIdNum = await nextId("delivery_seq");
  const docId = String(deliveryIdNum);

  const payload = {
    delivery_id: deliveryIdNum,
    user_id_sender: Number(user_id_sender),
    user_id_receiver: Number(user_id_receiver),
    phone_receiver: phone_receiver ? String(phone_receiver) : null,
    address_id_sender: Number(address_id_sender),
    address_id_receiver: Number(address_id_receiver),
    picture_status1: picture_status1 || null,
    detail_product: detail_product ? String(detail_product) : "",
    amount: Number(amount || 1),
    status: status ? String(status) : "waiting",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection(DELIVERY_COL).doc(docId).set(payload);
  return { id: docId, ...payload };
}


/* ----------------------- 3. Create Delivery -----------------------
POST /delivery/create
body: {
  user_id_sender: 1,
  user_id_receiver: 2,
  phone_receiver: "0998765432",
  address_id_sender: 1,
  address_id_receiver: 5,
  detail_product: "กล่องของขวัญ",
  amount: 1,
  status: "waiting"
}
------------------------------------------------------------------ */
app.post("/delivery/create", async (req, res) => {
  try {
    const data = req.body ?? {};
    const delivery = await createDelivery(data);
    return res.status(201).json({ ok: true, delivery });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message });
  }
});


/* ----------------------- 4. List Delivery ของผู้ใช้ -----------------------
POST /delivery/list-by-user
body: { user_id: 1 }
------------------------------------------------------------------ */
app.post("/delivery/list-by-user", async (req, res) => {
  try {
    const { user_id } = req.body ?? {};
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const snap = await db.collection(DELIVERY_COL)
      .where("user_id_sender", "==", Number(user_id))
      .get();

    const deliveries = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(a.delivery_id || 0) - Number(b.delivery_id || 0));

    return res.json({ count: deliveries.length, deliveries });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


/* ----------------------- 5. Get Delivery Detail -----------------------
GET /delivery/detail/:id
------------------------------------------------------------------ */
app.get("/delivery/detail/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "delivery_id required" });

    const doc = await db.collection(DELIVERY_COL).doc(String(id)).get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });

    return res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


/* ----------------------- 6. Update Delivery Status -----------------------
POST /delivery/update-status
body: { delivery_id: 1, status: "accepted" }
------------------------------------------------------------------ */
app.post("/delivery/update-status", async (req, res) => {
  try {
    const { delivery_id, status } = req.body ?? {};
    if (!delivery_id || !status)
      return res.status(400).json({ error: "delivery_id and status are required" });

    const docRef = db.collection(DELIVERY_COL).doc(String(delivery_id));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "delivery not found" });

    await docRef.update({
      status: String(status),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, message: "status updated" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


/* ----------------------- 7. Delete Delivery -----------------------
POST /delivery/delete
body: { delivery_id: 1 }
------------------------------------------------------------------ */
app.post("/delivery/delete", async (req, res) => {
  try {
    const { delivery_id } = req.body ?? {};
    if (!delivery_id) return res.status(400).json({ error: "delivery_id required" });

    const docRef = db.collection(DELIVERY_COL).doc(String(delivery_id));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "delivery not found" });

    await docRef.delete();
    return res.json({ ok: true, message: `delivery_id ${delivery_id} deleted successfully` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
//* ------------------------------- Start server ------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
