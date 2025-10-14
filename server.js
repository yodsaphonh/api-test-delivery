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
const RIDER_LOC_COL = "rider_location";
const ASSIGN_COL = "delivery_assignment"; // assi_id, delivery_id, rider_id, picture_status2, picture_status3, status
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
body: { user_id: 1 }
------------------------------------------------------------------ */
app.post("/delivery/list-by-user", async (req, res) => {
  try {
    const { user_id_sender } = req.body ?? {};
    if (!user_id_sender) {
      return res.status(400).json({ error: "user_id_sender is required" });
    }

    const DELIVERY_COL = "delivery"; 

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
    const DELIVERY_COL = "delivery";

    const deliveryDoc = await db.collection(DELIVERY_COL).doc(String(id)).get();
    if (!deliveryDoc.exists) {
      return res.status(404).json({ error: "delivery not found" });
    }

    const delivery = { id: deliveryDoc.id, ...deliveryDoc.data() };

    let addressSender = null;
    if (delivery.address_id_sender) {
      const addrSenderDoc = await db
        .collection("user_address")
        .doc(String(delivery.address_id_sender))
        .get();
      if (addrSenderDoc.exists) addressSender = addrSenderDoc.data();
    }

    let addressReceiver = null;
    if (delivery.address_id_receiver) {
      const addrReceiverDoc = await db
        .collection("user_address")
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


/*เส้นรับรับงาน เช่น rider ลังนอนตีลังกาอยู่ {
  "delivery_id": 2,
  "rider_id": 1
}*/

app.post("/deliveries/accept", async (req, res) => {
  try {
    const { delivery_id, rider_id } = req.body ?? {};

    if (!delivery_id || !rider_id)
      return res.status(400).json({ error: "delivery_id, rider_id, are required" });
    const deliveryRef = db.collection(DELIVERY_COL).doc(String(delivery_id));
    const deliveryDoc = await deliveryRef.get();
    if (!deliveryDoc.exists)
      return res.status(404).json({ error: "delivery not found" });

    const deliveryData = deliveryDoc.data();
    if (deliveryData.status !== "waiting")
      return res.status(400).json({ error: "Delivery already accepted or in progress" });

    const assiIdNum = await nextId("assi_seq");
    const assiId = String(assiIdNum);

    const payload = {
      assi_id: assiIdNum,
      delivery_id: Number(delivery_id),
      rider_id: Number(rider_id),
      status: "accept",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection(ASSIGN_COL).doc(assiId).set(payload);

    await deliveryRef.update({
      status: "accept",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, message: "Delivery assigned successfully", assignment: payload });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =====================================================================
   POST /deliveries/update-status-accept
   Body: { delivery_id, rider_id, picture_status2, lat, lng, address_id }
   Steps:
     1) Validate + check delivery
     2) Create assignment (status: accept)
     3) Update delivery status -> accept
     4) Update user_address/{address_id} with {lat,lng}
     5) Upsert rider_location/{rider_id} with {lat,lng,user_id=rider_id,address_id}
===================================================================== */
app.post("/deliveries/update-status-accept", async (req, res) => {
  try {
    const { delivery_id, rider_id, picture_status2, lat, lng, address_id } = req.body ?? {};

    if (!delivery_id || !rider_id || !picture_status2) {
      return res.status(400).json({ error: "delivery_id, rider_id, picture_status2 are required" });
    }
    if (lat == null || lng == null) {
      return res.status(400).json({ error: "lat, lng are required" });
    }
    if (!address_id) {
      return res.status(400).json({ error: "address_id is required" });
    }

    const deliveryRef = db.collection(DELIVERY_COL).doc(String(delivery_id));
    const assignIdNum = await nextId("assi_seq");
    const assignId = String(assignIdNum);

    const addrRef = db.collection(ADDRESS_COL).doc(String(address_id));
    const riderLocRef = db.collection(RIDER_LOC_COL).doc(String(rider_id));
    const assignRef = db.collection(ASSIGN_COL).doc(assignId);

    await db.runTransaction(async (tx) => {
      const deliverySnap = await tx.get(deliveryRef);
      if (!deliverySnap.exists) throw new Error("delivery not found");

      const d = deliverySnap.data();
      if (d.status !== "accept") {
        // ถ้าต้องการให้เปลี่ยนเฉพาะจาก waiting -> accept ให้แก้ไขเช็คตรงนี้
        throw new Error("Delivery already accepted or in progress");
      }

      // 2) assignment
      const assignment = {
        assi_id: assignIdNum,
        delivery_id: toNum(delivery_id),
        rider_id: toNum(rider_id), // = user_id
        picture_status2: picture_status2 || null,
        picture_status3: null,
        status: "accept",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(assignRef, assignment);

      // 3) update delivery
      tx.update(deliveryRef, {
        status: "accept",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4) update user_address
      tx.set(
        addrRef,
        {
          user_id: toNum(rider_id),        // owner = rider_id
          address_id: toNum(address_id),
          lat: toNum(lat),
          lng: toNum(lng),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // 5) upsert rider_location
      tx.set(
        riderLocRef,
        {
          user_id: String(rider_id),       // เก็บซ้ำสำหรับ join
          address_id: String(address_id),
          lat: toNum(lat),
          lng: toNum(lng),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return res.json({
      ok: true,
      message: "Delivery accepted + location updated",
      assignment_id: assignIdNum,
      rider_location: {
        rider_id: toNum(rider_id),
        address_id: toNum(address_id),
        lat: toNum(lat),
        lng: toNum(lng),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =====================================================================
   POST /rider/location/update
   - Update rider current location continually (>= 2m change to write)
   - Body: { rider_id, lat, lng, accuracy?, heading?, speed?, address_id? }
   NOTE: rider_id == user_id
===================================================================== */
app.post("/rider/location/update", async (req, res) => {
  try {
    const { rider_id, lat, lng, address_id } = req.body ?? {};
    if (!rider_id || lat == null || lng == null) {
      return res.status(400).json({ error: "rider_id, lat, lng are required" });
    }

    const docRef = db.collection(RIDER_LOC_COL).doc(String(rider_id));
    const snap = await docRef.get();

    if (snap.exists && snap.data()?.lat != null && snap.data()?.lng != null) {
      const old = snap.data();
      const d = haversineMeters(toNum(old.lat), toNum(old.lng), toNum(lat), toNum(lng));
      if (d < 2) return res.json({ ok: true, skipped: true, reason: "<2m" });
    }

    await docRef.set(
      {
        user_id: String(rider_id),
        address_id: address_id == null ? undefined : String(address_id),
        lat: toNum(lat),
        lng: toNum(lng),
        accuracy: toNum(accuracy),
        heading: toNum(heading),
        speed: toNum(speed),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, updated: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* =====================================================================
   POST /rider/location/update
   - Update rider current location continually (write only if moved >= 2m)
   - Body: { rider_id, lat, lng, address_id? }
   NOTE: rider_id == user_id. (accuracy/heading/speed คำนวณฝั่ง frontend ไม่เก็บที่นี่)
===================================================================== */
app.post("/rider/location/update", async (req, res) => {
  try {
    const { rider_id, lat, lng, address_id } = req.body ?? {};
    if (!rider_id || lat == null || lng == null) {
      return res.status(400).json({ error: "rider_id, lat, lng are required" });
    }

    const docRef = db.collection(RIDER_LOC_COL).doc(String(rider_id));
    const snap = await docRef.get();

    // ขยับน้อยกว่า 2 เมตร ไม่เขียนซ้ำ
    if (snap.exists && snap.data()?.lat != null && snap.data()?.lng != null) {
      const old = snap.data();
      const d = haversineMeters(toNum(old.lat), toNum(old.lng), toNum(lat), toNum(lng));
      if (d < 2) return res.json({ ok: true, skipped: true, reason: "<2m" });
    }

    await docRef.set(
      {
        user_id: String(rider_id),
        address_id: address_id == null ? undefined : String(address_id),
        lat: toNum(lat),
        lng: toNum(lng),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, updated: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/riders/:riderId/overview", async (req, res) => {
  try {
    const riderId = String(req.params.riderId);

    const locSnap = await db.collection(RIDER_LOC_COL).doc(riderId).get();
    if (!locSnap.exists) return res.status(404).json({ error: "rider location not found" });
    const loc = locSnap.data();

    const userId = riderId; // rider == user
    const addressId = String(loc.address_id ?? "");

    // user profile
    let user = null;
    const u = await db.collection(USER_COL).doc(userId).get();
    if (u.exists) user = { id: u.id, ...u.data() };

    // rider car (ลอง doc id = riderId ก่อน, ถ้าไม่มีใช้ where user_id)
    let riderCar = null;
    const carById = await db.collection(RIDER_CAR_COL).doc(riderId).get();
    if (carById.exists) {
      riderCar = { id: carById.id, ...carById.data() };
    } else {
      const q = await db.collection(RIDER_CAR_COL).where("user_id", "==", toNum(userId)).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0];
        riderCar = { id: d.id, ...d.data() };
      }
    }

    // address
    let address = null;
    if (addressId) {
      const a = await db.collection(ADDRESS_COL).doc(addressId).get();
      if (a.exists) address = { id: a.id, ...a.data() };
    }

    return res.json({
      rider_id: riderId,
      user,
      rider_car: riderCar,
      address,
      location: {
        lat: toNum(loc.lat),
        lng: toNum(loc.lng),
        updatedAt: loc.updatedAt || null,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

//======อัพเดทสถานะตอนส่งเสร็จ======
/*
ส่งเป็น สองอัน

1. อัพเดทสถานะว่ากำลังเดินทาง {
  "assi_id": 1,
  "status": "transporting"
}

2. อัพเดทสถานะว่าส่งเสร็จแล้ว
{
  "assi_id": 1,
  "status": "finish",
  "picture_status3": "https://res.cloudinary.com/demo/image/upload/v1739134000/delivered_package.jpg"
}
*/
app.post("/deliveries/update-status", async (req, res) => {
  try {
    const { assi_id, status, picture_status3 } = req.body ?? {};
    if (!assi_id || !status)
      return res.status(400).json({ error: "assi_id and status are required" });

    const assignmentRef = db.collection(ASSIGN_COL).doc(String(assi_id));
    const assignmentDoc = await assignmentRef.get();
    if (!assignmentDoc.exists)
      return res.status(404).json({ error: "assignment not found" });

    const data = assignmentDoc.data();
    const deliveryRef = db.collection(DELIVERY_COL).doc(String(data.delivery_id));

    // ตรวจว่า delivery ยังอยู่ในระบบ
    const deliveryDoc = await deliveryRef.get();
    if (!deliveryDoc.exists)
      return res.status(404).json({ error: "delivery not found" });

    // อัปเดต assignment
    const updates = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (status === "finish" && picture_status3)
      updates.picture_status3 = picture_status3;

    await assignmentRef.update(updates);

    // sync delivery.status
    await deliveryRef.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, message: `Status updated to ${status}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

//* ------------------------------- Start server ------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});