/* ============================================================
   STOCK LAB — Simulador de Estratégia de Compra e Venda de Ações
   Engine (custo médio móvel japonês, caixa, fiscal, break-even,
   simulador de ciclos) + UI, tudo client-side com localStorage.
   ============================================================ */

const STORAGE_KEY = "stocklab_portfolio_v1";
const TAXCFG_KEY = "stocklab_taxconfig_v1";
const ACTIVE_TICKER_KEY = "stocklab_active_ticker_v1";
const FXCFG_KEY = "stocklab_fxconfig_v1";

// Cotação de referência do dia em que este build foi gerado (23/08/2026).
// Editável pelo usuário nas configurações; serve só como valor inicial.
const DEFAULT_USD_JPY_RATE = 158.95;

/* ---------------- Utilidades ---------------- */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtMoney(v, currency = "JPY", decimals = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const symbol = currency === "USD" ? "$" : "¥";
  const sign = v < 0 ? "-" : "";
  // Convenção internacional (não brasileira): vírgula = milhar, ponto = decimal.
  // Vale tanto para USD quanto para JPY.
  return `${sign}${symbol}${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fmtYen(v, decimals = 2) {
  return fmtMoney(v, "JPY", decimals);
}

function fmtPct(v) {
  return `${(v * 100).toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}%`;
}

function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 2400);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- Estado / Storage ---------------- */

function defaultTaxConfig() {
  return { nationalTax: 0.15315, localTax: 0.05, reconstructionTax: 0.0 };
}

function effectiveRate(cfg) {
  return cfg.nationalTax + cfg.localTax + cfg.reconstructionTax;
}

function loadPortfolio() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tickers: {} };
    const parsed = JSON.parse(raw);
    if (!parsed.tickers) return { tickers: {} };
    return parsed;
  } catch (e) {
    console.error("Falha ao carregar portfolio", e);
    return { tickers: {} };
  }
}

function savePortfolio() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE.portfolio));
}

function loadTaxConfig() {
  try {
    const raw = localStorage.getItem(TAXCFG_KEY);
    if (!raw) return defaultTaxConfig();
    return { ...defaultTaxConfig(), ...JSON.parse(raw) };
  } catch (e) {
    return defaultTaxConfig();
  }
}

function saveTaxConfig() {
  localStorage.setItem(TAXCFG_KEY, JSON.stringify(STATE.taxConfig));
}

function loadFxConfig() {
  try {
    const raw = localStorage.getItem(FXCFG_KEY);
    if (!raw) return { usdJpy: DEFAULT_USD_JPY_RATE };
    const parsed = JSON.parse(raw);
    return { usdJpy: parsed.usdJpy || DEFAULT_USD_JPY_RATE };
  } catch (e) {
    return { usdJpy: DEFAULT_USD_JPY_RATE };
  }
}

function saveFxConfig() {
  localStorage.setItem(FXCFG_KEY, JSON.stringify(STATE.fxConfig));
}

const STATE = {
  portfolio: loadPortfolio(),
  taxConfig: loadTaxConfig(),
  fxConfig: loadFxConfig(),
  activeTicker: localStorage.getItem(ACTIVE_TICKER_KEY) || null,
  activeTab: "trade",
};

function newTickerState(ticker, currency = "JPY") {
  return {
    ticker,
    currency,          // 'JPY' ou 'USD'
    quantity: 0,
    avgCost: 0,         // custo médio na moeda nativa do ticker
    avgCostJPY: 0,       // custo médio em JPY (igual a avgCost se currency === 'JPY')
    cashBalance: 0,      // caixa na moeda nativa do ticker
    initialCapital: 0,   // capital inicial na moeda nativa do ticker
    marketPriceRef: 0,   // cotação atual de referência, própria deste ticker
    transactions: [],
  };
}

function getTickerState(ticker, currency = "JPY") {
  if (!STATE.portfolio.tickers[ticker]) {
    STATE.portfolio.tickers[ticker] = newTickerState(ticker, currency);
  }
  return STATE.portfolio.tickers[ticker];
}

/* ---------------- Tax / Average-Cost Engine ---------------- */
/* Custo médio móvel (não FIFO/LIFO): compra recalcula média
   ponderada; venda debita a quantidade ao custo médio vigente
   sem alterar o custo médio por ação. */

function applyBuy(ts, quantity, unitPrice, fxRate = 1, fees = 0) {
  const qtyBefore = ts.quantity;
  const avgBefore = ts.avgCost;
  const existingTotal = qtyBefore * avgBefore;
  const purchaseTotal = quantity * unitPrice;
  // Para fins fiscais, a corretagem/taxas da compra é incorporada ao
  // custo de aquisição (aumenta o custo médio) — dedutível por lei.
  const purchaseTotalForTax = purchaseTotal + fees;
  const qtyAfter = qtyBefore + quantity;
  const avgAfter = qtyAfter > 0 ? (existingTotal + purchaseTotalForTax) / qtyAfter : 0;

  ts.quantity = qtyAfter;
  ts.avgCost = avgAfter;

  // Faixa paralela em JPY (mesmo algoritmo de custo médio, preços convertidos).
  // Para tickers em JPY, fxRate=1 e avgCostJPY === avgCost sempre.
  const unitPriceJPY = unitPrice * fxRate;
  const feesJPY = fees * fxRate;
  const avgBeforeJPY = ts.avgCostJPY;
  const existingTotalJPY = qtyBefore * avgBeforeJPY;
  const purchaseTotalJPY = quantity * unitPriceJPY + feesJPY;
  const avgAfterJPY = qtyAfter > 0 ? (existingTotalJPY + purchaseTotalJPY) / qtyAfter : 0;
  ts.avgCostJPY = avgAfterJPY;

  return {
    qtyBefore, qtyAfter, avgBefore, avgAfter, grossCost: purchaseTotal,
    avgBeforeJPY, avgAfterJPY, unitPriceJPY,
  };
}

function applySell(ts, quantity, unitPrice, fxRate = 1, fees = 0) {
  if (quantity > ts.quantity) {
    throw new Error(`Venda de ${quantity} ações excede a posição atual de ${ts.quantity}`);
  }
  const qtyBefore = ts.quantity;
  const avgBefore = ts.avgCost;
  const grossProceeds = quantity * unitPrice;
  // Para fins fiscais, a corretagem/taxas da venda reduz a receita
  // líquida tributável — dedutível por lei.
  const netProceedsForTax = grossProceeds - fees;
  const taxCostBasis = quantity * avgBefore;
  const taxResult = netProceedsForTax - taxCostBasis;
  const qtyAfter = qtyBefore - quantity;

  ts.quantity = qtyAfter;
  // custo médio por ação não muda numa venda

  // Resultado fiscal em JPY (o que a lei japonesa exige, independente da
  // moeda do ativo). Para tickers em JPY, isso é idêntico ao taxResult nativo.
  const avgBeforeJPY = ts.avgCostJPY;
  const unitPriceJPY = unitPrice * fxRate;
  const feesJPY = fees * fxRate;
  const grossProceedsJPY = quantity * unitPriceJPY;
  const netProceedsJPYForTax = grossProceedsJPY - feesJPY;
  const taxCostBasisJPY = quantity * avgBeforeJPY;
  const taxResultJPY = netProceedsJPYForTax - taxCostBasisJPY;
  // avgCostJPY não muda numa venda, igual ao nativo

  return {
    qtyBefore, qtyAfter, avgBefore, avgAfter: avgBefore, grossProceeds, taxCostBasis, taxResult,
    avgBeforeJPY, avgAfterJPY: avgBeforeJPY, taxCostBasisJPY, taxResultJPY, unitPriceJPY,
  };
}

/* ---------------- Ledger: orquestra buy/sell + registro ---------------- */

function nextTxnId(ts) {
  return ts.transactions.length + 1;
}

/* Aplica uma compra/venda a um objeto de estado (ts) qualquer — pode ser
   o ticker real (via getTickerState) ou uma CÓPIA usada só para prévia,
   sem persistir nada. Quem chama decide se e quando salvar. */

function applyBuyTxn(ts, quantity, unitPrice, fees = 0, date = null, fxRate = null) {
  const effFxRate = ts.currency === "USD" ? (fxRate || STATE.fxConfig.usdJpy) : 1;
  const isFirstBuy = ts.quantity === 0 && ts.transactions.length === 0;
  const r = applyBuy(ts, quantity, unitPrice, effFxRate, fees);
  const cashFlow = -(r.grossCost + fees);
  ts.cashBalance += cashFlow;
  if (isFirstBuy) ts.initialCapital = r.grossCost;

  const txn = {
    id: nextTxnId(ts),
    date: date || todayISO(),
    ticker: ts.ticker,
    side: "BUY",
    quantity,
    unitPrice,
    fees,
    fxRate: effFxRate,
    grossValue: r.grossCost,
    netValue: r.grossCost + fees,
    quantityBefore: r.qtyBefore,
    quantityAfter: r.qtyAfter,
    avgCostBefore: r.avgBefore,
    avgCostAfter: r.avgAfter,
    avgCostJPYBefore: r.avgBeforeJPY,
    avgCostJPYAfter: r.avgAfterJPY,
    taxCostBasis: null,
    taxResult: null,
    taxResultJPY: null,
    cashFlow,
    cashBalanceAfter: ts.cashBalance,
  };
  ts.transactions.push(txn);
  return txn;
}

function applySellTxn(ts, quantity, unitPrice, fees = 0, date = null, fxRate = null) {
  const effFxRate = ts.currency === "USD" ? (fxRate || STATE.fxConfig.usdJpy) : 1;
  const r = applySell(ts, quantity, unitPrice, effFxRate, fees);
  const cashFlow = r.grossProceeds - fees;
  ts.cashBalance += cashFlow;

  const txn = {
    id: nextTxnId(ts),
    date: date || todayISO(),
    ticker: ts.ticker,
    side: "SELL",
    quantity,
    unitPrice,
    fees,
    fxRate: effFxRate,
    grossValue: r.grossProceeds,
    netValue: r.grossProceeds - fees,
    quantityBefore: r.qtyBefore,
    quantityAfter: r.qtyAfter,
    avgCostBefore: r.avgBefore,
    avgCostAfter: r.avgAfter,
    avgCostJPYBefore: r.avgBeforeJPY,
    avgCostJPYAfter: r.avgAfterJPY,
    taxCostBasis: r.taxCostBasis,
    taxResult: r.taxResult,
    taxResultJPY: r.taxResultJPY,
    cashFlow,
    cashBalanceAfter: ts.cashBalance,
  };
  ts.transactions.push(txn);
  return txn;
}

function buyOnTicker(ticker, quantity, unitPrice, fees = 0, date = null, fxRate = null) {
  const ts = getTickerState(ticker);
  const txn = applyBuyTxn(ts, quantity, unitPrice, fees, date, fxRate);
  savePortfolio();
  return txn;
}

function sellOnTicker(ticker, quantity, unitPrice, fees = 0, date = null, fxRate = null) {
  const ts = getTickerState(ticker);
  const txn = applySellTxn(ts, quantity, unitPrice, fees, date, fxRate);
  savePortfolio();
  return txn;
}

/* ---------------- Economic Metrics ---------------- */

function snapshotFromState(ts) {
  return {
    currency: ts.currency,
    initialCapital: ts.initialCapital,
    cashBalance: ts.cashBalance,
    quantity: ts.quantity,
    taxAvgCost: ts.avgCost,
    taxAvgCostJPY: ts.avgCostJPY,
  };
}

function snapshotOf(ticker) {
  return snapshotFromState(getTickerState(ticker));
}

function breakEvenFiscal(snap) {
  return snap.taxAvgCost;
}

function breakEvenEconomic(snap) {
  if (snap.quantity === 0) return null;
  // O caixa acumulado já inclui o desembolso da compra inicial (fica negativo
  // logo de cara). Por isso o break-even é o preço que zera o resultado
  // econômico total: cashBalance + quantidade*p = 0  →  p = -cashBalance/quantidade.
  // (NÃO subtrair capital inicial de novo — ele já está embutido no caixa.)
  return -snap.cashBalance / snap.quantity;
}

function targetPriceForProfit(snap, desiredProfit) {
  if (snap.quantity === 0) return null;
  // cashBalance + quantidade*p = lucro desejado  →  p = (lucro - cashBalance)/quantidade
  return (desiredProfit - snap.cashBalance) / snap.quantity;
}

function patrimony(snap, marketPrice) {
  // Patrimônio real = (capital inicial + caixa acumulado) [= dinheiro que
  // sobrou em conta] + valor de mercado da posição restante.
  return snap.initialCapital + snap.cashBalance + snap.quantity * marketPrice;
}

function economicResult(snap, marketPrice) {
  return patrimony(snap, marketPrice) - snap.initialCapital;
}

function scenarioTable(snap, prices) {
  return prices.map((p) => {
    const positionValue = snap.quantity * p;
    const total = snap.initialCapital + snap.cashBalance + positionValue;
    const profit = total - snap.initialCapital;
    return { price: p, positionValue, cash: snap.cashBalance, patrimony: total, profit };
  });
}

/* ---------------- Tax Report (imposto estimado + compensação) ---------------- */

function buildTaxReport(transactions, taxConfig) {
  let gains = 0;
  let losses = 0;
  for (const t of transactions) {
    if (t.side !== "SELL" || t.taxResultJPY === null || t.taxResultJPY === undefined) continue;
    if (t.taxResultJPY >= 0) gains += t.taxResultJPY;
    else losses += -t.taxResultJPY;
  }
  const net = gains - losses;
  const netTaxableResult = net > 0 ? net : 0;
  const carriedLoss = net > 0 ? 0 : -net;
  const estimatedTax = netTaxableResult * effectiveRate(taxConfig);
  return {
    realizedGains: gains,
    realizedLosses: losses,
    totalRealizedResult: gains - losses,
    netTaxableResult,
    carriedLoss,
    estimatedTax,
  };
}

/* ---------------- Simulator: ciclos automáticos ---------------- */

/* Roda os ciclos num objeto de estado (ts) qualquer, sem persistir nada.
   Usado tanto pela prévia (num clone) quanto pela aplicação real. */
function runCyclesOnState(ts, buyQty, buyPrice, sellQty, sellPrice, cycles, buyFxRate = null, sellFxRate = null) {
  const results = [];
  for (let i = 1; i <= cycles; i++) {
    if (ts.quantity < sellQty) break;
    applyBuyTxn(ts, buyQty, buyPrice, 0, null, buyFxRate);
    const sellTxn = applySellTxn(ts, sellQty, sellPrice, 0, null, sellFxRate);
    results.push(sellTxn);
  }
  return results;
}

function runCycles(ticker, buyQty, buyPrice, sellQty, sellPrice, cycles, buyFxRate = null, sellFxRate = null) {
  const ts = getTickerState(ticker);
  const results = runCyclesOnState(ts, buyQty, buyPrice, sellQty, sellPrice, cycles, buyFxRate, sellFxRate);
  if (results.length < cycles) {
    showToast(`Parado no ciclo ${results.length + 1}: posição insuficiente para vender.`, true);
  }
  savePortfolio();
  return results;
}

/* Prévia: roda os ciclos numa CÓPIA do ticker (clone via JSON), sem tocar
   no estado real nem no localStorage. Devolve o clone já simulado, pra
   comparação antes/depois na UI. */
function previewCycles(ticker, buyQty, buyPrice, sellQty, sellPrice, cycles, buyFxRate = null, sellFxRate = null) {
  const real = getTickerState(ticker);
  const clone = JSON.parse(JSON.stringify(real));
  const results = runCyclesOnState(clone, buyQty, buyPrice, sellQty, sellPrice, cycles, buyFxRate, sellFxRate);
  return { clone, results, cyclesRequested: cycles, cyclesCompleted: results.length };
}

/* Aplica de vez uma prévia já calculada: substitui o ticker real pelo
   clone simulado (que já contém todo o histórico anterior + os novos
   ciclos) e persiste. */
function commitPreview(ticker, clone) {
  STATE.portfolio.tickers[ticker] = clone;
  savePortfolio();
}

/* ---------------- CSV Import (formato: date,ticker,side,quantity,price,fee,currency) ---------------- */

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i] !== undefined ? cols[i] : ""));
    return row;
  });
  return { header, rows };
}

function importCSVText(text) {
  const { header, rows } = parseCSV(text);
  const required = ["date", "ticker", "side", "quantity", "price"];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`CSV sem colunas obrigatórias: ${missing.join(", ")}`);
  }

  let count = 0;
  for (const row of rows) {
    const ticker = (row.ticker || "").toUpperCase();
    const side = (row.side || "").toUpperCase();
    const quantity = parseInt(row.quantity, 10);
    const price = parseFloat(row.price);
    const fee = row.fee ? parseFloat(row.fee) : 0;
    const date = row.date || todayISO();
    const currency = (row.currency || "JPY").toUpperCase() === "USD" ? "USD" : "JPY";
    const fxRate = row.fxrate ? parseFloat(row.fxrate) : null;

    if (!ticker || !quantity || Number.isNaN(price)) continue;

    // Garante que o ticker já exista com a moeda correta antes da 1ª operação
    getTickerState(ticker, currency);

    if (side === "BUY") {
      buyOnTicker(ticker, quantity, price, fee, date, fxRate);
    } else if (side === "SELL") {
      sellOnTicker(ticker, quantity, price, fee, date, fxRate);
    } else {
      throw new Error(`Lado de operação desconhecido: "${row.side}"`);
    }
    count++;
  }
  return count;
}

/* ---------------- Export: CSV ---------------- */

function exportCSV(ticker) {
  const ts = getTickerState(ticker);
  const cols = [
    "id", "date", "ticker", "side", "quantity", "unitPrice", "fees", "fxRate",
    "grossValue", "netValue", "quantityBefore", "quantityAfter",
    "avgCostBefore", "avgCostAfter", "taxCostBasis", "taxResult", "taxResultJPY",
    "cashFlow", "cashBalanceAfter",
  ];
  const lines = [`# currency=${ts.currency}`, cols.join(",")];
  for (const t of ts.transactions) {
    lines.push(cols.map((c) => (t[c] === null || t[c] === undefined ? "" : t[c])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `${ticker}_operacoes.csv`);
}

/* ---------------- Export: Excel (SheetJS) ---------------- */

function exportExcel(ticker) {
  const ts = getTickerState(ticker);
  const snap = snapshotOf(ticker);
  const report = buildTaxReport(ts.transactions, STATE.taxConfig);
  const be = breakEvenEconomic(snap);
  const isUSD = ts.currency === "USD";

  const summaryRows = [
    ["Indicador", "Valor"],
    ["Ticker", ticker],
    ["Moeda", ts.currency],
    ["Capital inicial", snap.initialCapital],
    ["Caixa acumulado", snap.cashBalance],
    ["Ações restantes", snap.quantity],
    ["Custo médio fiscal (moeda nativa)", snap.taxAvgCost],
  ];
  if (isUSD) summaryRows.push(["Custo médio fiscal (¥)", snap.taxAvgCostJPY]);
  summaryRows.push(
    ["Break-even fiscal", breakEvenFiscal(snap)],
    ["Break-even econômico", be === null ? "" : be],
    ["Ganhos fiscais realizados (¥)", report.realizedGains],
    ["Perdas fiscais realizadas (¥)", report.realizedLosses],
    ["Resultado fiscal líquido (¥)", report.totalRealizedResult],
    ["Prejuízo a compensar (¥)", report.carriedLoss],
    ["Imposto estimado (¥)", report.estimatedTax],
  );

  const txnHeader = ["ID", "Data", "Lado", "Qtd", "Preço", "Qtd antes", "Qtd depois",
     "Custo médio antes", "Custo médio depois"];
  if (isUSD) txnHeader.push("Câmbio USD/JPY");
  txnHeader.push("Resultado fiscal (¥)", "Fluxo de caixa", "Caixa acumulado");

  const txnRows = [txnHeader, ...ts.transactions.map((t) => {
    const row = [t.id, t.date, t.side, t.quantity, t.unitPrice, t.quantityBefore, t.quantityAfter,
      t.avgCostBefore, t.avgCostAfter];
    if (isUSD) row.push(t.fxRate);
    row.push(t.taxResultJPY, t.cashFlow, t.cashBalanceAfter);
    return row;
  })];

  const wb = XLSX.utils.book_new();
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  const wsTxns = XLSX.utils.aoa_to_sheet(txnRows);
  XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo");
  XLSX.utils.book_append_sheet(wb, wsTxns, "Operações");
  XLSX.writeFile(wb, `${ticker}_relatorio.xlsx`);
}

/* ---------------- Export: PDF (jsPDF + autotable) ---------------- */

function exportPDF(ticker) {
  const ts = getTickerState(ticker);
  const snap = snapshotOf(ticker);
  const report = buildTaxReport(ts.transactions, STATE.taxConfig);
  const be = breakEvenEconomic(snap);
  const cur = ts.currency;
  const isUSD = cur === "USD";

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(`Stock Lab — ${ticker} (${cur})`, 14, 18);

  doc.setFontSize(11);
  const summaryBody = [
    ["Capital inicial", fmtMoney(snap.initialCapital, cur)],
    ["Caixa acumulado", fmtMoney(snap.cashBalance, cur)],
    ["Ações restantes", String(snap.quantity)],
    ["Custo médio fiscal", isUSD
      ? `${fmtMoney(snap.taxAvgCost, "USD", 4)} (${fmtMoney(snap.taxAvgCostJPY, "JPY", 2)})`
      : fmtMoney(snap.taxAvgCost, "JPY", 4)],
    ["Break-even fiscal", fmtMoney(breakEvenFiscal(snap), cur, 4)],
    ["Break-even econômico", be === null ? "—" : fmtMoney(be, cur, 4)],
    ["Ganhos fiscais realizados (¥)", fmtYen(report.realizedGains)],
    ["Perdas fiscais realizadas (¥)", fmtYen(report.realizedLosses)],
    ["Resultado fiscal líquido (¥)", fmtYen(report.totalRealizedResult)],
    ["Prejuízo a compensar (¥)", fmtYen(report.carriedLoss)],
    ["Imposto estimado (¥)", fmtYen(report.estimatedTax)],
  ];

  doc.autoTable({
    startY: 24,
    head: [["Indicador", "Valor"]],
    body: summaryBody,
    theme: "grid",
    headStyles: { fillColor: [28, 35, 49] },
    styles: { fontSize: 9 },
  });

  const txnHead = isUSD
    ? [["ID", "Data", "Lado", "Qtd", "Preço", "Custo médio", "Câmbio", "Res. fiscal (¥)", "Caixa"]]
    : [["ID", "Data", "Lado", "Qtd", "Preço", "Custo médio", "Res. fiscal", "Caixa"]];

  const txnBody = ts.transactions.map((t) => {
    const row = [t.id, t.date, t.side, t.quantity, fmtMoney(t.unitPrice, cur), fmtMoney(t.avgCostAfter, cur, 4)];
    if (isUSD) row.push(`¥${t.fxRate.toFixed(2)}`);
    row.push(t.taxResultJPY === null ? "—" : fmtYen(t.taxResultJPY), fmtMoney(t.cashBalanceAfter, cur));
    return row;
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
    head: txnHead,
    body: txnBody,
    theme: "grid",
    headStyles: { fillColor: [28, 35, 49] },
    styles: { fontSize: 7 },
  });

  doc.setFontSize(8);
  doc.text(
    "Simulador educacional — não substitui cálculo fiscal profissional. Resultado fiscal sempre em ¥, por lei japonesa.",
    14,
    doc.internal.pageSize.getHeight() - 10
  );

  doc.save(`${ticker}_relatorio.pdf`);
}

/* ============================================================
   UI
   ============================================================ */

const CHART_REFS = {}; // guarda instâncias Chart.js para destruir ao re-renderizar

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") { if (v) e.setAttribute(k, ""); } // atributo booleano: só existe se true
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return e;
}

function openModal(contentEl) {
  const overlay = document.getElementById("modalOverlay");
  const content = document.getElementById("modalContent");
  content.innerHTML = "";
  content.appendChild(el("button", { class: "modal-close", onclick: closeModal }, "✕"));
  content.appendChild(contentEl);
  overlay.classList.add("show");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
}

document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

/* ---------------- Ticker select / criação ---------------- */

function renderTickerSelect() {
  const select = document.getElementById("tickerSelect");
  const tickers = Object.keys(STATE.portfolio.tickers);
  select.innerHTML = "";

  if (tickers.length === 0) {
    select.appendChild(el("option", { value: "" }, "Nenhum ticker cadastrado"));
    select.disabled = true;
    STATE.activeTicker = null;
    return;
  }
  select.disabled = false;
  tickers.forEach((t) => select.appendChild(el("option", { value: t }, t)));

  if (!STATE.activeTicker || !tickers.includes(STATE.activeTicker)) {
    STATE.activeTicker = tickers[0];
  }
  select.value = STATE.activeTicker;
}

document.getElementById("tickerSelect").addEventListener("change", (e) => {
  STATE.activeTicker = e.target.value;
  localStorage.setItem(ACTIVE_TICKER_KEY, STATE.activeTicker);
  SIM_PREVIEW = null;
  renderMain();
});

document.getElementById("btnNewTicker").addEventListener("click", () => {
  const wrap = el("div", {}, [
    el("h3", {}, "Novo ticker"),
    el("div", { class: "field" }, [
      el("label", {}, "Código do ticker"),
      el("input", { id: "newTickerCode", placeholder: "ex: 7203 ou AAPL" }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Moeda"),
      el("select", { id: "newTickerCurrency" }, [
        el("option", { value: "JPY" }, "¥ JPY (ação japonesa)"),
        el("option", { value: "USD" }, "$ USD (ação americana)"),
      ]),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Quantidade inicial"),
      el("input", { id: "newTickerQty", type: "number", value: "100", min: "0" }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Preço médio inicial"),
      el("input", { id: "newTickerPrice", type: "number", value: "270", step: "0.01", min: "0" }),
    ]),
    el("div", { style: "margin-top:16px;" }, [
      el("button", {
        onclick: () => {
          const code = document.getElementById("newTickerCode").value.trim().toUpperCase();
          const currency = document.getElementById("newTickerCurrency").value;
          const qty = parseInt(document.getElementById("newTickerQty").value, 10) || 0;
          const price = parseFloat(document.getElementById("newTickerPrice").value) || 0;
          if (!code) {
            showToast("Informe o código do ticker.", true);
            return;
          }
          if (STATE.portfolio.tickers[code]) {
            showToast("Esse ticker já existe.", true);
            return;
          }
          getTickerState(code, currency);
          if (qty > 0) buyOnTicker(code, qty, price);
          savePortfolio();
          STATE.activeTicker = code;
          localStorage.setItem(ACTIVE_TICKER_KEY, code);
          closeModal();
          renderTickerSelect();
          renderMain();
          showToast(`Ticker ${code} criado.`);
        },
      }, "CRIAR TICKER"),
    ]),
  ]);
  openModal(wrap);
});

document.getElementById("btnDeleteTicker").addEventListener("click", () => {
  const ticker = STATE.activeTicker;
  if (!ticker) {
    showToast("Nenhum ticker selecionado.", true);
    return;
  }
  const ts = getTickerState(ticker);
  const wrap = el("div", {}, [
    el("h3", {}, `Excluir ${ticker}`),
    el("p", { class: "help-text" },
      `Isso apaga permanentemente o ticker ${ticker}, incluindo suas ${ts.transactions.length} operação(ões) e todo o histórico. Não pode ser desfeito.`),
    el("div", { class: "field" }, [
      el("label", {}, `Digite "${ticker}" para confirmar`),
      el("input", { id: "deleteConfirmInput", placeholder: ticker }),
    ]),
    el("div", { style: "margin-top:16px;display:flex;gap:8px;" }, [
      el("button", { class: "secondary", onclick: closeModal }, "CANCELAR"),
      el("button", {
        class: "danger",
        onclick: () => {
          const typed = document.getElementById("deleteConfirmInput").value.trim().toUpperCase();
          if (typed !== ticker) {
            showToast("O código digitado não confere.", true);
            return;
          }
          delete STATE.portfolio.tickers[ticker];
          savePortfolio();
          const remaining = Object.keys(STATE.portfolio.tickers);
          STATE.activeTicker = remaining.length > 0 ? remaining[0] : null;
          localStorage.setItem(ACTIVE_TICKER_KEY, STATE.activeTicker || "");
          closeModal();
          renderTickerSelect();
          renderMain();
          showToast(`Ticker ${ticker} excluído.`);
        },
      }, "EXCLUIR PERMANENTEMENTE"),
    ]),
  ]);
  openModal(wrap);
});

/* ---------------- Configurações fiscais ---------------- */

document.getElementById("btnSettings").addEventListener("click", () => {
  const cfg = STATE.taxConfig;
  const wrap = el("div", {}, [
    el("h3", {}, "Configuração fiscal"),
    el("div", { class: "field" }, [
      el("label", {}, "Imposto nacional (%)"),
      el("input", { id: "cfgNational", type: "number", step: "0.001", value: String(cfg.nationalTax * 100) }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Imposto local (%)"),
      el("input", { id: "cfgLocal", type: "number", step: "0.001", value: String(cfg.localTax * 100) }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Imposto de reconstrução (%)"),
      el("input", { id: "cfgRecon", type: "number", step: "0.001", value: String(cfg.reconstructionTax * 100) }),
    ]),
    el("p", { class: "help-text" }, `Alíquota efetiva atual: ${fmtPct(effectiveRate(cfg))}`),
    el("div", { class: "section-title" }, "Câmbio"),
    el("div", { class: "field" }, [
      el("label", {}, "Cotação USD/JPY (1 USD = ¥X)"),
      el("input", { id: "cfgFxRate", type: "number", step: "0.01", value: String(STATE.fxConfig.usdJpy) }),
    ]),
    el("p", { class: "help-text" }, "Usada como padrão em compras/vendas de tickers em USD, e no resultado fiscal em JPY (obrigatório por lei, independente da moeda do ativo). Ajuste para a cotação do dia da operação, se necessário."),
    el("div", { style: "margin-top:16px;" }, [
      el("button", {
        onclick: () => {
          STATE.taxConfig = {
            nationalTax: (parseFloat(document.getElementById("cfgNational").value) || 0) / 100,
            localTax: (parseFloat(document.getElementById("cfgLocal").value) || 0) / 100,
            reconstructionTax: (parseFloat(document.getElementById("cfgRecon").value) || 0) / 100,
          };
          STATE.fxConfig = {
            usdJpy: parseFloat(document.getElementById("cfgFxRate").value) || DEFAULT_USD_JPY_RATE,
          };
          saveTaxConfig();
          saveFxConfig();
          closeModal();
          renderMain();
          showToast("Configuração salva.");
        },
      }, "SALVAR"),
    ]),
  ]);
  openModal(wrap);
});

/* ---------------- Dashboard ---------------- */

function renderDashboard(container, ticker) {
  const snap = snapshotOf(ticker);
  const ts = getTickerState(ticker);
  const report = buildTaxReport(ts.transactions, STATE.taxConfig);
  const be = breakEvenEconomic(snap);
  const cur = snap.currency;
  const isUSD = cur === "USD";
  const fx = STATE.fxConfig.usdJpy;
  const refPrice = ts.marketPriceRef || 0;

  const econResultBlock = [];
  if (refPrice > 0) {
    const result = economicResult(snap, refPrice);
    const resultClass = result >= 0 ? "mint" : "danger";
    if (isUSD) {
      econResultBlock.push(metricEl(
        "Result. econ. @ cotação",
        `${fmtMoney(result, "USD")} (${fmtMoney(result * fx, "JPY", 0)})`,
        resultClass,
      ));
    } else {
      econResultBlock.push(metricEl("Result. econ. @ cotação", fmtMoney(result, "JPY"), resultClass));
    }
  } else {
    econResultBlock.push(metricEl("Result. econ. @ cotação", "—"));
  }

  const card = el("div", { class: "card" }, [
    el("h2", {}, `📊 ${ticker} ${isUSD ? "🇺🇸" : "🇯🇵"}`),
    el("div", { class: "metric-grid" }, [
      metricEl("Capital inicial", fmtMoney(snap.initialCapital, cur, 0)),
      metricEl("Caixa acumulado", fmtMoney(snap.cashBalance, cur, 0), snap.cashBalance >= 0 ? "mint" : "danger"),
      metricEl("Ações restantes", String(snap.quantity)),
    ]),
    isUSD
      ? el("p", { class: "help-text" },
          `≈ ${fmtMoney(snap.cashBalance * fx, "JPY", 0)} de caixa e ` +
          `${fmtMoney(snap.initialCapital * fx, "JPY", 0)} de capital, convertido à cotação de câmbio atual (¥${fx.toFixed(2)}/US$).`)
      : null,
    el("div", { class: "section-title" }, "Visão fiscal (sempre em ¥, por lei japonesa)"),
    el("div", { class: "metric-grid" }, [
      metricEl("Custo médio fiscal", isUSD
        ? `${fmtMoney(snap.taxAvgCost, "USD", 3)} (${fmtMoney(snap.taxAvgCostJPY, "JPY", 2)})`
        : fmtMoney(snap.taxAvgCost, "JPY", 3), "cyan"),
      metricEl("Resultado fiscal realizado", fmtMoney(report.totalRealizedResult, "JPY"), report.totalRealizedResult >= 0 ? "mint" : "danger"),
      metricEl("Imposto estimado", fmtMoney(report.estimatedTax, "JPY"), "magenta"),
    ]),
    report.carriedLoss > 0
      ? el("p", { class: "help-text" }, `Prejuízo a compensar: ${fmtMoney(report.carriedLoss, "JPY")}`)
      : null,
    el("div", { class: "section-title" }, "Visão econômica e de equilíbrio"),
    el("div", { class: "metric-grid" }, [
      metricEl("Break-even fiscal", fmtMoney(breakEvenFiscal(snap), cur, 3)),
      metricEl("Break-even econômico", be === null ? "—" : fmtMoney(be, cur, 3), "cyan"),
      ...econResultBlock,
    ]),
    el("div", { class: "field", style: "margin-top:10px;max-width:260px;" }, [
      el("label", {}, `Cotação atual de ${ticker} (${isUSD ? "US$" : "¥"}) — só para este ticker`),
      el("input", {
        id: "tickerMarketPriceRef",
        type: "number", step: "0.01", min: "0",
        value: refPrice ? String(refPrice) : "",
        placeholder: "ex: " + (snap.taxAvgCost ? snap.taxAvgCost.toFixed(2) : "100"),
        oninput: (e) => {
          ts.marketPriceRef = parseFloat(e.target.value) || 0;
          savePortfolio();
        },
        onchange: () => renderMain(),
      }),
    ]),
    el("p", { class: "disclaimer" },
      "⚠️ Custo médio fiscal menor ≠ lucro econômico. Lucro de caixa numa operação ≠ lucro fiscal tributável. " +
      (isUSD ? "Resultado fiscal e imposto sempre em ¥, convertidos pela cotação de cada operação. " : "") +
      "Simulador educacional — não substitui cálculo fiscal profissional."),
  ]);
  container.appendChild(card);
}

function metricEl(label, value, colorClass = "") {
  return el("div", { class: "metric" }, [
    el("div", { class: "label" }, label),
    el("div", { class: `value ${colorClass}` }, value),
  ]);
}

/* ---------------- Tabs ---------------- */

const TABS = [
  { id: "trade", label: "Comprar/Vender" },
  { id: "simulate", label: "Simular ciclos" },
  { id: "target", label: "Objetivo de lucro" },
  { id: "charts", label: "Gráficos" },
  { id: "scenarios", label: "Cenários" },
  { id: "history", label: "Histórico" },
  { id: "import", label: "Importar CSV" },
  { id: "export", label: "Exportar" },
];

function renderTabs(container, ticker) {
  const tabsBar = el("div", { class: "tabs" });
  TABS.forEach((tab) => {
    const btn = el("button", {
      class: `tab-btn ${STATE.activeTab === tab.id ? "active" : ""}`,
      onclick: () => {
        STATE.activeTab = tab.id;
        if (tab.id !== "simulate") SIM_PREVIEW = null;
        renderMain();
      },
    }, tab.label);
    tabsBar.appendChild(btn);
  });
  container.appendChild(tabsBar);

  const panel = el("div", { class: "tab-panel active" });
  container.appendChild(panel);

  switch (STATE.activeTab) {
    case "trade": renderTradeTab(panel, ticker); break;
    case "simulate": renderSimulateTab(panel, ticker); break;
    case "target": renderTargetTab(panel, ticker); break;
    case "charts": renderChartsTab(panel, ticker); break;
    case "scenarios": renderScenariosTab(panel, ticker); break;
    case "history": renderHistoryTab(panel, ticker); break;
    case "import": renderImportTab(panel); break;
    case "export": renderExportTab(panel, ticker); break;
  }
}

/* ---------------- Aba: Comprar/Vender ---------------- */

function renderTradeTab(container, ticker) {
  const ts = getTickerState(ticker);
  const isUSD = ts.currency === "USD";
  const wrap = el("div", { class: "row2" });

  // Compra
  const buyFields = [
    el("div", { class: "field" }, [el("label", {}, "Quantidade"), el("input", { id: "buyQty", type: "number", value: "5", min: "1" })]),
    el("div", { class: "field" }, [el("label", {}, `Preço (${isUSD ? "US$" : "¥"})`), el("input", { id: "buyPrice", type: "number", value: "100", step: "0.01", min: "0" })]),
    el("div", { class: "field" }, [el("label", {}, "Corretagem/taxas"), el("input", { id: "buyFee", type: "number", value: "0", step: "0.01", min: "0" })]),
  ];
  if (isUSD) {
    buyFields.push(el("div", { class: "field" }, [
      el("label", {}, "Câmbio USD/JPY nesta operação"),
      el("input", { id: "buyFxRate", type: "number", step: "0.01", value: String(STATE.fxConfig.usdJpy) }),
    ]));
  }
  const buyCard = el("div", { class: "card" }, [
    el("h4", {}, "Nova compra"),
    ...buyFields,
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        onclick: () => {
          const qty = parseInt(document.getElementById("buyQty").value, 10);
          const price = parseFloat(document.getElementById("buyPrice").value);
          const fee = parseFloat(document.getElementById("buyFee").value) || 0;
          const fxRate = isUSD ? (parseFloat(document.getElementById("buyFxRate").value) || STATE.fxConfig.usdJpy) : null;
          if (!qty || qty <= 0 || Number.isNaN(price)) { showToast("Preencha quantidade e preço válidos.", true); return; }
          buyOnTicker(ticker, qty, price, fee, null, fxRate);
          showToast(`Compra registrada: ${qty} @ ${fmtMoney(price, ts.currency)}`);
          renderMain();
        },
      }, "COMPRAR"),
    ]),
  ]);

  // Venda
  const sellFields = [
    el("div", { class: "field" }, [el("label", {}, `Quantidade (máx ${ts.quantity})`), el("input", { id: "sellQty", type: "number", value: "1", min: "1", max: String(ts.quantity || 1) })]),
    el("div", { class: "field" }, [el("label", {}, `Preço (${isUSD ? "US$" : "¥"})`), el("input", { id: "sellPrice", type: "number", value: "100", step: "0.01", min: "0" })]),
    el("div", { class: "field" }, [el("label", {}, "Corretagem/taxas"), el("input", { id: "sellFee", type: "number", value: "0", step: "0.01", min: "0" })]),
  ];
  if (isUSD) {
    sellFields.push(el("div", { class: "field" }, [
      el("label", {}, "Câmbio USD/JPY nesta operação"),
      el("input", { id: "sellFxRate", type: "number", step: "0.01", value: String(STATE.fxConfig.usdJpy) }),
    ]));
  }
  const sellCard = el("div", { class: "card" }, [
    el("h4", {}, "Nova venda"),
    ...sellFields,
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        disabled: ts.quantity === 0,
        onclick: () => {
          const qty = parseInt(document.getElementById("sellQty").value, 10);
          const price = parseFloat(document.getElementById("sellPrice").value);
          const fee = parseFloat(document.getElementById("sellFee").value) || 0;
          const fxRate = isUSD ? (parseFloat(document.getElementById("sellFxRate").value) || STATE.fxConfig.usdJpy) : null;
          if (!qty || qty <= 0 || Number.isNaN(price)) { showToast("Preencha quantidade e preço válidos.", true); return; }
          if (qty > ts.quantity) { showToast("Quantidade excede a posição atual.", true); return; }
          sellOnTicker(ticker, qty, price, fee, null, fxRate);
          showToast(`Venda registrada: ${qty} @ ${fmtMoney(price, ts.currency)}`);
          renderMain();
        },
      }, "VENDER"),
    ]),
  ]);

  wrap.appendChild(buyCard);
  wrap.appendChild(sellCard);
  container.appendChild(wrap);
}

