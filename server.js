// server.js
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');


const app = express();
const port = 5003;

// --- Middleware ---
const allowedOrigins = ["http://localhost:5173", "https://fluffy-manatee-ee98a5.netlify.app"];
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// --- AI and Upload Setup ---
const genAI = new GoogleGenerativeAI("AIzaSyCKhPSnvjRx4rC6s5UuVRuWBYRqWqiZ2fs");
const visionModel = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// --- Authentication Middleware for ESP32 ---
const requireApiKey = (req, res, next) => {
    const apiKey = req.get('X-API-Key');
    if (!apiKey || apiKey !== "a-secure-random-string-for-esp32") {
        return res.status(401).json({ message: 'Unauthorized: Missing or invalid API key.' });
    }
    next();
};

// --- MongoDB Setup ---
const uri = "mongodb+srv://mahmudul_hasan:e0hyPRpmg94fT3Zy@cluster0.klfbd3o.mongodb.net/?appName=Cluster0";
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let ordersCollection;
let vendingCollection;
let productsCollection;

async function run() {
  try {
    await client.connect();
    const database = client.db("vendingDb");
    ordersCollection = database.collection("orders");
    vendingCollection = database.collection("vendingCommands");
    productsCollection = database.collection("products");
    console.log("✅ Connected to MongoDB and vendingDb database.");

    // Seed the products collection if it's empty
    const productCount = await productsCollection.countDocuments();
    if (productCount === 0) {
      const initialProducts = [
        { productId: 'mango', name: 'Mango Juice', price: 10.00, image: 'mango.png' },
        { productId: 'mojo', name: 'Mojo', price: 15.00, image: 'mojo.webp' },
        { productId: 'chips', name: 'Potato Chips', price: 20.00, image: 'chips.jpeg' },
        { productId: 'ven', name: 'Ven', price: 25.00, image: 'ven.jpg' },
      ];
      await productsCollection.insertMany(initialProducts);
      console.log('✅ Products collection was empty, seeded with initial data.');
    }

  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
}
run().catch(console.error);

// --- AI Helper Function ---
async function verifyBanknoteWithGemini(imageBuffer) {
  const prompt = `
    Analyze the attached image of a banknote. Your response must be in JSON format.
    1. Identify the currency denomination (e.g., 10, 20, 50, 100) of the Bangladeshi Taka (BDT) note.
    2. Assess if the note is genuine or counterfeit.
    3. Provide a confidence score (0.0 to 1.0) for your assessment.

    Example Response for a genuine 20 Taka note:
    {
      "denomination": 20,
      "isGenuine": true,
      "confidence": 0.95,
      "reason": "Clear watermark and security thread visible."
    }

    If the image is not a valid BDT banknote or is unclear, respond with:
    {
      "denomination": 0,
      "isGenuine": false,
      "confidence": 0.9,
      "reason": "The image does not appear to be a valid Bangladeshi Taka banknote."
    }
  `;
  try {
    const imagePart = { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } };
    const result = await visionModel.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text().replace(/```json/g, '').replace(/```/g, '');
    return JSON.parse(text);
  } catch (error) {
    console.error("Error during Gemini API call:", error);
    return { denomination: 0, isGenuine: false, reason: "AI processing failed." };
  }
}


// --- API Endpoints ---

app.get('/api/config', (req, res) => {
    res.json({
        bKashNumber: "01608314796"
    });
});

app.get('/', (req, res) => res.send("Vending Machine Server is running..."));
app.get('/api/products', async (req, res) => {
    try {
        const products = await productsCollection.find({}).toArray();
        res.json(products);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).send({ message: 'Failed to fetch products.' });
    }
});

