const express = require('express');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
const path    = require('path');
const session = require('express-session');

const app = express();
app.use(express.json());
app.use(session({
    secret: 'invoice-platform-demo-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;

// In-memory mock database for prototyping
const invoiceDataStore = {};

// Demo user accounts (hardcoded for prototype)
const USERS = [
    { id: 1, username: 'admin',   password: 'admin123',  role: 'admin',   name: 'Administrator' },
    { id: 2, username: 'biller',  password: 'bill123',   role: 'biller',  name: 'Billing Agent' },
    { id: 3, username: 'scanner', password: 'scan123',   role: 'scanner', name: 'Verification Agent' }
];

function requireAuth(...roles) {
    return (req, res, next) => {
        if (!req.session.user) return res.redirect('/login');
        if (roles.length && !roles.includes(req.session.user.role)) {
            return res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
        }
        next();
    };
}

// ===== Auth Routes =====

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = USERS.find(u => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ status: 'Error', message: 'Invalid username or password' });
    req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
    const redirect = user.role === 'admin' ? '/' : user.role === 'biller' ? '/billing' : '/scanner';
    res.json({ status: 'Success', role: user.role, redirect });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ status: 'Success' }));
});

app.get('/api/auth/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ status: 'Unauthorized' });
    res.json(req.session.user);
});

// ===== Protected Page Routes (must be before express.static) =====