/* ---------------- Aba: Simular ciclos ---------------- */

let SIM_PREVIEW = null; // { ticker, clone, results, cyclesRequested, cyclesCompleted }

function renderSimulateTab(container, ticker) {
  const ts = getTickerState(ticker);
  const isUSD = ts.currency === "USD";
  const symbol = isUSD ? "US$" : "¥";

  const fields = [
    el("div", { class: "row3" }, [
      el("div", { class: "field" }, [el("label", {}, "Qtd por compra"), el("input", { id: "cycBuyQty", type: "number", value: "5", min: "1" })]),
      el("div", { class: "field" }, [el("label", {}, `Preço de compra (${symbol})`), el("input", { id: "cycBuyPrice", type: "number", value: "125", step: "0.01" })]),
      el("div", { class: "field" }, [el("label", {}, "Nº de ciclos"), el("input", { id: "cycCount", type: "number", value: "10", min: "1" })]),
    ]),
    el("div", { class: "row3" }, [
      el("div", { class: "field" }, [el("label", {}, "Qtd por venda"), el("input", { id: "cycSellQty", type: "number", value: "5", min: "1" })]),
      el("div", { class: "field" }, [el("label", {}, `Preço de venda (${symbol})`), el("input", { id: "cycSellPrice", type: "number", value: "145", step: "0.01" })]),
    ]),
  ];
  if (isUSD) {
    fields.push(el("div", { class: "row2" }, [
      el("div", { class: "field" }, [el("label", {}, "Câmbio na compra"), el("input", { id: "cycBuyFx", type: "number", step: "0.01", value: String(STATE.fxConfig.usdJpy) })]),
      el("div", { class: "field" }, [el("label", {}, "Câmbio na venda"), el("input", { id: "cycSellFx", type: "number", step: "0.01", value: String(STATE.fxConfig.usdJpy) })]),
    ]));
  }

  const card = el("div", { class: "card" }, [
    el("h4", {}, "Ciclos automáticos (comprar abaixo / vender acima do lote)"),
    el("p", { class: "help-text" }, "Isso é uma prévia: nada é aplicado até você confirmar."),
    ...fields,
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        onclick: () => {
          const buyQty = parseInt(document.getElementById("cycBuyQty").value, 10);
          const buyPrice = parseFloat(document.getElementById("cycBuyPrice").value);
          const sellQty = parseInt(document.getElementById("cycSellQty").value, 10);
          const sellPrice = parseFloat(document.getElementById("cycSellPrice").value);
          const cycles = parseInt(document.getElementById("cycCount").value, 10);
          if (!buyQty || !sellQty || !cycles || Number.isNaN(buyPrice) || Number.isNaN(sellPrice)) {
            showToast("Preencha todos os campos.", true);
            return;
          }
          const buyFx = isUSD ? parseFloat(document.getElementById("cycBuyFx").value) || STATE.fxConfig.usdJpy : null;
          const sellFx = isUSD ? parseFloat(document.getElementById("cycSellFx").value) || STATE.fxConfig.usdJpy : null;

          const preview = previewCycles(ticker, buyQty, buyPrice, sellQty, sellPrice, cycles, buyFx, sellFx);
          SIM_PREVIEW = { ticker, ...preview };
          renderMain();
        },
      }, "PRÉ-VISUALIZAR"),
    ]),
    el("div", { id: "simPreviewSlot" }),
  ]);
  container.appendChild(card);

  if (SIM_PREVIEW && SIM_PREVIEW.ticker === ticker) {
    renderSimPreviewPanel(card.querySelector("#simPreviewSlot"), ticker);
  }
}