app.post('/api/orders', async (req, res) => {
    const { productId, deviceId, paymentMethod } = req.body;
    if (!productId || !deviceId || !paymentMethod) {
        return res.status(400).send({ message: 'productId, deviceId, and paymentMethod are required.' });
    }

    try {
        const product = await productsCollection.findOne({ productId: productId });
        if (!product) {
            return res.status(404).send({ message: 'Product not found.' });
        }

        const dispenseCode = Math.floor(100000 + Math.random() * 900000).toString();

        const order = {
            productId: product.productId,
            price: product.price,
            deviceId,
            paymentMethod,
            dispenseCode,
            status: 'pending',
            customerPhone: null,
            createdAt: new Date(),
        };
        const result = await ordersCollection.insertOne(order);

        let message;
        if (paymentMethod === 'bKash') {
            message = `Order created! Please pay exactly ${product.price.toFixed(2)} Taka via bKash to the designated number.`;
        } else if (paymentMethod === 'cash') {
            message = `Order created! Please insert a ${product.price.toFixed(2)} Taka note into the machine.`;
        } else {
            message = 'Order created with an unspecified payment method.';
        }

        res.status(201).send({ orderId: result.insertedId, message });
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).send({ message: 'Failed to create order.' });
    }
});

app.post('/api/payment-received', async (req, res) => {
    const { amount, senderNumber } = req.body;
    if (!amount || !senderNumber) {
        return res.status(400).send({ message: 'Payment amount and senderNumber are required.' });
    }

    try {
        const order = await ordersCollection.findOne({
            status: 'pending',
            paymentMethod: 'bKash',
            price: parseFloat(amount)
        }, { sort: { createdAt: 1 } });

        if (order) {
            await ordersCollection.updateOne(
                { _id: order._id },
                { $set: { status: 'paid', customerPhone: senderNumber, paidAt: new Date() } }
            );
            res.send({ dispenseCode: order.dispenseCode });
        } else {
            console.warn(`No pending bKash order found for amount: ${amount}`);
            res.status(404).send({ dispenseCode: null, message: 'No pending bKash order found for this amount.' });
        }
    } catch (error) {
        console.error('Error processing bKash payment:', error);
        res.status(500).send({ message: 'Server error while processing payment.' });
    }
});

app.post('/api/cash-payment/:orderId', upload.single('banknote'), async (req, res) => {
    const { orderId } = req.params;
    if (!req.file) {
        return res.status(400).send({ message: 'Banknote image is required.' });
    }

    try {
        const order = await ordersCollection.findOne({ _id: new ObjectId(orderId) });
        if (!order) {
            return res.status(404).send({ message: 'Order not found.' });
        }
        if (order.status !== 'pending' || order.paymentMethod !== 'cash') {
            return res.status(409).send({ message: 'This order is not pending a cash payment.' });
        }

        const verification = await verifyBanknoteWithGemini(req.file.buffer);

        if (verification.isGenuine && verification.denomination === order.price) {
            await ordersCollection.updateOne(
                { _id: order._id },
                { $set: { status: 'paid', paidAt: new Date() } }
            );
            const command = {
                deviceId: order.deviceId,
                orderId: order._id.toString(),
                productId: order.productId,
                status: "pending",
                createdAt: new Date()
            };
            await vendingCollection.insertOne(command);
            res.send({ success: true, message: 'Payment verified! Your product is being prepared.' });
        } else {
            // If verification fails, reset the status to 'pending' to allow a retry.
            await ordersCollection.updateOne(
                { _id: order._id },
                { $set: { status: 'pending' } }
            );
            res.status(402).send({ success: false, message: `Payment rejected. Reason: ${verification.reason}` });
        }
    } catch (error) {
        console.error('Error processing cash payment:', error);
        res.status(500).send({ message: 'Server error during cash payment processing.' });
    }
});

