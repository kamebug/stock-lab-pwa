/* ============================================================
   STOCK LAB — Simulador de Estratégia de Compra e Venda de Ações
   Engine (custo médio móvel japonês, caixa, fiscal, break-even,
   simulador de ciclos) + UI, tudo client-side com localStorage.
   ============================================================ */

const STORAGE_KEY = "stocklab_portfolio_v1";
const TAXCFG_KEY = "stocklab_taxconfig_v1";
const ACTIVE_TICKER_KEY = "stocklab_active_ticker_v1";

/* ---------------- Utilidades ---------------- */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtYen(v, decimals = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}¥${Math.abs(v).toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fmtPct(v) {
  return `${(v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}%`;
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

const STATE = {
  portfolio: loadPortfolio(),
  taxConfig: loadTaxConfig(),
  activeTicker: localStorage.getItem(ACTIVE_TICKER_KEY) || null,
  activeTab: "trade",
  marketPriceRef: 0,
};

function newTickerState(ticker) {
  return {
    ticker,
    quantity: 0,
    avgCost: 0,
    cashBalance: 0,
    initialCapital: 0,
    transactions: [],
  };
}

function getTickerState(ticker) {
  if (!STATE.portfolio.tickers[ticker]) {
    STATE.portfolio.tickers[ticker] = newTickerState(ticker);
  }
  return STATE.portfolio.tickers[ticker];
}

/* ---------------- Tax / Average-Cost Engine ---------------- */
/* Custo médio móvel (não FIFO/LIFO): compra recalcula média
   ponderada; venda debita a quantidade ao custo médio vigente
   sem alterar o custo médio por ação. */

function applyBuy(ts, quantity, unitPrice) {
  const qtyBefore = ts.quantity;
  const avgBefore = ts.avgCost;
  const existingTotal = qtyBefore * avgBefore;
  const purchaseTotal = quantity * unitPrice;
  const qtyAfter = qtyBefore + quantity;
  const avgAfter = qtyAfter > 0 ? (existingTotal + purchaseTotal) / qtyAfter : 0;

  ts.quantity = qtyAfter;
  ts.avgCost = avgAfter;

  return { qtyBefore, qtyAfter, avgBefore, avgAfter, grossCost: purchaseTotal };
}

function applySell(ts, quantity, unitPrice) {
  if (quantity > ts.quantity) {
    throw new Error(`Venda de ${quantity} ações excede a posição atual de ${ts.quantity}`);
  }
  const qtyBefore = ts.quantity;
  const avgBefore = ts.avgCost;
  const grossProceeds = quantity * unitPrice;
  const taxCostBasis = quantity * avgBefore;
  const taxResult = grossProceeds - taxCostBasis;
  const qtyAfter = qtyBefore - quantity;

  ts.quantity = qtyAfter;
  // custo médio por ação não muda numa venda

  return { qtyBefore, qtyAfter, avgBefore, avgAfter: avgBefore, grossProceeds, taxCostBasis, taxResult };
}

/* ---------------- Ledger: orquestra buy/sell + registro ---------------- */

function nextTxnId(ts) {
  return ts.transactions.length + 1;
}

function buyOnTicker(ticker, quantity, unitPrice, fees = 0, date = null) {
  const ts = getTickerState(ticker);
  const isFirstBuy = ts.quantity === 0 && ts.transactions.length === 0;
  const r = applyBuy(ts, quantity, unitPrice);
  const cashFlow = -(r.grossCost + fees);
  ts.cashBalance += cashFlow;
  if (isFirstBuy) ts.initialCapital = r.grossCost;

  const txn = {
    id: nextTxnId(ts),
    date: date || todayISO(),
    ticker,
    side: "BUY",
    quantity,
    unitPrice,
    fees,
    grossValue: r.grossCost,
    netValue: r.grossCost + fees,
    quantityBefore: r.qtyBefore,
    quantityAfter: r.qtyAfter,
    avgCostBefore: r.avgBefore,
    avgCostAfter: r.avgAfter,
    taxCostBasis: null,
    taxResult: null,
    cashFlow,
    cashBalanceAfter: ts.cashBalance,
  };
  ts.transactions.push(txn);
  savePortfolio();
  return txn;
}

function sellOnTicker(ticker, quantity, unitPrice, fees = 0, date = null) {
  const ts = getTickerState(ticker);
  const r = applySell(ts, quantity, unitPrice);
  const cashFlow = r.grossProceeds - fees;
  ts.cashBalance += cashFlow;

  const txn = {
    id: nextTxnId(ts),
    date: date || todayISO(),
    ticker,
    side: "SELL",
    quantity,
    unitPrice,
    fees,
    grossValue: r.grossProceeds,
    netValue: r.grossProceeds - fees,
    quantityBefore: r.qtyBefore,
    quantityAfter: r.qtyAfter,
    avgCostBefore: r.avgBefore,
    avgCostAfter: r.avgAfter,
    taxCostBasis: r.taxCostBasis,
    taxResult: r.taxResult,
    cashFlow,
    cashBalanceAfter: ts.cashBalance,
  };
  ts.transactions.push(txn);
  savePortfolio();
  return txn;
}

/* ---------------- Economic Metrics ---------------- */

function snapshotOf(ticker) {
  const ts = getTickerState(ticker);
  return {
    initialCapital: ts.initialCapital,
    cashBalance: ts.cashBalance,
    quantity: ts.quantity,
    taxAvgCost: ts.avgCost,
  };
}

function breakEvenFiscal(snap) {
  return snap.taxAvgCost;
}

function breakEvenEconomic(snap) {
  if (snap.quantity === 0) return null;
  return (snap.initialCapital - snap.cashBalance) / snap.quantity;
}

function targetPriceForProfit(snap, desiredProfit) {
  if (snap.quantity === 0) return null;
  return (snap.initialCapital + desiredProfit - snap.cashBalance) / snap.quantity;
}

function patrimony(snap, marketPrice) {
  return snap.cashBalance + snap.quantity * marketPrice;
}

function economicResult(snap, marketPrice) {
  return patrimony(snap, marketPrice) - snap.initialCapital;
}

function scenarioTable(snap, prices) {
  return prices.map((p) => {
    const positionValue = snap.quantity * p;
    const total = snap.cashBalance + positionValue;
    const profit = total - snap.initialCapital;
    return { price: p, positionValue, cash: snap.cashBalance, patrimony: total, profit };
  });
}

/* ---------------- Tax Report (imposto estimado + compensação) ---------------- */

function buildTaxReport(transactions, taxConfig) {
  let gains = 0;
  let losses = 0;
  for (const t of transactions) {
    if (t.side !== "SELL" || t.taxResult === null || t.taxResult === undefined) continue;
    if (t.taxResult >= 0) gains += t.taxResult;
    else losses += -t.taxResult;
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

function runCycles(ticker, buyQty, buyPrice, sellQty, sellPrice, cycles) {
  const results = [];
  for (let i = 1; i <= cycles; i++) {
    const ts = getTickerState(ticker);
    if (ts.quantity < sellQty) {
      showToast(`Parado no ciclo ${i}: posição insuficiente para vender.`, true);
      break;
    }
    buyOnTicker(ticker, buyQty, buyPrice);
    const sellTxn = sellOnTicker(ticker, sellQty, sellPrice);
    results.push(sellTxn);
  }
  return results;
}

/* ---------------- CSV Import (formato: date,ticker,side,quantity,price,fee,currency) ---------------- */

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
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

    if (!ticker || !quantity || Number.isNaN(price)) continue;

    if (side === "BUY") {
      buyOnTicker(ticker, quantity, price, fee, date);
    } else if (side === "SELL") {
      sellOnTicker(ticker, quantity, price, fee, date);
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
    "id", "date", "ticker", "side", "quantity", "unitPrice", "fees",
    "grossValue", "netValue", "quantityBefore", "quantityAfter",
    "avgCostBefore", "avgCostAfter", "taxCostBasis", "taxResult",
    "cashFlow", "cashBalanceAfter",
  ];
  const lines = [cols.join(",")];
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

  const summaryRows = [
    ["Indicador", "Valor"],
    ["Ticker", ticker],
    ["Capital inicial", snap.initialCapital],
    ["Caixa acumulado", snap.cashBalance],
    ["Ações restantes", snap.quantity],
    ["Custo médio fiscal", snap.taxAvgCost],
    ["Break-even fiscal", breakEvenFiscal(snap)],
    ["Break-even econômico", be === null ? "" : be],
    ["Ganhos fiscais realizados", report.realizedGains],
    ["Perdas fiscais realizadas", report.realizedLosses],
    ["Resultado fiscal líquido", report.totalRealizedResult],
    ["Prejuízo a compensar", report.carriedLoss],
    ["Imposto estimado", report.estimatedTax],
  ];

  const txnRows = [
    ["ID", "Data", "Lado", "Qtd", "Preço", "Qtd antes", "Qtd depois",
     "Custo médio antes", "Custo médio depois", "Resultado fiscal", "Fluxo de caixa", "Caixa acumulado"],
    ...ts.transactions.map((t) => [
      t.id, t.date, t.side, t.quantity, t.unitPrice, t.quantityBefore, t.quantityAfter,
      t.avgCostBefore, t.avgCostAfter, t.taxResult, t.cashFlow, t.cashBalanceAfter,
    ]),
  ];

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

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text(`Stock Lab — ${ticker}`, 14, 18);

  doc.setFontSize(11);
  const summaryBody = [
    ["Capital inicial", fmtYen(snap.initialCapital)],
    ["Caixa acumulado", fmtYen(snap.cashBalance)],
    ["Ações restantes", String(snap.quantity)],
    ["Custo médio fiscal", fmtYen(snap.taxAvgCost, 4)],
    ["Break-even fiscal", fmtYen(breakEvenFiscal(snap), 4)],
    ["Break-even econômico", be === null ? "—" : fmtYen(be, 4)],
    ["Ganhos fiscais realizados", fmtYen(report.realizedGains)],
    ["Perdas fiscais realizadas", fmtYen(report.realizedLosses)],
    ["Resultado fiscal líquido", fmtYen(report.totalRealizedResult)],
    ["Prejuízo a compensar", fmtYen(report.carriedLoss)],
    ["Imposto estimado", fmtYen(report.estimatedTax)],
  ];

  doc.autoTable({
    startY: 24,
    head: [["Indicador", "Valor"]],
    body: summaryBody,
    theme: "grid",
    headStyles: { fillColor: [28, 35, 49] },
    styles: { fontSize: 9 },
  });

  const txnBody = ts.transactions.map((t) => [
    t.id, t.date, t.side, t.quantity, fmtYen(t.unitPrice),
    fmtYen(t.avgCostAfter, 4), t.taxResult === null ? "—" : fmtYen(t.taxResult),
    fmtYen(t.cashBalanceAfter),
  ]);

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
    head: [["ID", "Data", "Lado", "Qtd", "Preço", "Custo médio", "Res. fiscal", "Caixa"]],
    body: txnBody,
    theme: "grid",
    headStyles: { fillColor: [28, 35, 49] },
    styles: { fontSize: 7 },
  });

  doc.setFontSize(8);
  doc.text(
    "Simulador educacional — não substitui cálculo fiscal profissional.",
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
  renderMain();
});

document.getElementById("btnNewTicker").addEventListener("click", () => {
  const wrap = el("div", {}, [
    el("h3", {}, "Novo ticker"),
    el("div", { class: "field" }, [
      el("label", {}, "Código do ticker"),
      el("input", { id: "newTickerCode", placeholder: "ex: 7203" }),
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
          getTickerState(code);
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

/* ---------------- Configurações fiscais ---------------- */

document.getElementById("btnSettings").addEventListener("click", () => {
  const cfg = STATE.taxConfig;
  const wrap = el("div", {}, [
    el("h3", {}, "Configuração fiscal"),
    el("div", { class: "field" }, [
      el("label", {}, "Imposto nacional"),
      el("input", { id: "cfgNational", type: "number", step: "0.00001", value: String(cfg.nationalTax) }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Imposto local"),
      el("input", { id: "cfgLocal", type: "number", step: "0.00001", value: String(cfg.localTax) }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Imposto de reconstrução"),
      el("input", { id: "cfgRecon", type: "number", step: "0.00001", value: String(cfg.reconstructionTax) }),
    ]),
    el("div", { class: "field" }, [
      el("label", {}, "Preço de mercado de referência (opcional)"),
      el("input", { id: "cfgMarketPrice", type: "number", step: "0.01", value: String(STATE.marketPriceRef || "") }),
    ]),
    el("p", { class: "help-text" }, `Alíquota efetiva atual: ${fmtPct(effectiveRate(cfg))}`),
    el("div", { style: "margin-top:16px;" }, [
      el("button", {
        onclick: () => {
          STATE.taxConfig = {
            nationalTax: parseFloat(document.getElementById("cfgNational").value) || 0,
            localTax: parseFloat(document.getElementById("cfgLocal").value) || 0,
            reconstructionTax: parseFloat(document.getElementById("cfgRecon").value) || 0,
          };
          STATE.marketPriceRef = parseFloat(document.getElementById("cfgMarketPrice").value) || 0;
          saveTaxConfig();
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

  const card = el("div", { class: "card" }, [
    el("h2", {}, `📊 ${ticker}`),
    el("div", { class: "metric-grid" }, [
      metricEl("Capital inicial", fmtYen(snap.initialCapital, 0)),
      metricEl("Caixa acumulado", fmtYen(snap.cashBalance, 0), snap.cashBalance >= 0 ? "mint" : "danger"),
      metricEl("Ações restantes", String(snap.quantity)),
    ]),
    el("div", { class: "section-title" }, "Visão fiscal"),
    el("div", { class: "metric-grid" }, [
      metricEl("Custo médio fiscal", fmtYen(snap.taxAvgCost, 3), "cyan"),
      metricEl("Resultado fiscal realizado", fmtYen(report.totalRealizedResult), report.totalRealizedResult >= 0 ? "mint" : "danger"),
      metricEl("Imposto estimado", fmtYen(report.estimatedTax), "magenta"),
    ]),
    report.carriedLoss > 0
      ? el("p", { class: "help-text" }, `Prejuízo a compensar: ${fmtYen(report.carriedLoss)}`)
      : null,
    el("div", { class: "section-title" }, "Visão econômica e de equilíbrio"),
    el("div", { class: "metric-grid" }, [
      metricEl("Break-even fiscal", fmtYen(breakEvenFiscal(snap), 3)),
      metricEl("Break-even econômico", be === null ? "—" : fmtYen(be, 3), "cyan"),
      STATE.marketPriceRef
        ? metricEl("Result. econ. @ ref.", fmtYen(economicResult(snap, STATE.marketPriceRef)), economicResult(snap, STATE.marketPriceRef) >= 0 ? "mint" : "danger")
        : metricEl("Result. econ. @ ref.", "—"),
    ]),
    el("p", { class: "disclaimer" },
      "⚠️ Custo médio fiscal menor ≠ lucro econômico. Lucro de caixa numa operação ≠ lucro fiscal tributável. " +
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
  const wrap = el("div", { class: "row2" });

  // Compra
  const buyCard = el("div", { class: "card" }, [
    el("h4", {}, "Nova compra"),
    el("div", { class: "field" }, [el("label", {}, "Quantidade"), el("input", { id: "buyQty", type: "number", value: "5", min: "1" })]),
    el("div", { class: "field" }, [el("label", {}, "Preço"), el("input", { id: "buyPrice", type: "number", value: "100", step: "0.01", min: "0" })]),
    el("div", { class: "field" }, [el("label", {}, "Corretagem/taxas"), el("input", { id: "buyFee", type: "number", value: "0", step: "0.01", min: "0" })]),
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        onclick: () => {
          const qty = parseInt(document.getElementById("buyQty").value, 10);
          const price = parseFloat(document.getElementById("buyPrice").value);
          const fee = parseFloat(document.getElementById("buyFee").value) || 0;
          if (!qty || qty <= 0 || Number.isNaN(price)) { showToast("Preencha quantidade e preço válidos.", true); return; }
          buyOnTicker(ticker, qty, price, fee);
          showToast(`Compra registrada: ${qty} @ ${fmtYen(price)}`);
          renderMain();
        },
      }, "COMPRAR"),
    ]),
  ]);

  // Venda
  const sellCard = el("div", { class: "card" }, [
    el("h4", {}, "Nova venda"),
    el("div", { class: "field" }, [el("label", {}, `Quantidade (máx ${ts.quantity})`), el("input", { id: "sellQty", type: "number", value: "1", min: "1", max: String(ts.quantity || 1) })]),
    el("div", { class: "field" }, [el("label", {}, "Preço"), el("input", { id: "sellPrice", type: "number", value: "100", step: "0.01", min: "0" })]),
    el("div", { class: "field" }, [el("label", {}, "Corretagem/taxas"), el("input", { id: "sellFee", type: "number", value: "0", step: "0.01", min: "0" })]),
    el("div", { style: "margin-top:14px;" }, [
      el("button", {
        disabled: ts.quantity === 0,
        onclick: () => {
          const qty = parseInt(document.getElementById("sellQty").value, 10);
          const price = parseFloat(document.getElementById("sellPrice").value);
          const fee = parseFloat(document.getElementById("sellFee").value) || 0;
          if (!qty || qty <= 0 || Number.isNaN(price)) { showToast("Preencha quantidade e preço válidos.", true); return; }
          if (qty > ts.quantity) { showToast("Quantidade excede a posição atual.", true); return; }
          sellOnTicker(ticker, qty, price, fee);
          showToast(`Venda registrada: ${qty} @ ${fmtYen(price)}`);
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

function renderSimulateTab(container, ticker) {
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Ciclos automáticos (comprar abaixo / vender acima do lote)"),
    el("div", { class: "row3" }, [
      el("div", { class: "field" }, [el("label", {}, "Qtd por compra"), el("input", { id: "cycBuyQty", type: "number", value: "5", min: "1" })]),
      el("div", { class: "field" }, [el("label", {}, "Preço de compra"), el("input", { id: "cycBuyPrice", type: "number", value: "125", step: "0.01" })]),
      el("div", { class: "field" }, [el("label", {}, "Nº de ciclos"), el("input", { id: "cycCount", type: "number", value: "10", min: "1" })]),
    ]),
    el("div", { class: "row3" }, [
      el("div", { class: "field" }, [el("label", {}, "Qtd por venda"), el("input", { id: "cycSellQty", type: "number", value: "5", min: "1" })]),
      el("div", { class: "field" }, [el("label", {}, "Preço de venda"), el("input", { id: "cycSellPrice", type: "number", value: "145", step: "0.01" })]),
    ]),
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
          const results = runCycles(ticker, buyQty, buyPrice, sellQty, sellPrice, cycles);
          showToast(`${results.length} ciclo(s) aplicado(s).`);
          renderMain();
        },
      }, "RODAR CICLOS"),
    ]),
  ]);
  container.appendChild(card);
}

/* ---------------- Aba: Objetivo de lucro ---------------- */

function renderTargetTab(container, ticker) {
  const snap = snapshotOf(ticker);
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Objetivo de lucro"),
    el("div", { class: "row2" }, [
      el("div", { class: "field" }, [el("label", {}, "Lucro desejado (¥)"), el("input", { id: "targetProfit", type: "number", value: "1000", step: "100" })]),
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
          resultEl.innerHTML = `Preço necessário nas <b>${snap.quantity}</b> ações restantes: <span style="color:var(--cyan);font-weight:700;">${fmtYen(target, 3)}</span>`;
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
          renderScenarioResult(table);
        },
      }, "SIMULAR CENÁRIO"),
    ]),
    el("div", { id: "scenarioResult" }),
  ]);
  container.appendChild(card);
}

function renderScenarioResult(table) {
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
      el("td", {}, fmtYen(r.price)), el("td", {}, fmtYen(r.positionValue)), el("td", {}, fmtYen(r.cash)),
      el("td", {}, fmtYen(r.patrimony)),
      el("td", { style: `color:${r.profit >= 0 ? "var(--mint)" : "var(--danger)"}` }, fmtYen(r.profit)),
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
  if (ts.transactions.length === 0) {
    container.appendChild(el("div", { class: "empty-state" }, "Nenhuma operação registrada ainda."));
    return;
  }
  const card = el("div", { class: "card" }, [
    el("h4", {}, "Histórico de operações"),
    el("div", { class: "table-scroll" }, el("table", {}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Nº"), el("th", {}, "Data"), el("th", {}, "Tipo"), el("th", {}, "Qtd"),
        el("th", {}, "Preço"), el("th", {}, "Caixa (fluxo)"), el("th", {}, "Qtd. posição"),
        el("th", {}, "Custo médio"), el("th", {}, "Res. fiscal"),
      ])),
      el("tbody", {}, [...ts.transactions].reverse().map((t) => el("tr", {}, [
        el("td", {}, String(t.id)),
        el("td", {}, t.date),
        el("td", {}, el("span", { class: `badge ${t.side === "BUY" ? "buy" : "sell"}` }, t.side === "BUY" ? "COMPRA" : "VENDA")),
        el("td", {}, String(t.quantity)),
        el("td", {}, fmtYen(t.unitPrice)),
        el("td", { style: t.cashFlow >= 0 ? "color:var(--mint)" : "color:var(--danger)" }, fmtYen(t.cashFlow)),
        el("td", {}, String(t.quantityAfter)),
        el("td", {}, fmtYen(t.avgCostAfter, 3)),
        el("td", {}, t.taxResult === null ? "—" : fmtYen(t.taxResult)),
      ]))),
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