function renderSimPreviewPanel(slot, ticker) {
  const { clone, results, cyclesRequested, cyclesCompleted } = SIM_PREVIEW;
  const before = getTickerState(ticker);
  const cur = clone.currency;

  const totalTaxResultJPY = results.reduce((sum, r) => sum + (r.taxResultJPY || 0), 0);
  const beforeSnap = snapshotFromState(before);
  const afterSnap = snapshotFromState(clone);
  const beBefore = breakEvenEconomic(beforeSnap);
  const beAfter = breakEvenEconomic(afterSnap);

  slot.appendChild(el("div", { style: "margin-top:16px;padding-top:14px;border-top:1px solid var(--border);" }, [
    el("h4", {}, "Prévia do resultado"),
    cyclesCompleted < cyclesRequested
      ? el("p", { class: "help-text", style: "color:var(--danger);" },
          `Só ${cyclesCompleted} de ${cyclesRequested} ciclo(s) cabem na posição atual (ficaria sem ações suficientes pra continuar).`)
      : null,
    el("div", { class: "table-scroll" }, el("table", {}, [
      el("thead", {}, el("tr", {}, [el("th", {}, "Indicador"), el("th", {}, "Antes"), el("th", {}, "Depois")])),
      el("tbody", {}, [
        el("tr", {}, [el("td", {}, "Quantidade"), el("td", {}, String(before.quantity)), el("td", {}, String(clone.quantity))]),
        el("tr", {}, [el("td", {}, "Custo médio fiscal"), el("td", {}, fmtMoney(before.avgCost, cur, 3)), el("td", {}, fmtMoney(clone.avgCost, cur, 3))]),
        el("tr", {}, [el("td", {}, "Caixa acumulado"), el("td", {}, fmtMoney(before.cashBalance, cur)), el("td", {}, fmtMoney(clone.cashBalance, cur))]),
        el("tr", {}, [
          el("td", {}, "Break-even econômico"),
          el("td", {}, beBefore === null ? "—" : fmtMoney(beBefore, cur, 3)),
          el("td", {}, beAfter === null ? "—" : fmtMoney(beAfter, cur, 3)),
        ]),
      ]),
    ])),
    el("p", { style: "margin-top:10px;" }, [
      "Resultado fiscal gerado pelos ciclos: ",
      el("b", { style: totalTaxResultJPY >= 0 ? "color:var(--mint);" : "color:var(--danger);" }, fmtMoney(totalTaxResultJPY, "JPY")),
    ]),
    el("div", { style: "margin-top:14px;display:flex;gap:8px;" }, [
      el("button", {
        onclick: () => {
          commitPreview(ticker, clone);
          showToast(`${cyclesCompleted} ciclo(s) aplicado(s).`);
          SIM_PREVIEW = null;
          renderMain();
        },
      }, "CONFIRMAR E APLICAR"),
      el("button", {
        class: "secondary",
        onclick: () => {
          SIM_PREVIEW = null;
          renderMain();
        },
      }, "CANCELAR"),
    ]),
  ]));
}

