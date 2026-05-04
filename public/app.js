document.addEventListener('DOMContentLoaded', async () => {

    // Holds the last invoice that was verified — used by ML buttons on the scanner page
    let lastVerifiedInvoice = null;

    // ===== Auth: Load current user & wire logout =====
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) { window.location.href = '/login'; return; }
        const user = await res.json();
        const userInfoEl = document.getElementById('userInfo');
        if (userInfoEl) userInfoEl.textContent = user.name;
    } catch (e) {
        window.location.href = '/login';
        return;
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.href = '/login';
        });
    }

    // ===== Application 1: Billing Form Submission =====
    const generateForm    = document.getElementById('generateForm');
    const generationResult = document.getElementById('generationResult');

    if (generateForm) {
        generateForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const buyer = {
                name:      document.getElementById('buyerName').value,
                gstNumber: document.getElementById('buyerGst').value,
                address:   document.getElementById('buyerAddress').value,
                state:     document.getElementById('buyerState').value,
                stateCode: document.getElementById('buyerStateCode').value
            };

            const qty    = parseFloat(document.getElementById('itemQty').value)  || 0;
            const rate   = parseFloat(document.getElementById('itemRate').value) || 0;
            const gstPct = parseFloat(document.getElementById('itemGst').value)  || 0;

            const items = [{
                name: document.getElementById('itemName').value,
                hsnCode: '1234',
                quantity: qty,
                rate: rate,
                gstPercentage: gstPct
            }];

            const subtotal  = qty * rate;
            const taxAmount = (subtotal * gstPct) / 100;
            const isIntraState = buyer.stateCode === '29';
            const taxes = { cgst: 0, sgst: 0, igst: 0 };

            if (isIntraState) { taxes.cgst = taxAmount / 2; taxes.sgst = taxAmount / 2; }
            else              { taxes.igst = taxAmount; }

            const totalAmount = subtotal + taxes.cgst + taxes.sgst + taxes.igst;

            try {
                const response = await fetch('/api/invoice/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ buyer, items, subtotal, taxes, totalAmount, isIntraState })
                });
                const data = await response.json();

                if (response.ok) {
                    document.getElementById('resRefId').innerText    = data.referenceNumber;
                    document.getElementById('resTimestamp').innerText = new Date(data.timestamp).toLocaleString();
                    document.getElementById('resQrCode').src          = data.qrCodeDataUri;
                    generationResult.classList.remove('hidden');
                } else {
                    alert('Generation Failed: ' + data.message);
                }
            } catch (err) {
                console.error(err);
                alert('Error connecting to server.');
            }
        });
    }

    // Copy reference ID convenience
    const copyRefBtn = document.getElementById('copyRefBtn');
    if (copyRefBtn) {
        copyRefBtn.addEventListener('click', () => {
            const refId = document.getElementById('resRefId').innerText;
            navigator.clipboard.writeText(refId);
            const scanInput = document.getElementById('scanRefId');
            if (scanInput) scanInput.value = refId;
            copyRefBtn.innerText = 'Copied & Pasted!';
            setTimeout(() => copyRefBtn.innerText = 'Copy Reference ID', 2000);
        });
    }

    // ===== Application 2: Verification Scanner =====
    const verifyForm         = document.getElementById('verifyForm');
    const verificationResult = document.getElementById('verificationResult');

    if (verifyForm) {
        verifyForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const refId = document.getElementById('scanRefId').value.trim();
            if (!refId) return;

            try {
                const response = await fetch(`/api/invoice/verify/${refId}`);
                const data     = await response.json();

                verificationResult.classList.remove('hidden');
                const statusBanner = document.getElementById('statusBanner');
                const detailsDiv   = document.getElementById('invoiceDetails');

                if (response.ok) {
                    statusBanner.className = 'status-banner status-success';
                    statusBanner.innerHTML = 'VALID: Authentic Govt. Record';

                    const inv = data.data;

                    // Store for ML analysis and reveal the ML card (scanner page)
                    lastVerifiedInvoice = inv;
                    const mlCard = document.getElementById('mlAnalysisCard');
                    if (mlCard) {
                        mlCard.classList.remove('hidden');
                        // Reset any previous ML results when a new invoice is scanned
                        document.getElementById('mlResults').classList.add('hidden');
                    }

                    detailsDiv.innerHTML = `
                        <div style="font-weight:600; font-size:1rem; margin-bottom:1rem;">Invoice #${inv.invoiceId}</div>
                        <div class="detail-row">
                            <span class="detail-label">Customer Name</span>
                            <span class="detail-value">${inv.buyer.name}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Customer Address</span>
                            <span class="detail-value">${inv.buyer.address}, ${inv.buyer.state}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Buyer GSTIN</span>
                            <span class="detail-value">${inv.buyer.gstNumber}</span>
                        </div>
                        <div class="totals-section">
                            <div class="totals-row"><span>Subtotal</span><span>₹${inv.subtotal.toLocaleString('en-IN')}</span></div>
                            ${inv.isIntraState ? `
                            <div class="totals-row"><span>CGST</span><span>₹${inv.taxes.cgst.toLocaleString('en-IN',{maximumFractionDigits:2})}</span></div>
                            <div class="totals-row"><span>SGST</span><span>₹${inv.taxes.sgst.toLocaleString('en-IN',{maximumFractionDigits:2})}</span></div>` : `
                            <div class="totals-row"><span>IGST</span><span>₹${inv.taxes.igst.toLocaleString('en-IN',{maximumFractionDigits:2})}</span></div>`}
                            <div class="totals-row bold"><span>Total Amount</span><span>₹${inv.totalAmount.toLocaleString('en-IN',{maximumFractionDigits:2})}</span></div>
                        </div>`;
                } else {
                    statusBanner.className = 'status-banner status-error';
                    statusBanner.innerHTML = 'ALERT: Unregistered / Fake Reference ID';

                    // Hide ML card — no valid invoice to analyze
                    lastVerifiedInvoice = null;
                    const mlCard = document.getElementById('mlAnalysisCard');
                    if (mlCard) mlCard.classList.add('hidden');

                    detailsDiv.innerHTML = `
                        <div class="detail-row">
                            <span class="detail-label">Scanned Ref</span>
                            <span class="detail-value monospaced">${refId}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Error</span>
                            <span class="detail-value">No DB record found</span>
                        </div>`;
                }
            } catch (err) {
                console.error(err);
                alert('Error connecting to verification server.');
            }
        });
    }

    // ===== ML Fraud Detection =====

    function buildInvoiceFromForm() {
        const buyer = {
            name:      document.getElementById('buyerName').value,
            gstNumber: document.getElementById('buyerGst').value,
            address:   document.getElementById('buyerAddress').value,
            state:     document.getElementById('buyerState').value,
            stateCode: document.getElementById('buyerStateCode').value
        };
        const qty    = parseFloat(document.getElementById('itemQty').value)  || 0;
        const rate   = parseFloat(document.getElementById('itemRate').value) || 0;
        const gstPct = parseFloat(document.getElementById('itemGst').value)  || 0;
        const subtotal  = qty * rate;
        const taxAmount = (subtotal * gstPct) / 100;
        const isIntraState = buyer.stateCode === '29';
        const taxes = { cgst: 0, sgst: 0, igst: 0 };
        if (isIntraState) { taxes.cgst = taxAmount / 2; taxes.sgst = taxAmount / 2; }
        else              { taxes.igst = taxAmount; }
        const totalAmount = subtotal + taxes.cgst + taxes.sgst + taxes.igst;
        return { buyer, items: [{ name: document.getElementById('itemName').value, hsnCode: '1234', quantity: qty, rate, gstPercentage: gstPct }], subtotal, taxes, totalAmount, isIntraState };
    }

    function verdictClass(v) {
        return v === 'HIGH RISK' ? 'verdict-high' : v === 'MEDIUM RISK' ? 'verdict-medium' : 'verdict-low';
    }

    function fillClass(v) {
        return v === 'HIGH RISK' ? 'fill-high' : v === 'MEDIUM RISK' ? 'fill-medium' : 'fill-low';
    }

    function renderResults(data, source) {
        const badge = document.getElementById('analysisBadge');
        badge.className   = `analysis-badge ${source}`;
        badge.textContent = source === 'server'
            ? 'Way 1 — Server-Side (Node.js)'
            : 'Way 2 — In-Browser (Client-Side JS)';

        const score   = data.ensembleScore;
        const verdict = data.ensembleVerdict;

        document.getElementById('ensembleScore').textContent   = score;
        const verdictEl = document.getElementById('ensembleVerdict');
        verdictEl.textContent = verdict;
        verdictEl.className   = `ensemble-verdict ${verdictClass(verdict)}`;
        document.getElementById('riskBarFill').style.left = `${score}%`;

        const grid = document.getElementById('modelsGrid');
        grid.innerHTML = '';

        data.models.forEach(m => {
            let itemsHtml = '';

            if (m.anomalies) {
                itemsHtml = m.anomalies.map(a =>
                    `<div class="model-item"><span class="model-item-icon neutral">◦</span><span>${a}</span></div>`
                ).join('');
                if (m.details) {
                    itemsHtml += `<div class="model-item"><span class="model-item-icon neutral">◦</span><span>z-scores: amount=${m.details.zAmount}, rate=${m.details.zRate}, qty=${m.details.zQty}</span></div>`;
                }
            } else if (m.rules) {
                itemsHtml = m.rules.map(r =>
                    `<div class="model-item">
                        <span class="model-item-icon ${r.status === 'PASS' ? 'pass' : 'fail'}">${r.status === 'PASS' ? '✓' : '✗'}</span>
                        <span><strong>${r.rule}:</strong> ${r.detail}</span>
                     </div>`
                ).join('');
            } else if (m.contributions) {
                itemsHtml = m.contributions.map(c =>
                    `<div class="model-item">
                        <span class="model-item-icon neutral">◦</span>
                        <span><strong>${c.feature}:</strong> val=${c.value}, w=${c.weight}, Δ=${c.score}</span>
                     </div>`
                ).join('');
                if (m.fraudProbability !== undefined) {
                    itemsHtml += `<div class="model-item"><span class="model-item-icon neutral">◦</span><span>Fraud probability: ${(m.fraudProbability * 100).toFixed(2)}%</span></div>`;
                }
            }

            grid.innerHTML += `
                <div class="model-card">
                    <div class="model-card-header">
                        <div class="model-name">${m.model}</div>
                        <div class="model-score-badge">${m.riskScore}</div>
                    </div>
                    <div class="model-mini-bar">
                        <div class="model-mini-fill ${fillClass(m.verdict)}" style="width:${m.riskScore}%"></div>
                    </div>
                    <div class="model-items">${itemsHtml}</div>
                </div>`;
        });

        document.getElementById('mlResults').classList.remove('hidden');
    }

    // Returns the invoice payload for ML analysis:
    // on the scanner page use the last verified invoice; on the billing page use the form.
    function getInvoiceForML() {
        if (lastVerifiedInvoice) return lastVerifiedInvoice;
        return buildInvoiceFromForm();
    }

    const btnServer = document.getElementById('btnServerAnalysis');
    if (btnServer) {
        btnServer.addEventListener('click', async () => {
            const invoice = getInvoiceForML();
            if (!invoice) { alert('Verify an invoice first.'); return; }
            try {
                const res  = await fetch('/api/fraud/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(invoice)
                });
                const data = await res.json();
                if (res.ok) renderResults(data, 'server');
                else alert('Server analysis failed: ' + data.message);
            } catch (err) {
                console.error(err);
                alert('Could not reach server.');
            }
        });
    }

    const btnClient = document.getElementById('btnClientAnalysis');
    if (btnClient) {
        btnClient.addEventListener('click', () => {
            const invoice = getInvoiceForML();
            if (!invoice) { alert('Verify an invoice first.'); return; }
            const data = FraudModels.runAll(invoice);
            renderResults(data, 'client');
        });
    }

});
