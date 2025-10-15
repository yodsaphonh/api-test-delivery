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
const USER_COL  = "user";
const ADDR_COL  = "user_address";
const RIDER_COL = "rider_car";
const COUNTERS  = "_counters";
const DELIVERY_COL = "delivery";
const RIDER_LOC_COL = "rider_location";
const ASSIGN_COL = "delivery_assignment";
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
 */
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

/* ----------------------- Get Address By ID -----------------------
GET /users/address/1
------------------------------------------------------------------ */
app.get("/users/address/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "address_id is required" });

    const doc = await db.collection(ADDR_COL).doc(String(id)).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "address not found" });
    }

    return res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


app.post("/users/addresses/list", async (req, res) => {
  try {
    const { user_id } = req.body ?? {};
    if (user_id == null) return res.status(400).json({ error: "user_id is required" });

    const uid = Number(user_id);

    const snap = await db.collection(ADDR_COL)
      .where("user_id", "==", uid)
      .get();

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
  name_product,
  detail_product,
  picture_product,
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

    name_product: name_product ? String(name_product) : "",
    picture_product: picture_product || null,
    

    detail_product: detail_product ? String(detail_product) : "",
    amount: Number(amount || 1),
    status: status ? String(status) : "waiting",
  };

  await db.collection(DELIVERY_COL).doc(docId).set(payload);
  return { id: docId, ...payload };
}

/* ----------------------- 3. Create Delivery -----------------------
POST /delivery/create
body: {
  "user_id_sender": 1,
  "user_id_receiver": 2,
  "phone_receiver": "0998765432",
  "address_id_sender": 1,
  "address_id_receiver": 5,
  "name_product": "Iphone 10",
  "detail_product": "สีดำ 128GB",
  "picture_product": "https://res.cloudinary.com/.../iphone10.jpg",
  "amount": 1,
  "status": "waiting"
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
body: { user_id_sender: 1 }
------------------------------------------------------------------ */
app.post("/delivery/list-by-user", async (req, res) => {
  try {
    const { user_id_sender } = req.body ?? {};
    if (!user_id_sender) {
      return res.status(400).json({ error: "user_id_sender is required" });
    }

    const snap = await db
      .collection(DELIVERY_COL)
      .where("user_id_sender", "==", Number(user_id_sender))
      .get();

    const deliveries = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(a.delivery_id || 0) - Number(b.delivery_id || 0));

    return res.json({ count: deliveries.length, deliveries });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

//==========================================================================================================
app.get("/deliveries/waiting", async (req, res) => {
  try {
    const snapshot = await db.collection("delivery").where("status", "==", "waiting").get();
    const deliveries = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(deliveries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/delivery/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const deliveryDoc = await db.collection(DELIVERY_COL).doc(String(id)).get();
    if (!deliveryDoc.exists) {
      return res.status(404).json({ error: "delivery not found" });
    }

    const delivery = { id: deliveryDoc.id, ...deliveryDoc.data() };

    let addressSender = null;
    if (delivery.address_id_sender) {
      const addrSenderDoc = await db
        .collection(ADDR_COL)
        .doc(String(delivery.address_id_sender))
        .get();
      if (addrSenderDoc.exists) addressSender = addrSenderDoc.data();
    }

    let addressReceiver = null;
    if (delivery.address_id_receiver) {
      const addrReceiverDoc = await db
        .collection(ADDR_COL)
        .doc(String(delivery.address_id_receiver))
        .get();
      if (addrReceiverDoc.exists) addressReceiver = addrReceiverDoc.data();
    }

    const result = {
      ...delivery,
      address_sender: addressSender,
      address_receiver: addressReceiver,
    };

    res.json(result);
  } catch (e) {
    console.error("Error in /delivery/:id:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ========================= เส้นรับงาน + บันทึกพิกัดแรก =========================
   POST /deliveries/accept
   body: { delivery_id:number, rider_id:number, rider_lat:number, rider_lng:number }
=============================================================================== */
app.post("/deliveries/accept", async (req, res) => {
  try {
    const { delivery_id, rider_id, rider_lat, rider_lng } = req.body ?? {};
    if (!delivery_id || !rider_id)
      return res.status(400).json({ error: "delivery_id, rider_id are required" });

    // แนะนำให้อย่างน้อยส่ง lat/lng มาเก็บครั้งแรกด้วย
    if (rider_lat == null || rider_lng == null)
      return res.status(400).json({ error: "rider_lat, rider_lng are required on accept" });

    const deliveryRef = db.collection(DELIVERY_COL).doc(String(delivery_id));
    const riderLocRef = db.collection(RIDER_LOC_COL).doc(String(rider_id));
    const assiIdNum = await nextId("assi_seq");
    const assiId = String(assiIdNum);

    await db.runTransaction(async (tx) => {
      // ตรวจ delivery ต้องอยู่สถานะ waiting เท่านั้น
      const dSnap = await tx.get(deliveryRef);
      if (!dSnap.exists) throw new Error("delivery not found");
      const d = dSnap.data();
      if (d.status !== "waiting") throw new Error("Delivery already accepted or in progress");

      // สร้าง assignment = accept
      tx.set(db.collection(ASSIGN_COL).doc(assiId), {
        assi_id: assiIdNum,
        delivery_id: Number(delivery_id),
        rider_id: Number(rider_id),
        status: "accept",
        picture_status2: null,
        picture_status3: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // อัปเดต delivery -> accept
      tx.update(deliveryRef, {
        status: "accept",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // สร้าง/อัปเดตตำแหน่งแรกของ Rider (ใช้ rider_id เป็น docId)
      tx.set(
        riderLocRef,
        {
          rider_location_id: String(rider_id),
          user_id: String(rider_id),
          lat: Number(rider_lat),
          lng: Number(rider_lng),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return res.json({
      ok: true,
      message: "Delivery accepted and rider_location saved",
      assignment: {
        assi_id: assiIdNum,
        delivery_id: Number(delivery_id),
        rider_id: Number(rider_id),
        status: "accept",
      },
      rider_location: {
        rider_location_id: String(rider_id),
        lat: Number(rider_lat),
        lng: Number(rider_lng),
      },
    });
  } catch (e) {
    const msg = e.message || "internal error";
    const code = /not found|required|progress/i.test(msg) ? 400 : 500;
    return res.status(code).json({ error: msg });
  }
});


/* =================== อัปเดตเป็น transporting + อัปเดตพิกัด ====================
   POST /deliveries/update-status-accept
   body: { delivery_id:number, rider_id:number, picture_status2:string, rider_lat:number, rider_lng:number }
=============================================================================== */
app.post("/deliveries/update-status-accept", async (req, res) => {
  try {
    const { delivery_id, rider_id, picture_status2, rider_lat, rider_lng } = req.body ?? {};
    if (!delivery_id || !rider_id || !picture_status2)
      return res.status(400).json({ error: "delivery_id, rider_id, picture_status2 are required" });
    if (rider_lat == null || rider_lng == null)
      return res.status(400).json({ error: "rider_lat, rider_lng are required" });

    const deliveryRef = db.collection(DELIVERY_COL).doc(String(delivery_id));
    const riderLocRef  = db.collection(RIDER_LOC_COL).doc(String(rider_id));

    // เก็บไว้ใช้ตอบหลังทรานแซกชัน
    let deliveryData = null;
    let finalPic2 = null;
    let assi_id = null;
    let aDocRef = null;

    await db.runTransaction(async (tx) => {
      // ----- READS (ทั้งหมดต้องมาก่อน WRITES) -----
      const dSnap = await tx.get(deliveryRef);
      if (!dSnap.exists) throw new Error("delivery not found");
      deliveryData = dSnap.data();

      const q = db.collection(ASSIGN_COL)
        .where("delivery_id", "==", Number(delivery_id))
        .where("rider_id", "==", Number(rider_id))
        .limit(1);

      const aSnap = await tx.get(q);
      if (aSnap.empty) throw new Error("assignment not found for this delivery/rider");

      const aDoc = aSnap.docs[0];
      const a = aDoc.data();

      if (a.status !== "accept") {
        throw new Error("Assignment must be in 'accept' to set transporting");
      }

      assi_id = a.assi_id;
      aDocRef = aDoc.ref;
      finalPic2 = picture_status2 || a.picture_status2 || null;

      // ----- WRITES (หลังจากอ่านครบแล้ว) -----
      tx.update(aDoc.ref, {
        status: "transporting",
        picture_status2: finalPic2,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.update(deliveryRef, {
        status: "transporting",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(
        riderLocRef,
        {
          rider_location_id: String(rider_id),
          user_id: String(rider_id),
          lat: Number(rider_lat),
          lng: Number(rider_lng),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    // (ถ้าจำเป็น) อ่าน assignment ล่าสุดนอกทรานแซกชัน
    // const assignmentLatest = aDocRef ? (await aDocRef.get()).data() : null;

    return res.json({
      ok: true,
      message: "Assignment moved to transporting and rider location updated",
      delivery_id: Number(delivery_id),
      assi_id,
      rider_id: Number(rider_id),

      proof_images: {
        picture_status2: finalPic2,  // ใช้ค่าที่คำนวณแล้วระหว่างทรานแซกชัน
        picture_status3: null
      },

      product: {
        name_product: deliveryData?.name_product ?? null,
        detail_product: deliveryData?.detail_product ?? null,
        picture_product: deliveryData?.picture_product ?? null,
        amount: deliveryData?.amount ?? null,
        phone_receiver: deliveryData?.phone_receiver ?? null,
      },

      meta: {
        status_delivery: "transporting",
        user_id_sender: deliveryData?.user_id_sender ?? null,
        user_id_receiver: deliveryData?.user_id_receiver ?? null,
        address_id_sender: deliveryData?.address_id_sender ?? null,
        address_id_receiver: deliveryData?.address_id_receiver ?? null,
      },

      rider_location: {
        rider_location_id: String(rider_id),
        lat: Number(rider_lat),
        lng: Number(rider_lng),
      },
    });
  } catch (e) {
    const msg = e.message || "internal error";
    const code = /not found|accept|required/i.test(msg) ? 400 : 500;
    return res.status(code).json({ error: msg });
  }
});





// POST /rider/location/update
// body: { rider_id, lat, lng, rider_location_id? }
app.post("/rider/location/update", async (req, res) => {
  try {
    const { rider_id, lat, lng, rider_location_id } = req.body ?? {};
    if (!rider_id || lat == null || lng == null)
      return res.status(400).json({ error: "rider_id, lat, lng are required" });

    const docId = String(rider_id);                  // ใช้ rider_id เป็น docId
    const locId = String(rider_location_id ?? rider_id); // ค่าเก็บในฟิลด์

    const docRef = db.collection(RIDER_LOC_COL).doc(docId);
    const snap = await docRef.get();

    const payload = {
      rider_location_id: snap.exists && snap.data()?.rider_location_id
        ? snap.data().rider_location_id   // คงค่าเดิมถ้ามี
        : locId,                          // ตั้งครั้งแรก = rider_id หรือค่าที่ส่งมา
      user_id: docId,                     // rider_id == user_id
      lat: Number(lat),
      lng: Number(lng),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set(payload, { merge: true });
    return res.json({ ok: true, updated: true, rider_location_id: payload.rider_location_id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /riders/overview/:riderId
// -> { rider_lat, rider_lng, receiver_lat, receiver_lng, delivery_id }
app.get("/riders/overview/:riderId", async (req, res) => {
  try {
    const riderIdStr = String(req.params.riderId);
    const riderIdNum = Number(riderIdStr);

    // 1) ตำแหน่งล่าสุดของไรเดอร์
    const locSnap = await db.collection(RIDER_LOC_COL).doc(riderIdStr).get();
    if (!locSnap.exists) {
      return res.status(404).json({ error: "rider location not found" });
    }
    const loc = locSnap.data();
    const rider_lat = loc.lat == null ? null : Number(loc.lat);
    const rider_lng = loc.lng == null ? null : Number(loc.lng);

    // 2) หา assignment ล่าสุดของไรเดอร์ (เลี่ยง orderBy เพื่อไม่ต้องใช้ index)
    const aSnap = await db.collection(ASSIGN_COL)
      .where("rider_id", "==", riderIdNum)
      .get();

    // กรองให้เหลือเฉพาะสถานะที่ยังทำงานอยู่ แล้วเลือกอัน "ใหม่สุด" ตาม assi_id
    let latest = null;
    aSnap.forEach(d => {
      const a = d.data();
      if (["accept", "transporting"].includes(String(a.status))) {
        if (!latest || Number(a.assi_id || 0) > Number(latest.assi_id || 0)) {
          latest = a;
        }
      }
    });

    if (!latest) {
      // ไม่มีงานค้าง ส่งพิกัดไรเดอร์ แต่ delivery/receiver เป็น null
      return res.json({
        rider_lat, rider_lng,
        receiver_lat: null, receiver_lng: null,
        delivery_id: null,
        updatedAt: loc.updatedAt || null,
      });
    }

    // 3) อ่าน delivery เพื่อเอา address_id_receiver
    const deliveryId = Number(latest.delivery_id);
    const dSnap = await db.collection(DELIVERY_COL).doc(String(deliveryId)).get();
    if (!dSnap.exists) {
      return res.json({
        rider_lat, rider_lng,
        receiver_lat: null, receiver_lng: null,
        delivery_id: deliveryId,
        updatedAt: loc.updatedAt || null,
      });
    }

    const d = dSnap.data();
    const addrRecvId = d.address_id_receiver != null ? String(d.address_id_receiver) : null;

    // 4) อ่านพิกัดผู้รับจาก user_address
    let receiver_lat = null, receiver_lng = null;
    if (addrRecvId) {
      const addrSnap = await db.collection(ADDR_COL).doc(addrRecvId).get();
      if (addrSnap.exists) {
        const a = addrSnap.data();
        receiver_lat = a.lat == null ? null : Number(a.lat);
        receiver_lng = a.lng == null ? null : Number(a.lng);
      }
    }

    return res.json({
      rider_lat, rider_lng,
      receiver_lat, receiver_lng,
      delivery_id: deliveryId,
      updatedAt: loc.updatedAt || null,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


// POST /deliveries/update-status-finish
// body: { delivery_id, picture_status3?, rider_id? }
app.post("/deliveries/update-status-finish", async (req, res) => {
  try {
    const { delivery_id, picture_status3, rider_id } = req.body ?? {};
    const status = "finish";
    if (!delivery_id) return res.status(400).json({ error: "delivery_id is required" });

    // หา assignment ของ delivery นี้ (เอาอันที่กำลังขนส่งอยู่)
    const assignSnap = await db.collection(ASSIGN_COL)
      .where("delivery_id", "==", Number(delivery_id))
      .get();

    if (assignSnap.empty) {
      return res.status(404).json({ error: "assignment for this delivery not found" });
    }

    const aDoc = assignSnap.docs.find(d => d.data()?.status === "transporting");
    if (!aDoc) return res.status(400).json({ error: "No assignment in 'transporting' for this delivery" });

    const a = aDoc.data();

    // ตรวจสิทธิ์ rider (ถ้าส่งมา)
    if (rider_id != null && Number(rider_id) !== Number(a.rider_id)) {
      return res.status(403).json({ error: "rider_id does not match assignment" });
    }

    // มี delivery จริงไหม
    const deliveryRef = db.collection(DELIVERY_COL).doc(String(a.delivery_id));
    const deliveryDoc = await deliveryRef.get();
    if (!deliveryDoc.exists) return res.status(404).json({ error: "delivery not found" });
    const d = deliveryDoc.data();

    // อัปเดต assignment -> finish และแนบรูปปลายทาง (status3)
    const assignUpdates = {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(picture_status3 ? { picture_status3 } : {}),
    };
    await aDoc.ref.update(assignUpdates);

    // sync delivery.status -> finish
    await deliveryRef.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // อ่าน assignment ล่าสุดหลังอัปเดต เพื่อคืนค่ารูปครบ
    const aLatest = (await aDoc.ref.get()).data() || {};

    return res.json({
      ok: true,
      message: `Status updated to ${status}`,
      delivery_id: a.delivery_id,
      assi_id: a.assi_id,
      rider_id: a.rider_id,

      // รูปพิสูจน์
      proof_images: {
        picture_status2: aLatest.picture_status2 ?? null,   // ตอนรับของ/ขึ้นรถ
        picture_status3: aLatest.picture_status3 ?? null,   // ตอนส่งสำเร็จ
      },

      // รายละเอียดสินค้าที่ส่ง (มาจากคอลเลกชัน delivery)
      product: {
        name_product: d?.name_product ?? null,
        detail_product: d?.detail_product ?? null,
        picture_product: d?.picture_product ?? null,
        amount: d?.amount ?? null,
        phone_receiver: d?.phone_receiver ?? null,
      },

      // ข้อมูลเสริมเผื่อใช้งานหน้าบ้าน
      meta: {
        status_delivery: status,
        user_id_sender: d?.user_id_sender ?? null,
        user_id_receiver: d?.user_id_receiver ?? null,
        address_id_sender: d?.address_id_sender ?? null,
        address_id_receiver: d?.address_id_receiver ?? null,
        delivery_updatedAt: d?.updatedAt ?? null,
        assignment_updatedAt: aLatest?.updatedAt ?? null,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});



// GET /users/:userId/rider-car  -> หา rider_car ด้วย user_id
app.get("/users/:userId/rider-car", async (req, res) => {
  try {
    const userId = Number(req.params.userId);

    const snap = await db.collection("rider_car")
      .where("user_id", "==", userId)
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: "rider_car not found" });

    const d = snap.docs[0];
    return res.json({ id: d.id, ...d.data() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /delivery-assignments/by-delivery/:delivery_id
// ตัวอย่าง: /delivery-assignments/by-delivery/1        -> ส่งรายการทั้งหมดของ delivery_id = 1
app.get("/delivery-assignments/by-delivery/:delivery_id", async (req, res) => {
  try {
    const deliveryId = Number(req.params.delivery_id);
    const latestOnly = String(req.query.latest || "") === "1";

    if (!Number.isFinite(deliveryId)) {
      return res.status(400).json({ error: "delivery_id ต้องเป็นตัวเลข" });
    }

    // ดึงเอกสารที่มี delivery_id ตรงกัน (ไม่ใส่ orderBy เพื่อเลี่ยง requirement index)
    const snap = await db
      .collection("delivery_assignment")
      .where("delivery_id", "==", deliveryId)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "ไม่พบข้อมูล assignment ของ delivery นี้" });
    }

    // แปลง Timestamp -> ISO string และจัดเรียงใหม่ในโค้ด (updatedAt > createdAt)
    const toISO = (ts) =>
      ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;

    const items = snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          createdAt: toISO(data.createdAt),
          updatedAt: toISO(data.updatedAt),
        };
      })
      .sort((a, b) => {
        const bu = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        const au = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        if (bu !== au) return bu - au;
        const bc = b.createdAt ? Date.parse(b.createdAt) : 0;
        const ac = a.createdAt ? Date.parse(a.createdAt) : 0;
        return bc - ac;
      });

    if (latestOnly) {
      return res.json(items[0]);
    }
    return res.json({ count: items.length, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


app.get("/riders/history/:user_id?", async (req, res) => {
  try {
    // รองรับทั้ง path param และ query param
    const user_id_raw = req.params.user_id ?? req.query.user_id;
    if (!user_id_raw) return res.status(400).json({ error: "user_id is required" });

    const user_id = String(user_id_raw);
    const riderIdNum = Number(user_id);
    if (Number.isNaN(riderIdNum)) return res.status(400).json({ error: "user_id must be a number" });

    // 1) ตรวจ user + role
    const uSnap = await db.collection(USER_COL).doc(user_id).get();
    if (!uSnap.exists) return res.status(404).json({ error: "user not found" });

    const role = (uSnap.data() || {}).role; // 0=user, 1=rider
    if (role !== 1) return res.json({ role, count: 0, items: [] });

    // 2) query assignment ของ rider ที่ finish
    let aSnap;
    try {
      aSnap = await db
        .collection(ASSIGN_COL)
        .where("rider_id", "==", riderIdNum)
        .where("status", "==", "finish")
        .orderBy("updatedAt", "desc")
        .limit(200)
        .get();
    } catch (err) {
      // ถ้ายังไม่ได้สร้าง composite index สำหรับ (rider_id, status, updatedAt)
      aSnap = await db
        .collection(ASSIGN_COL)
        .where("rider_id", "==", riderIdNum)
        .where("status", "==", "finish")
        .limit(200)
        .get();
    }

    if (aSnap.empty) return res.json({ role, count: 0, items: [] });

    // 3) รวม delivery_id แล้ว batch get
    const deliveryIds = Array.from(new Set(
      aSnap.docs.map(d => (d.data() || {}).delivery_id).filter(v => v != null).map(String)
    ));

    const deliveryMap = new Map();
    if (deliveryIds.length) {
      const refs = deliveryIds.map(id => db.collection(DELIVERY_COL).doc(id));
      const dSnaps = await db.getAll(...refs);
      dSnaps.forEach(s => { if (s.exists) deliveryMap.set(s.id, { id: s.id, ...s.data() }); });
    }

    // 4) รวมผลลัพธ์
    const items = aSnap.docs.map(doc => {
      const a = doc.data() || {};
      const d = a.delivery_id != null ? deliveryMap.get(String(a.delivery_id)) || null : null;
      return {
        assi_id: a.assi_id ?? Number(doc.id),
        id: doc.id,
        rider_id: a.rider_id ?? null,
        delivery_id: a.delivery_id ?? null,
        status: a.status ?? null,
        picture_status2: a.picture_status2 ?? null,
        picture_status3: a.picture_status3 ?? null,
        createdAt: a.createdAt ?? null,
        updatedAt: a.updatedAt ?? null,
        delivery: d ? {
          id: d.id,
          user_id_sender: d.user_id_sender ?? null,
          user_id_receiver: d.user_id_receiver ?? null,
          address_id_sender: d.address_id_sender ?? null,
          address_id_receiver: d.address_id_receiver ?? null,
          name_product: d.name_product ?? null,
          detail_product: d.detail_product ?? null,
          amount: d.amount ?? null,
          picture_product: d.picture_product ?? null,
          picture_status1: d.picture_status1 ?? null,
          phone_receiver: d.phone_receiver ?? null,
          status: d.status ?? null,
          updatedAt: d.updatedAt ?? null,
        } : null,
      };
    });

    res.json({ role, count: items.length, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/users/deliveries/:user_id?", async (req, res) => {
  try {
    // รองรับทั้ง path param และ query param
    const user_id_raw = req.params.user_id ?? req.query.user_id;
    if (!user_id_raw) return res.status(400).json({ error: "user_id is required" });

    const user_id = String(user_id_raw);
    const userIdNum = Number(user_id);
    if (Number.isNaN(userIdNum)) return res.status(400).json({ error: "user_id must be a number" });

    // 1) ตรวจ user + role
    const uSnap = await db.collection(USER_COL).doc(user_id).get();
    if (!uSnap.exists) return res.status(404).json({ error: "user not found" });

    const role = (uSnap.data() || {}).role; // 0=user, 1=rider
    // ถ้าต้องการอนุญาตเฉพาะ user ปกติ:
    if (role !== 0) {
      // เปลี่ยนเป็น 403 หากอยากบล็อกจริง ๆ
      return res.json({ role, count: 0, items: [] });
    }

    // 2) ค้น delivery ที่ผู้ใช้คนนี้เป็นผู้ส่ง (user_id_sender == user_id)
    let dSnap;
    try {
      dSnap = await db
        .collection(DELIVERY_COL)
        .where("user_id_sender", "==", userIdNum)
        .orderBy("updatedAt", "desc")   // ต้องมี index ถ้าเออเรอร์จะ fallback ด้านล่าง
        .limit(200)
        .get();
    } catch (err) {
      console.warn("Composite index required for orderBy(updatedAt). Using fallback without orderBy.", err.message);
      dSnap = await db
        .collection(DELIVERY_COL)
        .where("user_id_sender", "==", userIdNum)
        .limit(200)
        .get();
    }

    if (dSnap.empty) return res.json({ role, count: 0, items: [] });

    // 3) จัดรูปร่างผลลัพธ์
    const items = dSnap.docs.map(doc => {
      const d = doc.data() || {};
      return {
        id: doc.id,
        delivery_id: d.delivery_id ?? Number(doc.id),  // เผื่อใช้เลขภายใน
        user_id_sender: d.user_id_sender ?? null,
        user_id_receiver: d.user_id_receiver ?? null,
        address_id_sender: d.address_id_sender ?? null,
        address_id_receiver: d.address_id_receiver ?? null,
        name_product: d.name_product ?? null,
        detail_product: d.detail_product ?? null,
        amount: d.amount ?? null,
        picture_product: d.picture_product ?? null,
        picture_status1: d.picture_status1 ?? null,
        phone_receiver: d.phone_receiver ?? null,
        status: d.status ?? null,          // waiting/finish/...
        createdAt: d.createdAt ?? null,
        updatedAt: d.updatedAt ?? null,
      };
    });

    return res.json({ role, count: items.length, items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// GET /deliveries/by-receiver/:user_id
app.get("/deliveries/by-receiver/:user_id", async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "user_id must be a number" });
    }

    // ดึงเฉพาะงานที่ยังอยู่ระหว่างส่ง (accept/transporting)
    const snap = await db.collection("delivery")
      .where("user_id_receiver", "==", userId)
      .where("status", "in", ["accept"])
      .get();

    const items = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return res.json({
      user_id_receiver: userId,
      count: items.length,
      items,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/deliveries/status-transporting/:user_id", async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "user_id must be a number" });
    }

    // เอาเฉพาะงานที่กำลังขนส่ง และผู้ใช้เป็นผู้รับ
    let q = db.collection("delivery")
      .where("user_id_receiver", "==", userId)
      .where("status", "==", "transporting")
      .limit(limit); // ไม่มี orderBy(updatedAt)

    const snap = await q.get();
    const deliveries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // แนบ assignment ของแต่ละงาน (ไม่ orderBy เช่นกัน)
    const enriched = await Promise.all(deliveries.map(async (del) => {
      try {
        const assSnap = await db.collection("delivery_assignment")
          .where("delivery_id", "==", Number(del.delivery_id)) // ถ้าเก็บเป็น string เอา Number ออก
          .get();

        const assignments = assSnap.docs.map(a => ({ id: a.id, ...a.data() }));
        return { ...del, assignments };
      } catch {
        return { ...del, assignments: [] };
      }
    }));

    return res.json({
      user_id_receiver: userId,
      count: enriched.length,
      items: enriched,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/deliveries/status-finish/:user_id", async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "user_id must be a number" });
    }

    // เอาเฉพาะงานที่กำลังขนส่ง และผู้ใช้เป็นผู้รับ
    let q = db.collection("delivery")
      .where("user_id_receiver", "==", userId)
      .where("status", "==", "finish")
      .limit(limit); // ไม่มี orderBy(updatedAt)

    const snap = await q.get();
    const deliveries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // แนบ assignment ของแต่ละงาน (ไม่ orderBy เช่นกัน)
    const enriched = await Promise.all(deliveries.map(async (del) => {
      try {
        const assSnap = await db.collection("delivery_assignment")
          .where("delivery_id", "==", Number(del.delivery_id)) // ถ้าเก็บเป็น string เอา Number ออก
          .get();

        const assignments = assSnap.docs.map(a => ({ id: a.id, ...a.data() }));
        return { ...del, assignments };
      } catch {
        return { ...del, assignments: [] };
      }
    }));

    return res.json({
      user_id_receiver: userId,
      count: enriched.length,
      items: enriched,   // ไม่มี nextCursor เพราะตัดการเรียง/แบ่งหน้าแบบ cursor ออก
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});
//* ------------------------------- Start server ------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});