/* ---------------- Aba: Objetivo de lucro ---------------- */

function renderTargetTab(container, ticker) {
  const snap = snapshotOf(ticker);
  const cur = snap.currency;
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Objetivo de lucro"),
    el("div", { class: "row2" }, [
      el("div", { class: "field" }, [el("label", {}, `Lucro desejado (${cur === "USD" ? "US$" : "¥"})`), el("input", { id: "targetProfit", type: "number", value: "1000", step: "100" })]),
      el("div", { class: "field" }, [el("label", {}, "ou percentual do capital (%)"), el("input", { id: "targetPct", type: "number", placeholder: "ex: 10" })]),
    ]),
    el("div", { id: "targetResult", style: "margin-top:14px;font-size:15px;" }),
    el("div", { style: "margin-top:10px;" }, [
      el("button", {
        onclick: () => {
          const pctRaw = document.getElementById("targetPct").value;
          let desired;
          if (pctRaw) {
            desired = snap.initialCapital * (parseFloat(pctRaw) / 100);
          } else {
            desired = parseFloat(document.getElementById("targetProfit").value) || 0;
          }
          const resultEl = document.getElementById("targetResult");
          if (snap.quantity === 0) {
            resultEl.textContent = "Sem ações restantes para calcular preço-alvo.";
            return;
          }
          const target = targetPriceForProfit(snap, desired);
          resultEl.innerHTML = `Preço necessário nas <b>${snap.quantity}</b> ações restantes: <span style="color:var(--cyan);font-weight:700;">${fmtMoney(target, cur, 3)}</span>`;
        },
      }, "CALCULAR"),
    ]),
  ]);
  container.appendChild(card);
}

