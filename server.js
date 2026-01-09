// server.js
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Load environment variables
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5003;

// --- Middleware ---
const corsOptions = {
  origin: '*', // Allow any origin for debugging
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// --- AI and Upload Setup ---
if (!process.env.GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY is not set. Cash verification will fail.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const visionModel = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// --- Product Definitions ---
const VENDING_PRODUCTS = [
    { productId: 'mango', name: 'Mango Juice', price: 10.00, image: 'mango.png' },
    { productId: 'mojo', name: 'Mojo', price: 15.00, image: 'mojo.webp' },
    { productId: 'chips', name: 'Potato Chips', price: 20.00, image: 'chips.jpeg' },
    { productId: 'ven', name: 'Ven', price: 25.00, image: 'ven.jpg' },
];

// --- MongoDB Setup ---
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let ordersCollection;
let vendingCollection;

const machineQueues = {};

async function run() {
  try {
    await client.connect();
    const database = client.db("vendingDb");
    ordersCollection = database.collection("orders");
    vendingCollection = database.collection("vendingCommands");
    console.log("✅ Connected to MongoDB and vendingDb database.");
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

app.get('/', (req, res) => res.send("Vending Machine Server is running..."));
app.get('/api/products', (req, res) => res.json(VENDING_PRODUCTS));

app.post('/api/orders', async (req, res) => {
    const { productId, deviceId, paymentMethod } = req.body;
    if (!productId || !deviceId || !paymentMethod) {
        return res.status(400).send({ message: 'productId, deviceId, and paymentMethod are required.' });
    }

    const product = VENDING_PRODUCTS.find(p => p.productId === productId);
    if (!product) {
        return res.status(404).send({ message: 'Product not found.' });
    }

    const dispenseCode = Math.floor(100000 + Math.random() * 900000).toString();

    try {
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
            // Immediately queue command upon successful cash payment
            const command = {
                deviceId: order.deviceId,
                orderId: order._id.toString(),
                productId: order.productId,
                status: "pending",
                createdAt: new Date()
            };
            const cmdInsertRes = await vendingCollection.insertOne(command);
            machineQueues[order.deviceId] = machineQueues[order.deviceId] || [];
            machineQueues[order.deviceId].push({
                commandId: cmdInsertRes.insertedId.toString(),
                productId: command.productId,
            });
            res.send({ success: true, message: 'Payment verified! Your product is being prepared.' });
        } else {
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
        const cmdInsertRes = await vendingCollection.insertOne(command);
        machineQueues[deviceId] = machineQueues[deviceId] || [];
        machineQueues[deviceId].push({
            commandId: cmdInsertRes.insertedId.toString(),
            productId: command.productId,
        });

        await ordersCollection.updateOne({ _id: order._id }, { $set: { status: 'redeemed' } });

        res.send({ message: `Success! Your ${order.productId} is being dispensed.` });

    } catch (error) {
        console.error('Error dispensing product:', error);
        res.status(500).send({ message: 'Server error while dispensing product.' });
    }
});

// --- ESP32 Communication Endpoints ---

app.get('/api/vending-command/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    machineQueues[deviceId] = machineQueues[deviceId] || [];

    // 1. Prioritize dispensing already-paid items from the in-memory queue
    if (machineQueues[deviceId].length > 0) {
        const nextCommand = machineQueues[deviceId].shift();
        await vendingCollection.updateOne({ _id: new ObjectId(nextCommand.commandId) }, { $set: { status: 'dispatched', dispatchedAt: new Date() } });
        return res.json({ command: 'vend', productId: nextCommand.productId, commandId: nextCommand.commandId });
    }

    try {
        // 2. Check if there's a pending cash order waiting to be processed
        const pendingCashOrder = await ordersCollection.findOne(
            { deviceId, status: 'pending', paymentMethod: 'cash' },
            { sort: { createdAt: 1 } }
        );

        if (pendingCashOrder) {
            // Instruct the ESP32 to activate its cash-handling process
            return res.json({ command: 'waitForCash', orderId: pendingCashOrder._id.toString() });
        }

        // 3. Fallback: check DB for any 'vend' commands that were not in the memory queue
        const pendingVendCommand = await vendingCollection.findOne({ deviceId, status: 'pending' }, { sort: { createdAt: 1 } });
        if (pendingVendCommand) {
            await vendingCollection.updateOne({ _id: pendingVendCommand._id }, { $set: { status: 'dispatched', dispatchedAt: new Date() } });
            return res.json({ command: 'vend', productId: pendingVendCommand.productId, commandId: pendingVendCommand._id.toString() });
        }

        // 4. If no commands are pending, tell the ESP32 there's nothing to do
        return res.json({ command: null });

    } catch (err) {
        console.error("Error fetching commands:", err);
        return res.status(500).json({ error: "Failed to fetch commands" });
    }
});

app.post('/api/vending-status', async (req, res) => {
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