// Client-side ML fraud detection models (Way 2 — runs entirely in browser)
const FraudModels = (() => {
  const BASELINE = {
    avgAmount: 15000, stdAmount: 12000,
    avgRate: 2000,    stdRate: 1500,
    avgQty: 5,        stdQty: 4,
    validGstRates: [0, 5, 12, 18, 28]
  };

  function zScore(v, mean, std) {
    return std === 0 ? 0 : Math.abs((v - mean) / std);
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

  function runAll(invoice) {
    const models = [
      model1_ZScoreAnomaly(invoice),
      model2_DecisionTree(invoice),
      model3_LogisticScoring(invoice)
    ];
    const avg = Math.round(models.reduce((s, m) => s + m.riskScore, 0) / models.length);
    return {
      status: 'Success',
      ensembleScore:   avg,
      ensembleVerdict: avg >= 60 ? 'HIGH RISK' : avg >= 30 ? 'MEDIUM RISK' : 'LOW RISK',
      models
    };
  }

  return { runAll };
})();