/* ---------------- Aba: Gráficos ---------------- */

function destroyChart(key) {
  if (CHART_REFS[key]) { CHART_REFS[key].destroy(); delete CHART_REFS[key]; }
}

function chartBaseOptions(titleText) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: true, text: titleText, color: "#E8ECF1", font: { size: 12 } },
    },
    scales: {
      x: { ticks: { color: "#8B96AA" }, grid: { color: "#2A3446" } },
      y: { ticks: { color: "#8B96AA" }, grid: { color: "#2A3446" } },
    },
  };
}

function renderChartsTab(container, ticker) {
  const ts = getTickerState(ticker);
  if (ts.transactions.length === 0) {
    container.appendChild(el("div", { class: "empty-state" }, "Sem operações ainda para gerar gráficos."));
    return;
  }

  const grid = el("div", { class: "chart-grid" });
  const canvases = ["chartAvgCost", "chartCash", "chartBreakEven", "chartPatrimony"];
  const titles = ["Custo médio fiscal (¥/ação)", "Caixa acumulado (¥)", "Break-even econômico (¥)", "Patrimônio total (¥)"];
  canvases.forEach((id, i) => {
    const box = el("div", { class: "card" }, [
      el("div", { class: "chart-wrap" }, el("canvas", { id })),
    ]);
    grid.appendChild(box);
  });
  container.appendChild(grid);

  const x = ts.transactions.map((t) => t.id);
  const avgCosts = ts.transactions.map((t) => t.avgCostAfter);
  const cash = ts.transactions.map((t) => t.cashBalanceAfter);
  const breakEvens = ts.transactions.map((t) =>
    t.quantityAfter > 0 ? (ts.initialCapital - t.cashBalanceAfter) / t.quantityAfter : null
  );
  const patrimonyLine = ts.transactions.map((t) => t.cashBalanceAfter + t.quantityAfter * t.avgCostAfter);

  const datasets = [
    { id: "chartAvgCost", data: avgCosts, color: "#00D0E8", title: titles[0] },
    { id: "chartCash", data: cash, color: "#E573A7", title: titles[1] },
    { id: "chartBreakEven", data: breakEvens, color: "#38F39C", title: titles[2] },
    { id: "chartPatrimony", data: patrimonyLine, color: "#00D0E8", title: titles[3] },
  ];

  datasets.forEach((d) => {
    destroyChart(d.id);
    const ctx = document.getElementById(d.id).getContext("2d");
    CHART_REFS[d.id] = new Chart(ctx, {
      type: "line",
      data: {
        labels: x,
        datasets: [{ data: d.data, borderColor: d.color, backgroundColor: d.color, tension: 0.25, pointRadius: 3 }],
      },
      options: chartBaseOptions(d.title),
    });
  });
}