app.get('/login', (req, res) => {
    if (req.session.user) {
        const dest = req.session.user.role === 'admin' ? '/' : req.session.user.role === 'biller' ? '/billing' : '/scanner';
        return res.redirect(dest);
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/billing', requireAuth('admin', 'biller'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'billing.html'));
});

app.get('/scanner', requireAuth('admin', 'scanner'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

// Serve static assets (CSS, JS) — after page routes so HTML is protected
app.use(express.static(path.join(__dirname, 'public')));

// ===== ML Fraud Detection Models =====

const BASELINE = {
    avgAmount: 15000, stdAmount: 12000,
    avgRate: 2000,    stdRate: 1500,
    avgQty: 5,        stdQty: 4,
    validGstRates: [0, 5, 12, 18, 28]
};

function zScore(value, mean, std) {
    return std === 0 ? 0 : Math.abs((value - mean) / std);
}

function model1_ZScoreAnomaly(invoice) {
    const { items, totalAmount } = invoice;
    const item = items[0];
    const anomalies = [];
    let riskScore = 0;

    const zA = zScore(totalAmount, BASELINE.avgAmount, BASELINE.stdAmount);
    if (zA > 3)      { anomalies.push(`Total ₹${totalAmount} — severe outlier (z=${zA.toFixed(2)})`); riskScore += 40; }
    else if (zA > 2) { anomalies.push(`Total ₹${totalAmount} — moderate outlier (z=${zA.toFixed(2)})`); riskScore += 20; }

    const zR = zScore(item.rate, BASELINE.avgRate, BASELINE.stdRate);
    if (zR > 3)      { anomalies.push(`Unit rate ₹${item.rate} — severe outlier (z=${zR.toFixed(2)})`); riskScore += 30; }
    else if (zR > 2) { anomalies.push(`Unit rate ₹${item.rate} — moderate outlier (z=${zR.toFixed(2)})`); riskScore += 15; }

    const zQ = zScore(item.quantity, BASELINE.avgQty, BASELINE.stdQty);
    if (zQ > 3) { anomalies.push(`Quantity ${item.quantity} — severe outlier (z=${zQ.toFixed(2)})`); riskScore += 20; }

    if (!BASELINE.validGstRates.includes(item.gstPercentage)) {
        anomalies.push(`GST rate ${item.gstPercentage}% is non-standard`); riskScore += 35;
    }

    if (anomalies.length === 0) anomalies.push('No statistical anomalies detected');
    riskScore = Math.min(100, riskScore);
    return {
        model: 'Statistical Z-Score Anomaly Detector',
        riskScore,
        verdict: riskScore >= 60 ? 'HIGH RISK' : riskScore >= 30 ? 'MEDIUM RISK' : 'LOW RISK',
        anomalies,
        details: { zAmount: zA.toFixed(2), zRate: zR.toFixed(2), zQty: zQ.toFixed(2) }
    };
}

function model2_DecisionTree(invoice) {
    const { items, subtotal, taxes, totalAmount, isIntraState, buyer } = invoice;
    const item = items[0];
    const rules = [];
    let riskScore = 0;

    const gstinRe = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!gstinRe.test(buyer.gstNumber)) {
        rules.push({ rule: 'GSTIN Format', status: 'FAIL', detail: 'Invalid GSTIN pattern' }); riskScore += 30;
    } else {
        rules.push({ rule: 'GSTIN Format', status: 'PASS', detail: 'Valid 15-char GSTIN' });
    }

    const computedTax = (subtotal * item.gstPercentage) / 100;
    const claimedTax  = taxes.cgst + taxes.sgst + taxes.igst;
    if (Math.abs(computedTax - claimedTax) > 0.01) {
        rules.push({ rule: 'Tax Accuracy', status: 'FAIL', detail: `Expected ₹${computedTax.toFixed(2)}, claimed ₹${claimedTax.toFixed(2)}` }); riskScore += 35;
    } else {
        rules.push({ rule: 'Tax Accuracy', status: 'PASS', detail: 'Tax calculation correct' });
    }

    if (isIntraState && taxes.igst > 0) {
        rules.push({ rule: 'Tax Type', status: 'FAIL', detail: 'Intra-state must not have IGST' }); riskScore += 25;
    } else if (!isIntraState && (taxes.cgst > 0 || taxes.sgst > 0)) {
        rules.push({ rule: 'Tax Type', status: 'FAIL', detail: 'Inter-state must not have CGST/SGST' }); riskScore += 25;
    } else {
        rules.push({ rule: 'Tax Type', status: 'PASS', detail: 'Tax type matches transaction scope' });
    }

    const expectedTotal = subtotal + taxes.cgst + taxes.sgst + taxes.igst;
    if (Math.abs(expectedTotal - totalAmount) > 0.01) {
        rules.push({ rule: 'Total Integrity', status: 'FAIL', detail: `Expected ₹${expectedTotal.toFixed(2)}, got ₹${totalAmount.toFixed(2)}` }); riskScore += 40;
    } else {
        rules.push({ rule: 'Total Integrity', status: 'PASS', detail: 'Totals match' });
    }

    if (!BASELINE.validGstRates.includes(item.gstPercentage)) {
        rules.push({ rule: 'GST Rate', status: 'FAIL', detail: `Non-standard: ${item.gstPercentage}%` }); riskScore += 20;
    } else {
        rules.push({ rule: 'GST Rate', status: 'PASS', detail: `Standard: ${item.gstPercentage}%` });
    }

    riskScore = Math.min(100, riskScore);
    return {
        model: 'Rule-Based Decision Tree',
        riskScore,
        verdict: riskScore >= 60 ? 'HIGH RISK' : riskScore >= 30 ? 'MEDIUM RISK' : 'LOW RISK',
        rules
    };
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function model3_LogisticScoring(invoice) {
    const { items, subtotal, taxes, totalAmount, buyer } = invoice;
    const item = items[0];
    const W = { gstAnomaly: 2.5, amountDev: 1.8, taxError: 2.2, gstinBad: 1.5 };
    const contributions = [];

    const gstBad = BASELINE.validGstRates.includes(item.gstPercentage) ? 0 : 1;
    contributions.push({ feature: 'GST Rate Validity', weight: W.gstAnomaly, value: gstBad, score: +(W.gstAnomaly * gstBad).toFixed(3) });

    const normAmt = Math.min(1, zScore(totalAmount, BASELINE.avgAmount, BASELINE.stdAmount) / 3);
    contributions.push({ feature: 'Amount Deviation', weight: W.amountDev, value: +normAmt.toFixed(3), score: +(W.amountDev * normAmt).toFixed(3) });

    const computedTax = (subtotal * item.gstPercentage) / 100;
    const claimedTax  = taxes.cgst + taxes.sgst + taxes.igst;
    const taxErr = computedTax > 0 ? Math.min(1, Math.abs(computedTax - claimedTax) / computedTax) : 0;
    contributions.push({ feature: 'Tax Error Ratio', weight: W.taxError, value: +taxErr.toFixed(3), score: +(W.taxError * taxErr).toFixed(3) });

    const gstinRe = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const gstinBad = gstinRe.test(buyer.gstNumber) ? 0 : 1;
    contributions.push({ feature: 'GSTIN Pattern', weight: W.gstinBad, value: gstinBad, score: +(W.gstinBad * gstinBad).toFixed(3) });

    const linear = contributions.reduce((s, c) => s + c.score, 0);
    const prob   = sigmoid(linear - 3.5);
    const riskScore = Math.min(100, Math.round(prob * 100));

    return {
        model: 'Weighted Logistic Scoring',
        riskScore,
        fraudProbability: +prob.toFixed(4),
        verdict: prob >= 0.6 ? 'HIGH RISK' : prob >= 0.3 ? 'MEDIUM RISK' : 'LOW RISK',
        contributions
    };
}

app.post('/api/fraud/analyze', requireAuth('admin', 'biller', 'scanner'), (req, res) => {
    try {
        const { buyer, items, subtotal, taxes, totalAmount, isIntraState } = req.body;
        if (!buyer || !items || items.length === 0 || totalAmount == null) {
            return res.status(400).json({ status: 'Error', message: 'Missing invoice data for analysis' });
        }
        const invoice = { buyer, items, subtotal, taxes, totalAmount, isIntraState };
        const models  = [
            model1_ZScoreAnomaly(invoice),
            model2_DecisionTree(invoice),
            model3_LogisticScoring(invoice)
        ];
        const avg = Math.round(models.reduce((s, m) => s + m.riskScore, 0) / models.length);
        res.json({
            status: 'Success',
            ensembleScore:   avg,
            ensembleVerdict: avg >= 60 ? 'HIGH RISK' : avg >= 30 ? 'MEDIUM RISK' : 'LOW RISK',
            models
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'Error', message: 'Analysis failed' });
    }
});

// ===== Invoice API Routes =====

app.post('/api/invoice/register', requireAuth('admin', 'biller'), async (req, res) => {
    try {
        const { buyer, items, subtotal, taxes, totalAmount, isIntraState } = req.body;

        if (!buyer || !items || items.length === 0 || !totalAmount) {
            return res.status(400).json({ status: 'Error', message: 'Missing required invoice details' });
        }

        const referenceNumber = crypto.randomUUID();
        const invoiceId = `INV-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
        const timestamp = new Date().toISOString();

        const invoiceRecord = {
            _id: referenceNumber,
            referenceNumber,
            invoiceId,
            seller: { name: 'ABC Company (Demo)', gstNumber: 'GTHUJ25632512355' },
            buyer,
            items,
            subtotal,
            taxes,
            totalAmount,
            isIntraState,
            timestamp,
            isValid: true
        };

        invoiceDataStore[referenceNumber] = invoiceRecord;

        const verificationUrl = `http://localhost:${PORT}/api/invoice/verify/${referenceNumber}`;
        const qrCodeDataUri = await QRCode.toDataURL(verificationUrl);

        res.status(201).json({
            status: 'Success',
            id: referenceNumber,
            referenceNumber,
            verificationUrl,
            qrCodeDataUri,
            timestamp
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ status: 'Error', message: 'Internal server error processing invoice' });
    }
});

app.get('/api/invoice/verify/:referenceNumber', requireAuth('admin', 'scanner'), (req, res) => {
    const { referenceNumber } = req.params;
    const invoice = invoiceDataStore[referenceNumber];

    if (!invoice) {
        return res.status(404).json({
            status: 'Invalid',
            message: 'Invoice not found or potentially fraudulent/fake.',
            referenceNumber
        });
    }

    res.status(200).json({
        status: 'Authentic',
        message: 'Invoice successfully verified against the centralized government database.',
        data: invoice
    });
});

app.listen(PORT, () => {
    console.log(`Smart Invoice Validation Sandbox Server running on port ${PORT}`);
    console.log(`  Admin:   http://localhost:${PORT}/  (admin / admin123)`);
    console.log(`  Biller:  http://localhost:${PORT}/billing  (biller / bill123)`);
    console.log(`  Scanner: http://localhost:${PORT}/scanner  (scanner / scan123)`);
});
