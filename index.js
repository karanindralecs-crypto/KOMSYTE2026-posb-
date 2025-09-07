// index.js - KOMSYTE Backend (Updated for Owner/Worker Roles)

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
require('dotenv').config();

// ---------------- App Setup ----------------
const app = express();

app.use((req, res, next) => {
    if (req.path === '/api/razorpay-webhook') {
        return express.raw({ type: 'application/json' })(req, res, next);
    }
    return express.json()(req, res, next);
});

const allowedOrigins = [
    'http://localhost:3000',      // local dev
    'http://localhost:5173',      // Vite dev
    'https://komsyte2026-pos.onrender.com'  // hosted frontend URL
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS Error: Origin ${origin} not allowed`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));


// ---------------- MongoDB ----------------
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => {
        console.error('❌ MongoDB connection error:', err);
        process.exit(1);
    });

// ---------------- Constants ----------------
const JWT_SECRET = process.env.JWT_SECRET || 'changeme_jwt_secret';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const RAZORPAY_PLAN_IDS = {
    '299': process.env.PLAN_ID_299 || 'plan_YOUR_299_PLAN_ID',
    '699': process.env.PLAN_ID_699 || 'plan_YOUR_699_PLAN_ID',
    '1499': process.env.PLAN_ID_1499 || 'plan_YOUR_1499_PLAN_ID'
};

const PLANS = {
    free: {
        name: 'Free',
        price: 0,
        maxProducts: 10,
        features: {
            billingHistory: true, downloadBill: false, updateQuantity: false,
            reports: 'none', whatsappShare: false, emailShare: false,
            lowStockAlert: false, manualAdd: false, topProduct: false
        }
    },
    '299': {
        name: 'Basic', price: 299, maxProducts: 50,
        features: {
            billingHistory: true, downloadBill: true, updateQuantity: true,
            reports: 'simple', whatsappShare: false, emailShare: false,
            lowStockAlert: false, manualAdd: false, topProduct: false
        }
    },
    '699': {
        name: 'Growth', price: 699, maxProducts: 100,
        features: {
            billingHistory: true, downloadBill: true, updateQuantity: true,
            reports: 'all', whatsappShare: true, emailShare: false,
            lowStockAlert: true, manualAdd: true, topProduct: true
        }
    },
    '1499': {
        name: 'Premium', price: 1499, maxProducts: Infinity,
        features: {
            billingHistory: true, downloadBill: true, updateQuantity: true,
            reports: 'all', whatsappShare: true, emailShare: true,
            lowStockAlert: true, manualAdd: true, topProduct: true
        }
    }
};

// ---------------- Razorpay & Nodemailer Setup ----------------
const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
const transporter = (EMAIL_USER && EMAIL_PASS) ? nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } }) : null;

// ---------------- Schemas ----------------
const subscriptionSchema = new mongoose.Schema({
    plan: { type: String, enum: Object.keys(PLANS), default: 'free' },
    status: { type: String, enum: ['inactive', 'active', 'canceled', 'halted'], default: 'active' },
    startDate: Date,
    nextBillingDate: Date,
    razorpayPaymentId: String,
    razorpaySubscriptionId: String,
}, { _id: false });

const shopSchema = new mongoose.Schema({
    shopName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    subscription: { type: subscriptionSchema, default: () => ({ plan: 'free', status: 'active' }) },
}, { timestamps: true });

const productSchema = new mongoose.Schema({
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    barcode: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
}, { timestamps: true });
productSchema.index({ shopId: 1, barcode: 1 }, { unique: true });

// 🛠️ MODIFIED: Bill Schema for Performance Tracking
const billSchema = new mongoose.Schema({
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    receiptNo: { type: String, required: true },
    items: [{ barcode: String, name: String, price: Number, quantity: Number, subtotal: Number, discount: Number }],
    totalAmount: Number,
    customerMobile: String,
    // ✅ NEW: Field to track which worker created the bill.
    workerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: false },
}, { timestamps: true });

const workerSchema = new mongoose.Schema({
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'worker' },
}, { timestamps: true });


const Shop = mongoose.model('Shop', shopSchema);
const Product = mongoose.model('Product', productSchema);
const Bill = mongoose.model('Bill', billSchema);
const Worker = mongoose.model('Worker', workerSchema);

// ---------------- Middleware ----------------
// 🛠️ MODIFIED: Auth Middleware to handle new JWT structure
function authMiddleware(req, res, next) {
    try {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

        const token = auth.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        // ✅ NEW: Attach all decoded info to the request object
        req.user = {
            shopId: decoded.shopId,
            userId: decoded.userId,
            role: decoded.role
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ✅ NEW: Middleware to restrict access to Owners only
function ownerOnly(req, res, next) {
    if (req.user.role !== 'owner') {
        return res.status(403).json({ error: 'Access denied. This action is for shop owners only.' });
    }
    next();
}


function subscriptionMiddleware(requiredPlans = []) {
    return async (req, res, next) => {
        try {
            const shop = await Shop.findById(req.user.shopId); // Using new req.user
            if (!shop) return res.status(404).json({ error: 'Shop not found' });

            const planKey = shop.subscription?.plan || 'free';
            const planConfig = PLANS[planKey];
            if (!planConfig) return res.status(400).json({ error: 'Invalid plan configured' });

            if (requiredPlans.length && !requiredPlans.includes(planKey)) {
                return res.status(403).json({ error: `Feature available only for ${requiredPlans.join(', ')} plan(s).` });
            }

            if (planKey !== 'free' && shop.subscription?.status !== 'active') {
                return res.status(403).json({ error: 'Subscription is not active. Please check your payment status.' });
            }

            req.planConfig = planConfig;
            req.planKey = planKey;
            next();
        } catch (err) {
            res.status(500).json({ error: 'Server error checking subscription' });
        }
    };
}

const upload = multer({ storage: multer.memoryStorage() });

// ---------------- Auth & Profile Routes ----------------
app.post('/api/signup', async (req, res) => {
    try {
        const { shopName, email, password } = req.body;
        if (!shopName || !email || !password) return res.status(400).json({ error: 'All fields required' });
        if (await Shop.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const shop = await new Shop({ shopName, email: email.toLowerCase(), password: hashedPassword }).save();
        
        // 🛠️ MODIFIED: Signup creates an owner token
        const token = jwt.sign({ 
            shopId: shop._id, 
            userId: shop._id, 
            role: 'owner' 
        }, JWT_SECRET, { expiresIn: '7d' });
        
        res.status(201).json({ token });
    } catch (err) {
        res.status(500).json({ error: 'Server error during signup' });
    }
});

// 🛠️ MODIFIED: Unified Login for Owners and Employees
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        let user = null;
        let role = null;
        let shopId = null;

        const shop = await Shop.findOne({ email: email.toLowerCase() });
        if (shop && (await bcrypt.compare(password, shop.password))) {
            user = shop;
            role = 'owner';
            shopId = shop._id;
        } else {
            const worker = await Worker.findOne({ email: email.toLowerCase() });
            if (worker && (await bcrypt.compare(password, worker.password))) {
                user = worker;
                role = 'worker';
                shopId = worker.shopId;
            }
        }

        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const tokenPayload = {
            shopId: shopId,
            userId: user._id,
            role: role
        };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            user: {
                role: role,
                name: user.name || user.shopName,
                email: user.email
            }
        });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = req.user.role === 'owner'
            ? await Shop.findById(req.user.userId).select('-password')
            : await Worker.findById(req.user.userId).select('-password');
        
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        res.json({ user, role: req.user.role });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// 🛠️ MODIFIED: Profile route now restricted to owners
app.get('/api/profile', authMiddleware, ownerOnly, async (req, res) => {
    try {
        const [shop, workers] = await Promise.all([
            Shop.findById(req.user.shopId).select('-password'),
            Worker.find({ shopId: req.user.shopId }).select('-password')
        ]);

        if (!shop) {
            return res.status(404).json({ error: 'Shop profile not found' });
        }

        res.json({
            shop: {
                _id: shop._id,
                shopName: shop.shopName,
                email: shop.email
            },
            subscription: shop.subscription,
            workers: workers || []
        });

    } catch (err) {
        console.error("Profile fetch error:", err);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

// 🛠️ MODIFIED: Update shop route now uses new auth
app.put('/api/profile/shop', authMiddleware, ownerOnly, async (req, res) => {
    try {
        const { shopName, email } = req.body;

        if (!shopName || !email) {
            return res.status(400).json({ error: 'Shop name and email are required.' });
        }

        const shop = await Shop.findById(req.user.shopId);
        if (!shop) {
            return res.status(404).json({ error: 'Shop not found.' });
        }

        if (email.toLowerCase() !== shop.email) {
            const emailExists = await Shop.findOne({ email: email.toLowerCase() });
            if (emailExists) {
                return res.status(409).json({ error: 'This email is already registered by another shop.' });
            }
        }

        shop.shopName = shopName;
        shop.email = email.toLowerCase();
        await shop.save();

        const updatedShop = {
            _id: shop._id,
            shopName: shop.shopName,
            email: shop.email
        }
        res.json({ message: 'Shop information updated successfully.', shop: updatedShop });

    } catch (err) {
        console.error("Update shop error:", err);
        res.status(500).json({ error: 'Server error while updating shop information.' });
    }
});

// ---------------- Subscription Routes (Now restricted to owners) ----------------
app.get('/api/plans', (_, res) => res.json({ plans: Object.values(PLANS).map((p, i) => ({ id: Object.keys(PLANS)[i], ...p })) }));

app.post("/api/create-subscription", authMiddleware, ownerOnly, async (req, res) => {
    try {
        const { plan } = req.body;
        const planId = RAZORPAY_PLAN_IDS[plan];
        if (!planId) return res.status(400).json({ error: "Invalid plan selected" });

        const shop = await Shop.findById(req.user.shopId);
        if (!shop) return res.status(404).json({ error: "Shop not found" });

        const subscription = await razorpay.subscriptions.create({
            plan_id: planId,
            customer_notify: 1,
            total_count: 12,
        });

        shop.subscription.plan = plan;
        shop.subscription.razorpaySubscriptionId = subscription.id;
        shop.subscription.status = 'inactive';
        await shop.save();

        res.json({
            key_id: RAZORPAY_KEY_ID,
            subscription_id: subscription.id,
        });

    } catch (err) {
        console.error("Create subscription error:", err);
        res.status(500).json({ error: "Failed to create subscription" });
    }
});

app.post("/api/razorpay-webhook", async (req, res) => { /* ... no changes ... */ });

// ---------------- Products Routes ----------------
app.post('/api/products', authMiddleware, subscriptionMiddleware(), async (req, res) => {
    try {
        const { barcode, name, price, quantity, updateStock } = req.body;
        if (!barcode) return res.status(400).json({ error: 'Barcode is required.' });

        const planConfig = req.planConfig;
        let product = await Product.findOne({ shopId: req.user.shopId, barcode });

        if (updateStock) {
            if (!planConfig.features.updateQuantity) return res.status(403).json({ error: 'Updating stock is not available on your plan.' });
            if (!product) return res.status(404).json({ error: 'Product not found.' });

            product.quantity += Number(quantity);
            await product.save();
            return res.json({ message: 'Stock updated successfully', product });
        } else {
            if (product) return res.status(409).json({ error: 'Product with this barcode already exists.' });
            if ((await Product.countDocuments({ shopId: req.user.shopId })) >= planConfig.maxProducts) {
                return res.status(403).json({ error: `You have reached your product limit of ${planConfig.maxProducts}. Please upgrade.` });
            }
            const newProduct = new Product({ shopId: req.user.shopId, barcode, name, price, quantity });
            await newProduct.save();
            return res.status(201).json({ message: 'Product added successfully', product: newProduct });
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error handling product' });
    }
});

app.post('/api/stock/upload', authMiddleware, ownerOnly, subscriptionMiddleware(['299', '699', '1499']), upload.single('file'), async (req, res) => { /* ... logic uses req.user.shopId ... */ });

app.delete('/api/stock/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const product = await Product.findOneAndDelete({ _id: id, shopId: req.user.shopId });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/stock', authMiddleware, async (req, res) => {
    try {
        const products = await Product.find({ shopId: req.user.shopId });
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stock' });
    }
});

// ---------------- Billing Routes ----------------
// 🛠️ MODIFIED: Create Bill endpoint now tracks the worker
app.post('/api/bills', authMiddleware, subscriptionMiddleware(), async (req, res) => {
    const session = await mongoose.startSession();
    try {
        let finalBill;
        await session.withTransaction(async () => {
            const { items, customerMobile } = req.body;
            if (!items || !Array.isArray(items) || items.length === 0) {
                throw new Error('No items provided');
            }

            const planConfig = req.planConfig;
            const billItems = [];
            let computedTotal = 0;

            for (const it of items) {
                if (it.barcode && !it.barcode.startsWith('manual-')) {
                    const product = await Product.findOne({ shopId: req.user.shopId, barcode: it.barcode }).session(session);
                    if (!product) throw new Error(`Product not found: ${it.barcode}`);
                    if (product.quantity < it.quantity) throw new Error(`Insufficient stock for ${product.name}`);

                    const subtotal = (product.price * it.quantity) - (it.discount || 0);
                    billItems.push({ ...it, price: product.price, name: product.name, subtotal });
                    computedTotal += subtotal;

                    await Product.updateOne(
                        { _id: product._id },
                        { $inc: { quantity: -it.quantity } },
                        { session }
                    );
                } else {
                    if (!planConfig.features.manualAdd) throw new Error('Your plan does not allow adding manual products to bills.');
                    const subtotal = (it.price * it.quantity) - (it.discount || 0);
                    billItems.push({ ...it, subtotal });
                    computedTotal += subtotal;
                }
            }

            const shop = await Shop.findById(req.user.shopId).session(session);
            const receiptNo = `INV-${shop.shopName.substring(0, 3).toUpperCase()}-${Date.now()}`;
            
            const billData = {
                shopId: req.user.shopId,
                receiptNo,
                items: billItems,
                totalAmount: computedTotal,
                customerMobile: customerMobile || null,
            };

            // ✅ NEW: If the user is a worker, save their ID with the bill
            if (req.user.role === 'worker') {
                billData.workerId = req.user.userId;
            }

            const bill = new Bill(billData);
            finalBill = await bill.save({ session });
        });

        session.endSession();
        res.status(201).json({ message: 'Bill finalized successfully', bill: finalBill });

    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        session.endSession();
        res.status(400).json({ error: err.message || 'Server error while finalizing bill' });
    }
});


app.get('/api/bills', authMiddleware, async (req, res) => {
    try {
        const bills = await Bill.find({ shopId: req.user.shopId }).sort({ createdAt: -1 }).limit(200);
        res.json(bills);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch bills' });
    }
});

// ---------------- Worker Management Routes (Now restricted to owners) ----------------
// 🛠️ MODIFIED: All worker management routes are now owner-only
app.post('/api/workers/add', authMiddleware, ownerOnly, async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required.' });
        }

        const existingWorker = await Worker.findOne({ email: email.toLowerCase() });
        const existingShop = await Shop.findOne({ email: email.toLowerCase() });
        if (existingWorker || existingShop) {
            return res.status(409).json({ error: 'This email is already registered.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newWorker = new Worker({
            shopId: req.user.shopId, // Use shopId from authenticated owner's token
            name,
            email: email.toLowerCase(),
            password: hashedPassword
        });

        await newWorker.save();
        res.status(201).json({ message: 'Worker added successfully.', worker: { name: newWorker.name, email: newWorker.email } });

    } catch (err) {
        console.error("Add worker error:", err);
        res.status(500).json({ error: 'Server error while adding worker.' });
    }
});

app.delete('/api/workers/:id', authMiddleware, ownerOnly, async (req, res) => {
    try {
        const workerId = req.params.id;
        // Ensure owner can only delete workers from their own shop
        const result = await Worker.findOneAndDelete({ _id: workerId, shopId: req.user.shopId });

        if (!result) {
            return res.status(404).json({ error: 'Worker not found or you do not have permission to remove them.' });
        }

        res.json({ message: 'Worker removed successfully.' });

    } catch (err) {
        console.error("Remove worker error:", err);
        res.status(500).json({ error: 'Server error while removing worker.' });
    }
});

// ---------------- ✅ NEW: Contact Form Route ----------------
app.post('/api/contact', async (req, res) => {
    // Check if the email service is configured in your .env file
    if (!transporter) {
        return res.status(503).json({ error: 'Contact service is temporarily unavailable.' });
    }

    try {
        const { name, email, subject, message } = req.body;

        // Basic validation
        if (!name || !email || !subject || !message) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        const mailOptions = {
            from: `"KOMSyte Contact Form" <${EMAIL_USER}>`, // Sender address (your app's email)
            to: 'karanindrale253@gmail.com', // List of receivers (your support email)
            subject: `[Contact Form] ${subject}`, // Subject line
            html: `
                <h3>New Message from KOMSyte Contact Form</h3>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Email:</strong> ${email}</p>
                <hr>
                <p><strong>Message:</strong></p>
                <p>${message.replace(/\n/g, '<br>')}</p>
            `,
        };

        // Send the email
        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'Your message has been sent successfully!' });

    } catch (error) {
        console.error('Error sending contact form email:', error);
        res.status(500).json({ error: 'Failed to send your message. Please try again later.' });
    }
});


// ---------------- Start Server ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