/* ---------------- Aba: Cenários ---------------- */

function renderScenariosTab(container, ticker) {
  const snap = snapshotOf(ticker);
  const cur = snap.currency;
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Simular cenários"),
    el("div", { class: "row3" }, [
      el("div", { class: "field" }, [el("label", {}, "Preço mínimo"), el("input", { id: "scnMin", type: "number", value: String(Math.max(snap.taxAvgCost - 50, 0).toFixed(2)) })]),
      el("div", { class: "field" }, [el("label", {}, "Preço máximo"), el("input", { id: "scnMax", type: "number", value: String((snap.taxAvgCost + 50).toFixed(2)) })]),
      el("div", { class: "field" }, [el("label", {}, "Passo"), el("input", { id: "scnStep", type: "number", value: "10" })]),
    ]),
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        onclick: () => {
          if (snap.quantity === 0) { showToast("Sem ações restantes para simular.", true); return; }
          const pMin = parseFloat(document.getElementById("scnMin").value);
          const pMax = parseFloat(document.getElementById("scnMax").value);
          const step = parseFloat(document.getElementById("scnStep").value) || 1;
          const prices = [];
          for (let p = pMin; p <= pMax + 1e-9; p += step) prices.push(Math.round(p * 10000) / 10000);
          const table = scenarioTable(snap, prices);
          renderScenarioResult(table, cur);
        },
      }, "SIMULAR CENÁRIO"),
    ]),
    el("div", { id: "scenarioResult" }),
  ]);
  container.appendChild(card);
}