app.post('/api/dispense-product', async (req, res) => {
    const { dispenseCode, deviceId } = req.body;
    if (!dispenseCode || !deviceId) {
        return res.status(400).send({ message: 'dispenseCode and deviceId are required.' });
    }

    try {
        const order = await ordersCollection.findOne({ dispenseCode, deviceId });

        if (!order) {
            return res.status(404).send({ message: 'Invalid code or device ID.' });
        }
        if (order.status === 'redeemed') {
            return res.status(409).send({ message: 'This code has already been used.' });
        }
        if (order.status !== 'paid') {
            return res.status(403).send({ message: 'This order has not been paid for.' });
        }

        const command = {
            deviceId: order.deviceId,
            orderId: order._id.toString(),
            productId: order.productId,
            status: "pending",
            createdAt: new Date()
        };
        await vendingCollection.insertOne(command);

        await ordersCollection.updateOne({ _id: order._id }, { $set: { status: 'redeemed' } });

        res.send({ message: `Success! Your ${order.productId} is being dispensed.` });

    } catch (error) {
        console.error('Error dispensing product:', error);
        res.status(500).send({ message: 'Server error while dispensing product.' });
    }
});

// --- ESP32 Communication Endpoints ---

app.get('/api/vending-command/:deviceId', requireApiKey, async (req, res) => {
    const { deviceId } = req.params;
    console.log(`\n[${new Date().toISOString()}] Received command poll from device: ${deviceId}`);

    try {
        // 1. Check if there's an order already awaiting cash capture.
        console.log(`Querying for 'cash_capture_pending' order for device: ${deviceId}`);
        const capturePendingOrder = await ordersCollection.findOne(
            { deviceId, status: 'cash_capture_pending', paymentMethod: 'cash' },
            { sort: { createdAt: 1 } }
        );

        if (capturePendingOrder) {
            console.log('Found order awaiting capture:', capturePendingOrder._id);
            // We've already told the ESP to wait for cash. Tell it to keep waiting.
            return res.json({ command: 'waitForCash', orderId: capturePendingOrder._id.toString() });
        }
        
        // 2. Atomically find a new pending cash order and update its status.
        console.log(`Querying for 'pending' cash order for device: ${deviceId}`);
        const pendingCashOrder = await ordersCollection.findOneAndUpdate(
            { deviceId, status: 'pending', paymentMethod: 'cash' },
            { $set: { status: 'cash_capture_pending' } },
            { sort: { createdAt: 1 }, returnDocument: 'after' }
        );

        if (pendingCashOrder) {
            console.log('Found new pending cash order, updated status, and sending command:', pendingCashOrder._id);
            // Instruct the ESP32 to activate its cash-handling process for the first time
            return res.json({ command: 'waitForCash', orderId: pendingCashOrder._id.toString() });
        }

        console.log('No pending cash orders found for this device.');

        // 3. Check for a 'vend' command in the database
        const pendingVendCommand = await vendingCollection.findOneAndUpdate(
            { deviceId, status: 'pending' },
            { $set: { status: 'dispatched', dispatchedAt: new Date() } },
            { sort: { createdAt: 1 }, returnDocument: 'after' }
        );

        if (pendingVendCommand) {
            return res.json({ 
                command: 'vend', 
                productId: pendingVendCommand.productId, 
                commandId: pendingVendCommand._id.toString() 
            });
        }

        // 3. If no commands are pending, tell the ESP32 there's nothing to do
        return res.json({ command: null });

    } catch (err) {
        console.error("Error fetching commands:", err);
        return res.status(500).json({ error: "Failed to fetch commands" });
    }
});

app.post('/api/vending-status', requireApiKey, async (req, res) => {
    const { commandId, status, message } = req.body;
    if (!commandId || !status) {
        return res.status(400).send({ message: 'commandId and status are required.' });
    }
    try {
        await vendingCollection.updateOne(
            { _id: new ObjectId(commandId) },
            { $set: { status: status, resultMessage: message, updatedAt: new Date() } }
        );
        res.send({ message: 'Status updated.' });
    } catch (error) {
        console.error('Error updating vending status:', error);
        return res.status(500).json({ error: 'Failed to update status' });
    }
});

// --- Server Start ---
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${port}`);
});