function renderScenarioResult(table, currency = "JPY") {
  const resultDiv = document.getElementById("scenarioResult");
  resultDiv.innerHTML = "";
  resultDiv.appendChild(el("div", { class: "chart-wrap" }, el("canvas", { id: "chartScenario" })));

  const tableWrap = el("div", { class: "table-scroll" });
  const tbl = el("table", {}, [
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Preço final"), el("th", {}, "Valor posição"), el("th", {}, "Caixa"),
      el("th", {}, "Patrimônio"), el("th", {}, "Lucro"),
    ])),
    el("tbody", {}, table.map((r) => el("tr", {}, [
      el("td", {}, fmtMoney(r.price, currency)), el("td", {}, fmtMoney(r.positionValue, currency)), el("td", {}, fmtMoney(r.cash, currency)),
      el("td", {}, fmtMoney(r.patrimony, currency)),
      el("td", { style: `color:${r.profit >= 0 ? "var(--mint)" : "var(--danger)"}` }, fmtMoney(r.profit, currency)),
    ]))),
  ]);
  tableWrap.appendChild(tbl);
  resultDiv.appendChild(tableWrap);

  destroyChart("chartScenario");
  const ctx = document.getElementById("chartScenario").getContext("2d");
  CHART_REFS["chartScenario"] = new Chart(ctx, {
    type: "line",
    data: {
      labels: table.map((r) => r.price),
      datasets: [{ data: table.map((r) => r.profit), borderColor: "#38F39C", backgroundColor: "#38F39C", tension: 0.2, pointRadius: 3 }],
    },
    options: chartBaseOptions("Lucro/Prejuízo econômico por preço final"),
  });
}

/* ---------------- Aba: Histórico ---------------- */

function renderHistoryTab(container, ticker) {
  const ts = getTickerState(ticker);
  const cur = ts.currency;
  const isUSD = cur === "USD";
  if (ts.transactions.length === 0) {
    container.appendChild(el("div", { class: "empty-state" }, "Nenhuma operação registrada ainda."));
    return;
  }
  const headerCells = [
    el("th", {}, "Nº"), el("th", {}, "Data"), el("th", {}, "Tipo"), el("th", {}, "Qtd"),
    el("th", {}, "Preço"), el("th", {}, "Caixa (fluxo)"), el("th", {}, "Qtd. posição"),
    el("th", {}, "Custo médio"),
  ];
  if (isUSD) headerCells.push(el("th", {}, "Câmbio"));
  headerCells.push(el("th", {}, "Res. fiscal (¥)"));

  const card = el("div", { class: "card" }, [
    el("h4", {}, "Histórico de operações"),
    el("div", { class: "table-scroll" }, el("table", {}, [
      el("thead", {}, el("tr", {}, headerCells)),
      el("tbody", {}, [...ts.transactions].reverse().map((t) => {
        const rowCells = [
          el("td", {}, String(t.id)),
          el("td", {}, t.date),
          el("td", {}, el("span", { class: `badge ${t.side === "BUY" ? "buy" : "sell"}` }, t.side === "BUY" ? "COMPRA" : "VENDA")),
          el("td", {}, String(t.quantity)),
          el("td", {}, fmtMoney(t.unitPrice, cur)),
          el("td", { style: t.cashFlow >= 0 ? "color:var(--mint)" : "color:var(--danger)" }, fmtMoney(t.cashFlow, cur)),
          el("td", {}, String(t.quantityAfter)),
          el("td", {}, fmtMoney(t.avgCostAfter, cur, 3)),
        ];
        if (isUSD) rowCells.push(el("td", {}, `¥${t.fxRate.toFixed(2)}`));
        rowCells.push(el("td", {}, t.taxResultJPY === null ? "—" : fmtYen(t.taxResultJPY)));
        return el("tr", {}, rowCells);
      })),
    ])),
  ]);
  container.appendChild(card);
}

/* ---------------- Aba: Importar CSV ---------------- */

function renderImportTab(container) {
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Importar CSV de operações"),
    el("p", { class: "help-text" }, "Colunas esperadas: date,ticker,side,quantity,price,fee,currency"),
    el("div", { class: "file-input-wrap" }, [
      el("input", { type: "file", id: "csvFileInput", accept: ".csv" }),
    ]),
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        onclick: () => {
          const input = document.getElementById("csvFileInput");
          if (!input.files || input.files.length === 0) { showToast("Selecione um arquivo CSV.", true); return; }
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const count = importCSVText(reader.result);
              savePortfolio();
              renderTickerSelect();
              renderMain();
              showToast(`${count} operação(ões) importada(s).`);
            } catch (e) {
              showToast(`Erro ao importar: ${e.message}`, true);
            }
          };
          reader.readAsText(input.files[0], "utf-8");
        },
      }, "IMPORTAR"),
    ]),
  ]);
  container.appendChild(card);
}

/* ---------------- Aba: Exportar ---------------- */

function renderExportTab(container, ticker) {
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Exportar relatório"),
    el("div", { class: "row3" }, [
      el("button", { class: "secondary", onclick: () => exportCSV(ticker) }, "CSV"),
      el("button", { class: "secondary", onclick: () => exportExcel(ticker) }, "EXCEL"),
      el("button", { class: "secondary", onclick: () => exportPDF(ticker) }, "PDF"),
    ]),
  ]);
  container.appendChild(card);
}

/* ---------------- Boot ---------------- */

function renderMain() {
  const main = document.getElementById("mainContent");
  main.innerHTML = "";
  renderTickerSelect();

  const tickers = Object.keys(STATE.portfolio.tickers);
  if (tickers.length === 0) {
    main.appendChild(el("div", { class: "empty-state" }, [
      el("p", {}, "Nenhum ticker cadastrado ainda."),
      el("button", { onclick: () => document.getElementById("btnNewTicker").click() }, "CRIAR PRIMEIRO TICKER"),
    ]));
    return;
  }

  const ticker = STATE.activeTicker;
  renderDashboard(main, ticker);
  renderTabs(main, ticker);
}

renderMain();

/* ---------------- Service worker ---------------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW falhou:", e));
  });
}
